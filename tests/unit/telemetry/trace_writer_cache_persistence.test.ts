import { describe, expect, it, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceWriter, SCHEMA_SQL } from "../../../src/telemetry/trace_writer";
import type { SanitizedTrace } from "../../../src/telemetry/ring_buffer";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-cache-"));
  tempDirs.push(dir);
  return dir;
}

function makeTrace(id: string, overrides: Partial<SanitizedTrace> = {}): SanitizedTrace {
  return {
    reqId: id,
    createdAt: Date.now(),
    provider: "zen",
    model: "big-pickle",
    status: 200,
    durationMs: 120,
    ttftMs: 35,
    tokensPrompt: 10,
    tokensCompletion: 15,
    legs: {
      clientInbound: '{"prompt":"hello"}',
      upstreamOutbound: '{"prompt":"hello"}',
      upstreamInbound: '{"response":"world"}',
      clientOutbound: '{"response":"world"}',
    },
    ...overrides,
  };
}

/** Column names currently defined on request_traces, via PRAGMA. */
function columnNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(request_traces)")
    .all()
    .map((c) => c.name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("TraceWriter cache metric persistence", () => {
  it("round-trips tokensCached, tokensCacheWrite and cacheDiscount through SQLite", () => {
    const dbPath = join(makeTempDir(), "cache-roundtrip.db");
    const writer = new TraceWriter();
    writer.init(dbPath);

    writer.enqueue(
      makeTrace("req-cache-1", {
        tokensCached: 1234,
        tokensCacheWrite: 56,
        cacheDiscount: 0.5,
      })
    );
    writer.flush();
    writer.drainSync();

    const verify = new Database(dbPath, { readonly: true });
    const row = verify
      .query<
        {
          tokens_cached: number | null;
          tokens_cache_write: number | null;
          cache_discount: number | null;
        },
        [string]
      >(
        "SELECT tokens_cached, tokens_cache_write, cache_discount FROM request_traces WHERE req_id = ?"
      )
      .get("req-cache-1");
    verify.close();

    expect(row).not.toBeNull();
    expect(row!.tokens_cached).toBe(1234);
    expect(row!.tokens_cache_write).toBe(56);
    expect(row!.cache_discount).toBe(0.5);
  });

  it("migrates a legacy request_traces table by adding missing cache columns", () => {
    const dbPath = join(makeTempDir(), "legacy.db");

    // Simulate a pre-existing database created before cache metrics existed.
    // created_at must stay inside the retention window or pruneOldTraces()
    // (correctly) deletes the fixture row during init().
    const legacyCreatedAt = Date.now();
    const legacy = new Database(dbPath, { create: true });
    legacy.exec(`
      CREATE TABLE request_traces (
        req_id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        ttft_ms INTEGER,
        tokens_prompt INTEGER,
        tokens_completion INTEGER,
        client_inbound TEXT,
        upstream_outbound TEXT,
        upstream_inbound TEXT,
        client_outbound TEXT
      );
    `);
    legacy.run(
      `INSERT INTO request_traces (req_id, created_at, provider, model, status, duration_ms,
         tokens_prompt, tokens_completion) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["req-legacy-1", legacyCreatedAt, "zen", "big-pickle", 200, 10, 7, 9]
    );
    legacy.close();

    const writer = new TraceWriter();
    writer.init(dbPath);

    const db = writer.getDb();
    expect(db).not.toBeNull();
    const cols = columnNames(db!);
    expect(cols).toContain("tokens_cached");
    expect(cols).toContain("tokens_cache_write");
    expect(cols).toContain("cache_discount");

    // Pre-existing row must survive the migration and read back as NULL (unknown).
    const legacyRow = db!
      .query<
        {
          req_id: string;
          tokens_cached: number | null;
          tokens_cache_write: number | null;
          cache_discount: number | null;
        },
        [string]
      >(
        "SELECT req_id, tokens_cached, tokens_cache_write, cache_discount FROM request_traces WHERE req_id = ?"
      )
      .get("req-legacy-1");
    expect(legacyRow).not.toBeNull();
    expect(legacyRow!.req_id).toBe("req-legacy-1");
    expect(legacyRow!.tokens_cached).toBeNull();
    expect(legacyRow!.tokens_cache_write).toBeNull();
    expect(legacyRow!.cache_discount).toBeNull();

    // New writes must succeed against the migrated table.
    writer.enqueue(
      makeTrace("req-legacy-2", { tokensCached: 11, tokensCacheWrite: 22, cacheDiscount: 0.25 })
    );
    writer.flush();
    const newRow = db!
      .query<{ tokens_cached: number | null }, [string]>(
        "SELECT tokens_cached FROM request_traces WHERE req_id = ?"
      )
      .get("req-legacy-2");
    expect(newRow!.tokens_cached).toBe(11);

    writer.drainSync();
  });

  it("persists NULL (not 0) for a trace with no usage block", () => {
    const dbPath = join(makeTempDir(), "no-usage.db");
    const writer = new TraceWriter();
    writer.init(dbPath);

    const noUsage = makeTrace("req-nousage-1");
    expect(noUsage.tokensCached).toBeUndefined();
    expect(noUsage.tokensCacheWrite).toBeUndefined();
    expect(noUsage.cacheDiscount).toBeUndefined();

    writer.enqueue(noUsage);
    writer.flush();
    writer.drainSync();

    const verify = new Database(dbPath, { readonly: true });
    const row = verify
      .query<
        {
          tokens_cached: number | null;
          tokens_cache_write: number | null;
          cache_discount: number | null;
        },
        [string]
      >(
        "SELECT tokens_cached, tokens_cache_write, cache_discount FROM request_traces WHERE req_id = ?"
      )
      .get("req-nousage-1");
    verify.close();

    expect(row).not.toBeNull();
    expect(row!.tokens_cached).toBeNull();
    expect(row!.tokens_cache_write).toBeNull();
    expect(row!.cache_discount).toBeNull();
  });

  it("is idempotent when init() runs twice on the same database", () => {
    const dbPath = join(makeTempDir(), "idempotent.db");

    const first = new TraceWriter();
    first.init(dbPath);
    first.drainSync();

    const second = new TraceWriter();
    expect(() => second.init(dbPath)).not.toThrow();
    expect(second.getInitError()).toBeNull();

    const cols = columnNames(second.getDb()!);
    expect(cols.filter((c) => c === "tokens_cached")).toHaveLength(1);
    expect(cols.filter((c) => c === "tokens_cache_write")).toHaveLength(1);
    expect(cols.filter((c) => c === "cache_discount")).toHaveLength(1);

    second.drainSync();
  });

  it("SCHEMA_SQL declares all three cache columns for fresh databases", () => {
    expect(SCHEMA_SQL).toContain("tokens_cached");
    expect(SCHEMA_SQL).toContain("tokens_cache_write");
    expect(SCHEMA_SQL).toContain("cache_discount");
  });
});

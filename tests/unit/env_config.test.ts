import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocationConfigSchema } from "../../src/config/location";

describe("Location Config Example Validation", () => {
  it("ensures config/location.json.example exists and validates against LocationConfigSchema", () => {
    const examplePath = resolve(import.meta.dir, "../../config/location.json.example");
    expect(existsSync(examplePath)).toBe(true);

    const raw = readFileSync(examplePath, "utf-8");
    const json = JSON.parse(raw);
    const parsed = LocationConfigSchema.parse(json);

    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(7766);
    expect(parsed.tls_enabled).toBe(false);
    expect(parsed.testing?.test_port).toBe(7767);
  });
});

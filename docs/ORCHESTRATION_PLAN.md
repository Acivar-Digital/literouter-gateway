# LiteRouter Gateway — Public Showcase Orchestration Plan

> **Target Audience:** Small-model worker agents orchestrated via `/orchestrator` in `omp` (with `bd` / `aft` / `graphify` if enabled).  
> **Source Repo (Read-Only Golden Truth):** `/home/yapilwsl/arthityap/literouter`  
> **Target Repo (This Workspace):** `/home/yapilwsl/arthityap/literouter-gateway`

---

## 1. Mission & Objectives

Your job is to populate **`literouter-gateway`** from the private golden-truth repository **`literouter`** into a clean, self-contained, production-grade public repository that achieves three goals:

1. **Showcase what we built:** A fast, single-runtime-dependency (`zod`) LLM API gateway on Bun + TypeScript with declarative directive routing (`lr-<provider>-<wire>-<endpoint>-<nuance>`), single-pipe request pacing, reactive 429/402 cooldowns, session-sticky LRU KV-cache pinning, multi-tier Fusion fallback, and cross-wire OpenAI/Anthropic/Google translation.
2. **Help others avoid the pitfalls we solved:** Distill the real-world production fixes (KV-cache locality, avoiding self-DoS on upstream 429s, SSE in-band error handling, trailing-assistant turn normalization, thought-signature cross-model failover, HTTP/2 fallback) into clear, reusable engineering write-ups.
3. **Demonstrate engineering rigor to future employers:** Clean module boundaries, strict TypeScript (`tsc --noEmit`), 100% passing offline unit tests, and crisp technical documentation—with **zero** leaked secrets, internal infrastructure, or client-specific references.

---

## 2. Hard Security & Sanitization Rules (ZERO TOLERANCE)

Before copying or writing ANY file, every worker MUST obey these invariants:

### A. Never Touch or Copy These Paths from `literouter`
- `.env`, `.env.local`, `*.pem`, `certs/`
- `.beads/`, `.opencode/`, `.omp/`, `.claude/`, `.cursor/`, `.codex/`
- `eval/reports/` (contains real upstream workspace key URLs and live URLs)
- `CHANGELOG.md`, `AGENTS.md`, `CLAUDE.md`, `repomix.md`
- `docs/asus_vpn/`, `docs/handoff/`, `docs/GRAVEYARD/`
- `scripts/sync/`, `tests/test_results.md`, `data/`, `admin/`

### B. Banned Strings Gate (Must Return 0 Matches in `literouter-gateway`)
Before any phase is marked complete, run `rg` across the entire `literouter-gateway` repo. Every one of these patterns MUST return **0 hits**:
- Internal IPs / hostnames / users: `192\.168\.50\.`, `10\.32\.34\.`, `literouter\.lan`, `vps466a`, `yapilwsl`, `arthityap`
- Client / private project names: `baziforecast`, `chronomancer`, `orbz`, `orfl`, `OPENROUTER_BAZI`, `OPENROUTER_GEMINIFLASHLITE`
- Operational pool counts & real key URLs: `15.*key|key.*15|/15\b`, `openrouter\.ai/workspaces/`
- Real API key prefixes (outside synthetic test stubs like `sk-test-stub-` or `nvapi-key1`)

---

## 3. Phased Execution Plan (For `/orchestrator`)

Decompose the work into **4 sequential phases** (with parallel worker slices inside Phases 1–3). Do NOT proceed to the next phase until the current phase's verification gate passes.

### Phase 0: Project Skeleton & Sanitized Templates
**Goal:** Establish a runnable Bun + TypeScript workspace with example configs only.
- **Tasks:**
  1. Copy `package.json`, `tsconfig.json`, and `bunfig.toml` from `/home/yapilwsl/arthityap/literouter` (remove any scripts referencing `scripts/sync/`, `admin/`, or `doctor_full.ts` if not exported).
  2. Create sanitized example configs:
     - `.env.example` (placeholder keys only, e.g., `OPENROUTER_API_KEYS=sk-or-v1-example1,sk-or-v1-example2`)
     - `config/location.json.example` (`"host": "127.0.0.1"`, `"port": 7766`, `"tls_enabled": false`)
     - `config/providers.example.json` (copied from `config/providers.json` with any private LAN URLs like `192.168.50.11` replaced by `127.0.0.1` and private `orbz`/`orfl` entries removed)
     - `config/fusion.example.json` (generic multi-tier fallback example without client-specific presets)
- **Verify:** `bun install` succeeds cleanly; `rg` banned-strings check returns 0 hits.

### Phase 1: Core Gateway Engine (`src/`)
**Goal:** Export the clean v4.1 gateway source tree with zero operational coupling.
- **Tasks:**
  1. Copy `src/` from `/home/yapilwsl/arthityap/literouter/src/`.
  2. **Surgical scrub:** In `src/config/keys.ts`, remove client-specific provider entries (`orbz: "OPENROUTER_BAZI_API_KEYS"`, `orfl: "OPENROUTER_GEMINIFLASHLITE_KEYS"`). Check `src/` for any remaining references to `orbz`, `orfl`, `baziforecast`, or `chronomancer`.
  3. Ensure `src/` compiles cleanly against `tsconfig.json` and `package.json`.
- **Verify:**
  - `bun run typecheck` (`tsc --noEmit`) exits `0` with zero errors.
  - `rg` banned-strings check on `src/` returns `0` hits.

### Phase 2: Offline Unit Test Suite (`tests/`)
**Goal:** Provide a fast, reproducible, 100% offline unit test suite using mock stubs.
- **Tasks:**
  1. Copy generic unit tests from `literouter/tests/unit/` and `literouter/tests/handlers/` (e.g., `network/`, `stream/`, `engine/`, `telemetry/`, `core/`, `directive/`).
  2. **Exclude** client/ops-specific tests (e.g., `chronomancer_fusion.test.ts`, `test_chronomancer_resilience.py`, `test_results.md`, and any live-gateway integration tests that expect a running VPS).
  3. Add a lightweight `package.json` `"test": "bun test"` script.
- **Verify:**
  - `bun test` passes 100% offline with zero skipped/failing tests.
  - `rg` banned-strings check on `tests/` returns `0` hits.

### Phase 3: Engineering Showcase Docs (`docs/`)
**Goal:** Document the architecture and hard-won production lessons for peers and future employers.
Write three focused Markdown documents in `docs/` (using generic `N`-key / `127.0.0.1` examples):
1. **`docs/architecture.md`**:
   - Request lifecycle (`src/index.ts` → `v4.1` router → `src/engine/dispatch.ts` → transformers → `fetcher.ts`).
   - Declarative directive grammar (`lr-<provider>-<wire>-<endpoint>-<nuance>`).
   - Single-pipe `RequestPacer` vs. reactive `CooldownManager` and multi-tier `FusionEngine`.
   - Include a Mermaid flowchart of the dispatch + fallback pipeline.
2. **`docs/lessons-learned.md`** *(Helping others avoid the fixes we had)*:
   - **KV-Cache Locality via Session-Sticky LRU Pinning:** Why stateless round-robin destroys prompt-cache hit rates, how to resolve session IDs from headers/body (`session_id`, `prompt_cache_key`) with strict character sanitization, and true-LRU eviction (`delete`-then-`set`).
   - **Selective Quota Quarantine vs. Self-DoS:** Why generic upstream `429`s must rotate keys *without* benching accounts, while verified quota exhaustion (`402` / daily-free-limit `429` confirmed via single-flight debounced probe) should conserve keys.
   - **SSE Mid-Stream Error Forwarding:** Why upstream in-band errors arriving after content deltas cannot be retried once HTTP 200 is committed, and how to surface them cleanly without corrupting streams.
   - **Trailing-Assistant Prefill Normalization:** Why some providers hang on trailing `assistant` turns and how `ensureTerminalUserTurn` prevents silent timeouts.
   - **Cross-Model Thought-Signature Failover:** Caching tool-call thought signatures (`1h` TTL) and injecting sentinel bypasses when failing over across heterogeneous providers.
   - **HTTP/2 Outbound with Clean HTTP/1.1 Fallback:** Guarding TTFT while falling back cleanly on H2 transport errors.
3. **`docs/eval-harness.md`**:
   - Explain the native Bun evaluation architecture (Speed TTFT/throughput, 5-stage Agentic Coding, 5-stage Web DOM/A11y) and why running natively in <60s beats heavyweight Docker/Chromium harnesses for rapid model triage.
- **Verify:** All docs reviewed for clarity, accuracy against `src/`, and `0` banned-string hits.

### Phase 4: Portfolio `README.md` & Final Red-Team Gate
**Goal:** Ship a polished front door and prove the repo is 100% clean.
- **Tasks:**
  1. Write a crisp, recruiter- and developer-ready `README.md` covering:
     - Project summary & key engineering highlights
     - Mermaid architecture diagram
     - Quickstart (`bun install`, copy `.env.example` & `config/*.example.json`, `bun run start`, `bun test`)
     - Links to `docs/architecture.md`, `docs/lessons-learned.md`, and `docs/eval-harness.md`
  2. Run the **Final Red-Team Gate** across the entire `literouter-gateway` repo:
     ```bash
     bun run typecheck && bun test
     rg -n '(192\.168\.50\.|10\.32\.34\.|literouter\.lan|vps466a|yapilwsl|arthityap|baziforecast|chronomancer|orbz|orfl|OPENROUTER_BAZI|OPENROUTER_GEMINIFLASHLITE|openrouter\.ai/workspaces|\b15\b.*key|key.*\b15\b)' .
     ```
  3. Confirm `git status` shows no untracked `.env*` or private artifacts before committing and pushing.

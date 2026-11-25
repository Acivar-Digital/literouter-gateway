# Evaluation Harness — Native Bun 3-Pillar Architecture

The evaluation harness is a **native Bun + TypeScript** runner that triages any
onboarded model across three independent pillars. It runs in well under a minute
for a single model because it is just `bun` executing TypeScript against the
gateway over the wire — no Docker images to pull, no Chromium to boot, no
language-runtime matrix to provision.

The three pillars are:

1. **Speed & Throughput** — TTFT, total duration, tokens, tokens/sec.
2. **Coding / Agentic** — a 5-stage capability ladder over the chat or responses
   wire.
3. **Web DOM / A11y** — a 5-stage vision-language frontend ladder.

A master orchestrator runs the pillars, then synthesizes a Markdown report card
that recommends an architectural role for the model.

---

## 1. Why Native Bun (and not Docker/Chromium)

- **Startup cost dominates real triage.** Pulling a container image and booting a
  headless browser per run costs more wall-clock than the inference calls
  themselves. Native Bun starts in milliseconds, so the harness spends its budget
  on the model, not on infrastructure.
- **One runtime, one dependency surface.** The harness is TypeScript executed by
  Bun; the only "browser" it needs for the Web pillar is **static analysis of the
  generated DOM/HTML string**, not a live Chromium render. Structural, responsive,
  state, hygiene, and accessibility checks are all verifiable from the emitted
  markup and source, so a real browser is unnecessary for scoring.
- **Direct wire access.** Each stage calls the gateway (default loopback) over
  the same OpenAI/Anthropic wire the gateway serves, so the harness exercises the
  real routing/transform/fetch path rather than a reimplementation.
- **Fast enough to gate.** A full single-model sweep finishing in seconds makes it
  practical to run the harness as a pre-merge or pre-promotion gate, not a
  once-a-day batch.

---

## 2. Master Orchestrator

The orchestrator (`eval/eval.ts`) coordinates the three suites and synthesizes
the report card. Responsibilities:

- **Suite selection.** `--suites speed,code,web` runs any subset; per-suite flags
  (`--stage`, `--continue`, `--runs`) are validated by a strict arg parser
  (`validateStrictEvalArgs` / `extractPositionalAndNamed` in
  `eval/validate_cli.ts`) so a typo fails loudly instead of silently doing nothing.
- **Wire directive derivation.** `deriveWireDirectiveKeys` produces the
  chat-completions and responses directive keys for the target model so both wire
  dialects can be exercised; `getDefaultGatewayBaseUrl` resolves the loopback
  gateway.
- **Master-secret forwarding.** If a gateway auth key is configured, the
  orchestrator wraps `globalThis.fetch` to attach it (`x-literouter-key` /
  `x-auth-key`) so every stage's calls are authorized without per-stage plumbing.
- **Role synthesis.** Results roll up into a `UnifiedRoleRecommendation`
  (`Orchestrator` / `General Coder` / `Explorer` / `Rejected`) plus the best wire
  per role, written to a sanitized per-model report file.

---

## 3. Pillar 1 — Speed & Throughput (`eval/speed.ts`)

`runSpeedBenchmark` issues one or more generation runs per model and records a
`BenchResult` per run:

- `ttftMs` — time to first token.
- `totalDurationMs` — full generation wall-clock.
- `thinkingTokens` / `contentTokens` / `totalTokens` — token accounting.
- `speedTokPerSec` — generation throughput.
- `chunkCount` / `buffered` — streaming consistency (a buffered, non-streaming
  response is flagged).

Runs shorter than `MIN_OBSERVABLE_GENERATION_MS` are treated as unmeasurable
(timer jitter dominates). Per-model runs are aggregated into a `ModelAggregate`
with `avgTtftMs` / `minTtftMs` / `maxTtftMs`, `avgDurationMs`,
`avgTotalTokens`, and `avgSpeedTokPerSec`, so a single noisy run does not decide
the verdict.

---

## 4. Pillar 2 — Coding / Agentic (`eval/code.ts`, `eval/stages/`)

`runCodeEvaluation` runs a fixed 5-stage ladder, once per wire dialect
(`stages/` for chat completions, `stages_rs/` for the responses API). Each stage
returns a `StageResult`; `--stage N` runs one stage and `--continue` resumes a
partial run.

| Stage | File | What it proves |
|-------|------|----------------|
| 1 — Wire & Context Hydration | `stages/stage1_wire.ts` | Single- and multi-tool structured invocation with no XML/template leaks; long-context (12k+ token) hydration. |
| 2 — Type Safety & Reflection | `stages/stage2_pydantic.ts` | Strict nested-schema validation (enums, typed lists) and self-correction after a validation-error feedback loop. |
| 3 — Agentic Loop Durability | `stages/stage3_agentic.ts` | Multi-turn tool execution + observation ingestion, error recovery under tool failure (e.g. permission denied), and a streaming TTFT sub-benchmark. |
| 4 — Surgical Patch Fidelity | `stages/stage4_patch.ts` | Byte-exact `str_replace` of a 4-line block in a nested scope with zero line/offset drift. |
| 5 — Injection Resilience | `stages/stage5_security.ts` | Reading a third-party README carrying an indirect prompt-injection payload; the model must **not** emit the hijacked tool call and should neutralize the attempt. |

The summary (`CodeEvalSummary`) records the wire, directive key, gateway URL,
per-stage results, and an `allPassed` flag; an `unsupportedWire` marker lets the
orchestrator skip a dialect a model cannot serve.

---

## 5. Pillar 3 — Web DOM / A11y (`eval/web.ts`, `eval/stages_web/`)

`runWebEvaluation` runs a 5-stage vision-language frontend ladder against a
mockup (a bundled default dashboard image, or `--image`). Scoring is **static
analysis of the emitted markup/source** — no live browser required.

| Stage | File | What it proves |
|-------|------|----------------|
| 1 — Structural Fidelity | `stages_web/stage1_structure.ts` | Semantic landmarks (`<header>/<nav>/<main>/<aside>/<footer>`), Grid/Flexbox primitives, a 3-column card grid without absolute-position overlap hacks. |
| 2 — Responsive Scaling | `stages_web/stage2_responsive.ts` | Breakpoint modifiers (`sm:`/`md:`/`lg:`/`xl:` or media queries), mobile stacking, and absence of rigid fixed widths / horizontal overflow. |
| 3 — Interactive State | `stages_web/stage3_state.ts` | Real state (`useState`/`useReducer`), controlled inputs (`value`+`onChange`), real submit handlers (not no-op `() => {}`), and toggles for modals/spinners/errors. |
| 4 — Hygiene & Anti-Hallucination | `stages_web/stage4_hygiene.ts` | Flags lazy placeholders (`TODO`, `...`, "chart goes here"), hallucinated third-party imports outside the allowed set, and dangerous patterns (`dangerouslySetInnerHTML`, `javascript:` URIs). |
| 5 — Accessibility (A11y) | `stages_web/stage5_a11y.ts` | Flags `<div onClick>`/`<span onClick>` lacking `role`/`tabIndex`, `<img>` missing `alt`, and form controls without an associated `<label>`/`aria-label`/`aria-labelledby`. |

Fixtures (`stages_web/fixtures.ts`) provide SVG mockups (dashboard, pricing
table, auth-modal error) and `svgToDataUri`, so the image-under-test is
deterministic and self-contained.

---

## 6. Output

Each pillar returns typed results (`SpeedBenchmarkResult`, `CodeEvalSummary`,
`WebEvalResult`); the orchestrator folds them into an executive report card with
the recommended role and best wire per role, persisted per sanitized model name.
Because the whole pipeline is native Bun over the gateway wire, the same harness
runs unchanged in CI, on a laptop, or against a remote gateway base URL — only
`getDefaultGatewayBaseUrl` and the directive keys change.
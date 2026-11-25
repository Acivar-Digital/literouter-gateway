/**
 * Test-only config bootstrap.
 *
 * The public showcase repo ships `config/*.example.json` templates only — never
 * real `config/*.json` (those hold operational values in the private source
 * repo). Several unit tests exercise the real config loaders
 * (`loadLocationConfig`, `initProviderRegistry`, fusion config), which resolve
 * `config/<name>.json` at fixed paths and fail loudly when it is absent.
 *
 * This preload materializes each real config from its `.example` template when
 * missing, so the offline suite runs against the shipped example values
 * (generic `127.0.0.1` / `N`-key stubs) without mutating the repo on disk
 * beyond creating the gitignored real configs. Registered via bunfig.toml
 * `[test] preload`, after `preload.ts` (air-gap + key sanitizer).
 */
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const configDir = resolve(import.meta.dir, "../config");

const EXAMPLE_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  location: ["location.json.example", "location.example.json"],
  providers: ["providers.json.example", "providers.example.json"],
  fusion: ["fusion.json.example", "fusion.example.json"],
};

for (const [name, candidates] of Object.entries(EXAMPLE_CANDIDATES)) {
  const real = resolve(configDir, `${name}.json`);
  if (existsSync(real)) continue;
  for (const candidate of candidates) {
    const example = resolve(configDir, candidate);
    if (existsSync(example)) {
      copyFileSync(example, real);
      break;
    }
  }
}
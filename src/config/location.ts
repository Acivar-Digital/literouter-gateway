import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const LocationTestingConfigSchema = z.object({
  test_port: z.number().int().min(1).max(65535).default(7767),
  test_base_url: z.string().min(1).optional(),
});

export const LocationConfigSchema = z.object({
  profile: z.string().min(1).optional(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls_enabled: z.boolean(),
  base_url: z.string().min(1).optional(),
  parent_dir: z.string().min(1).optional(),
  working_folder: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  testing: LocationTestingConfigSchema.optional(),
});

export type LocationConfig = z.infer<typeof LocationConfigSchema>;

export function loadLocationConfig(filePath?: string): LocationConfig {
  const projectRoot = resolve(import.meta.dir, "../..");
  const targetPath = resolve(projectRoot, filePath ?? "config/location.json");

  if (!existsSync(targetPath)) {
    throw new Error(
      "[FATAL] Missing or invalid config/location.json. Required fields: host (string), port (int), tls_enabled (boolean)."
    );
  }

  try {
    const raw = readFileSync(targetPath, "utf-8");
    const json = JSON.parse(raw);
    return LocationConfigSchema.parse(json);
  } catch (err) {
    throw new Error(
      `[FATAL] Missing or invalid ${targetPath}. Required fields: host (string), port (int), tls_enabled (boolean).`,
      { cause: err }
    );
  }
}

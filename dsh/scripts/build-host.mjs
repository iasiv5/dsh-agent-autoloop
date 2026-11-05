// Build the host half: bundle the plugin + shared kernel into lib/host.js, then carry the four files the projection
// fingerprint hashes (kernel/evolve.ts, kernel/schema.sql, kernel/credentials.ts, hub.ts) next to the bundle so the
// running plugin reads the same bytes as the standalone checkout — same fingerprint, one projection format, and
// schema.sql present at the path createHub reads it from.
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/host.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  write: false,
  minify: false,
  external: ["@deepseek-ai/dsh-llm"],
});

await mkdir("lib", { recursive: true });
await writeFile("lib/host.js", result.outputFiles[0].text, "utf8");
await mkdir("kernel", { recursive: true });
await copyFile("../kernel/evolve.ts", "kernel/evolve.ts", 0);
await copyFile("../kernel/schema.sql", "kernel/schema.sql", 0);
await copyFile("../kernel/credentials.ts", "kernel/credentials.ts", 0);
await copyFile("../host/hub.ts", "lib/hub.ts", 0);
console.log("wrote lib/host.js + fingerprint inputs");

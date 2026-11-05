// Build the dashboard's browser bundle the way the host's module table expects: the emitted CJS body wrapped in a
// __ModuleLoader__.load call whose factory receives the module-table require, with react kept external so the host's
// own React copy is used at runtime (same recipe as the installed plugins).
import { mkdir, writeFile } from "node:fs/promises";
import esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/client.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  write: false,
  minify: false,
  external: ["react"],
});

const body = result.outputFiles[0].text;
const output =
  "window.__ModuleLoader__.load({\n" +
  '\tid: "@iasiv5/dsh-agent-autoloop",\n' +
  "\tfactory: (require) => {\n" +
  "\t\tvar module = { exports: {} };\n" +
  "\t\tvar exports = module.exports;\n" +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n' +
  body +
  "\n\t\treturn module.exports;\n" +
  "\t}\n" +
  "});\n";

await mkdir("lib", { recursive: true });
await writeFile("lib/client.js", output, "utf8");
console.log("wrote lib/client.js");

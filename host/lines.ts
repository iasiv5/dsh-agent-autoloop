// Lines as ACP, MCP and lark-cli frame them: ended by a newline and nothing else. readline also ends one at U+2028 and
// U+2029, which JSON leaves as they are inside a string, so it cuts a message in two.
import type { Readable } from "node:stream";

export function eachLine(input: Readable, onLine: (line: string) => void, onEnd = () => {}) {
  let rest = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop()!;
    for (const line of lines) onLine(line);
  });
  input.on("end", () => {
    if (rest) onLine(rest);
    onEnd();
  });
}

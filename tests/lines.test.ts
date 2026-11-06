// Lines as ACP, MCP and lark-cli frame them. Failure modes: a line is cut at U+2028 or U+2029, which JSON leaves as they
// are inside a string; a character that two reads split comes out garbled; a line split by two reads comes out as two; a
// last line with no newline is lost; the end isn't told, or is told before the last line.
import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { eachLine } from "../host/lines.ts";

async function read(...chunks: Buffer[]) {
  const input = new PassThrough();
  const seen: string[] = [];
  eachLine(
    input,
    (line) => seen.push(line),
    () => seen.push("<end>"),
  );
  for (const chunk of chunks) input.write(chunk);
  input.end();
  await once(input, "close");
  return seen;
}

test("only a newline ends a line", async () => {
  const text = '{"text":"第一行 第二行 第三行\r"}\n\n{"a":1}\n';
  assert.deepEqual(await read(Buffer.from(text)), ['{"text":"第一行 第二行 第三行\r"}', "", '{"a":1}', "<end>"]);
});

test("a line and a character that reads split come back whole", async () => {
  const bytes = Buffer.from("第一行 \n第二行\n");
  const parts = [...bytes].map((byte) => Buffer.from([byte]));
  assert.deepEqual(await read(...parts), ["第一行 ", "第二行", "<end>"]);
});

test("a last line with no newline still comes, before the end", async () => {
  assert.deepEqual(await read(Buffer.from("一\n二")), ["一", "二", "<end>"]);
  assert.deepEqual(await read(), ["<end>"]);
});

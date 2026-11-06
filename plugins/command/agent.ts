// Anything with a print mode: its command line in rules.json, its last message on stdout. A script is an agent too, and
// a plain command needn't take the prompt at all: it finds what it needs through the environment (AGENT_AUTOLOOP_CONTEXT).
import { tail, type Adapter } from "../../worker/agents.ts";

const PLACEHOLDER = /\{(prompt|model|effort|cwd|context)\}/g;

export default {
  // One pass, with a function: the prompt is what someone asked for, so a {cwd} or a $& inside those words is not a
  // placeholder of its own and must arrive as written.
  command: (turn) => {
    const values: Record<string, string> = {
      prompt: turn.prompt,
      model: turn.model ?? "",
      effort: turn.effort ?? "",
      cwd: turn.cwd,
      context: turn.contextFile,
    };
    return (turn.command ?? []).map((part) => part.replace(PLACEHOLDER, (_, name: string) => values[name]));
  },
  read(stdout, code, stderr) {
    if (code === null) return {};
    if (code !== 0) return { error: `退出码 ${code}：${tail(stderr || stdout) || "没留下原因"}` };
    return { text: stdout };
  },
} satisfies Adapter;

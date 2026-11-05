// The plugin's own config, private to its data dir. Unknown fields are rejected so a typo can't silently do nothing.
// `rules` is the trusted orchestration configuration (validated with the same parser as the standalone rules.json);
// `worker` is the worker identity the bridge claims under; `capacity` bounds concurrent agent sessions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRules as checkRules } from "../../protocol/rules.ts";
import type { Rules } from "../../kernel/rules.ts";

export type AutoloopConfig = {
  capacity: number;
  worker: string;
  rules?: Rules;
  publicUrl?: string;
  approvalPolicy?: "ask" | "never";
};
const FIELDS = ["capacity", "worker", "rules", "publicUrl", "approvalPolicy"];
const DEFAULTS = { capacity: 2, worker: "dsh" };

export function readConfig(dir: string): AutoloopConfig {
  let given: unknown = {};
  try {
    given = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`config.json 读不了：${(error as Error).message}`);
    }
  }
  if (typeof given !== "object" || given === null || Array.isArray(given)) throw new Error("config.json 要是一个对象");
  const unknown = Object.keys(given).find((name) => !FIELDS.includes(name));
  if (unknown) throw new Error(`config.json 有不认识的字段 ${unknown}，只能是 ${FIELDS.join("、")}`);
  const given_ = given as Record<string, unknown>;
  const capacity = given_.capacity ?? DEFAULTS.capacity;
  if (typeof capacity !== "number" || !Number.isInteger(capacity) || capacity < 1 || capacity > 16) {
    throw new Error("capacity 要是 1 到 16 的整数");
  }
  const worker = given_.worker ?? DEFAULTS.worker;
  if (typeof worker !== "string" || !/^[a-z][a-z0-9-]*$/.test(worker)) {
    throw new Error("worker 要是小写字母开头的标识符");
  }
  const publicUrl = given_.publicUrl;
  if (publicUrl !== undefined && typeof publicUrl !== "string") throw new Error("publicUrl 要是文字");
  const approvalPolicy = given_.approvalPolicy;
  if (approvalPolicy !== undefined && approvalPolicy !== "ask" && approvalPolicy !== "never") {
    throw new Error('approvalPolicy 只能是 "ask" 或 "never"（缺省=宿主部署默认）');
  }
  let rules: Rules | undefined;
  if (given_.rules !== undefined) {
    try {
      rules = checkRules(JSON.stringify(given_.rules), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch (error) {
      throw new Error(`config.json 的 rules 不合格：${(error as Error).message.split("\n")[0]}`);
    }
  }
  return { capacity, worker, rules, publicUrl: publicUrl as string | undefined, approvalPolicy };
}

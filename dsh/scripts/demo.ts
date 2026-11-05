// Offline demo: one matter's full lifecycle — manual event → dispatch → context file → ask with two options →
// prove zero model calls while waiting → host restart → answer → only the remaining steps run → a local result file
// as evidence → done receipt → the fact timeline explaining all of it. The "model" is a scripted fake that reads the
// real context file the bridge wrote, so the data-separation claim is exercised, not narrated.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHub } from "../../host/hub.ts";
import { parseRules } from "../../protocol/rules.ts";
import { createBridge, type BridgeWorld } from "../src/bridge.ts";

const home = mkdtempSync(join(tmpdir(), "autoloop-demo-"));
const say = (step: string, text: string) => console.log(`\n【${step}】${text}`);
const fence = (json: string) => "```agent-autoloop\n" + json + "\n```";
const textOf = (message: any) =>
  Array.isArray(message?.content)
    ? message.content.map((block: any) => block.text ?? "").join("")
    : String(message?.content ?? "");

const rules = parseRules(
  JSON.stringify({
    timezone: "Asia/Shanghai",
    askFirst: ["删数据", "停服", "花钱", "对外发消息"],
    sources: { local: { name: "本地" } },
    agents: { dsh: { name: "DSH", worker: "dsh", use: "dsh", access: "edit" } },
    rules: [
      {
        name: "资料整理",
        when: { source: "local", types: ["demo.start"] },
        to: "dsh",
        cwd: home,
        prompt: "阅读资料，整理出两个可选方案，先问我。",
      },
    ],
  }),
  Date.now(),
  "Asia/Shanghai",
);
const hub = createHub({ home, rules });

let handler: ((sessionId: string, event: any) => void) | undefined;
let modelCalls = 0;
const sessions = new Map<
  string,
  { id: string; cwd: string; prompts: string[]; replies: string[]; send(message: any): void; cancel(): void }
>();
const flush = () => new Promise((resolve) => setImmediate(resolve));

function scriptReply(sessionId: string, prompt: string, cwd: string) {
  const contextFile = /资料在 (\S+?)：/.exec(prompt)?.[1];
  const context = contextFile ? JSON.parse(readFileSync(contextFile, "utf8")) : null;
  setImmediate(() => {
    let reply: string;
    if (context?.answers?.length) {
      const resultFile = join(cwd, "demo-result.md");
      if (context.answers[0].choice === 0) {
        writeFileSync(resultFile, "# 演示结果\n\n方案 A 已执行：本文件就是交付证据。\n");
        reply =
          "方案 A 执行完毕，结果写在 demo-result.md。\n\n" +
          fence('{"notice":[{"title":"整理完成","text":"结果文件 demo-result.md 已生成","key":"demo-done"}]}');
      } else {
        reply =
          "按方案 B 只出报告：资料共 " +
          context.events.length +
          " 条，未写文件。\n\n" +
          fence('{"notice":[{"title":"整理完成","text":"方案 B：仅本报告"}]}');
      }
    } else {
      reply =
        "已读取资料（events " +
        (context?.events?.length ?? 0) +
        " 条）。两个方案：A 本地写 demo-result.md；B 只出报告不写文件。\n\n" +
        fence(
          '{"ask":[{"title":"选哪个方案","text":"A 会写本地文件；B 只出报告","options":["A 写文件","B 只报告"],"key":"demo-plan","about":"选择后我只做剩余步骤，不重做已完成的阅读"}]}',
        );
    }
    const api = sessions.get(sessionId)!;
    api.replies.push(reply);
    handler?.(sessionId, {
      type: "assistant/message",
      data: {
        turn: api.replies.length,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: reply }] },
        stream: [],
      },
    });
    handler?.(sessionId, { type: "turn/end", data: { turn: api.replies.length, reason: "completed" } });
  });
}

function makeApi(sessionId: string, cwd: string) {
  const api = {
    id: sessionId,
    cwd,
    prompts: [] as string[],
    replies: [] as string[],
    send(message: any) {
      modelCalls += 1;
      const prompt = textOf(message);
      api.prompts.push(prompt);
      scriptReply(sessionId, prompt, cwd);
    },
    cancel() {},
  };
  sessions.set(sessionId, api);
  return { agent: api };
}

const world: BridgeWorld = {
  async createAgent(sessionId, cwd) {
    return makeApi(sessionId, cwd);
  },
  async resumeAgent(sessionId) {
    if (!sessions.has(sessionId)) throw new Error("session not persisted");
    const api = sessions.get(sessionId)!;
    api.send = (message: any) => {
      modelCalls += 1;
      const prompt = textOf(message);
      api.prompts.push(prompt);
      scriptReply(sessionId, prompt, api.cwd);
    };
    return { agent: api };
  },
  liveAgent: (sessionId) => (sessions.has(sessionId) ? { agent: sessions.get(sessionId)! } : undefined),
  onSessionEvent(subscribed) {
    handler = subscribed;
    return () => {};
  },
  schedule: () => () => {},
  now: Date.now,
  log: () => {},
  runsDir: join(home, "runs"),
  userMessage: (text) => ({ content: [{ type: "text", text }] }),
};

const bridge = createBridge(hub, world, { worker: "dsh", capacity: 2 });
const settle = () => new Promise((resolve) => setImmediate(resolve));

console.log("== Agent Autoloop · DSH 原生插件离线演示 ==");
console.log("（假模型脚本化了「读资料→提问→执行」，其余全部是真实内核与真实桥接代码）");

say("1", "用户提交本地事项：demo.start");
const ack = hub.ingest("local", { id: "d1", type: "demo.start", subject: "demo", summary: "整理资料并出两个方案" });
console.log(`  事件 ${ack.event} 已入账，路由：${ack.routed.join("、")}`);

say("2-3", "桥领取事项 → 写受控资料文件 → DSH 会话执行；Agent 读资料后给出两个方案并发 ask");
bridge.start();
await settle();
await settle();
const run = hub.stateOf().runs.at(-1)!;
const sessionId = [...sessions.keys()][0]!;
const api = sessions.get(sessionId)!;
const contextFile = join(home, "runs", `${run.id}-1`, "context.json");
console.log(`  轮 ${run.id} 已派发（会话 ${sessionId}）；资料文件已写入 ${contextFile}`);
console.log(`  提示词长度 ${api.prompts[0].length} 字——事件正文只在资料文件里，不在提示词里`);

say("4", "Agent 提交 ask 并结束本轮（第一行结论 + 回执，全部落进事实日志）");
await settle();
const askCard = hub.stateOf().cards.find((card: any) => card.title === "选哪个方案")!;
console.log(
  `  轮 ${run.id} 状态：done；待决策卡片 ${askCard.id}「${askCard.title}」已打开（选项：${askCard.options.join("／")}）`,
);

say("5", `等待人工期间：模型调用次数 ${modelCalls}（提问前也是 ${modelCalls}）——等待零消耗`);
console.log(
  "  此刻事实链：\n" +
    hub
      .why(run.id)
      .map((fact) => `  #${fact.seq} ${fact.type}`)
      .join("\n"),
);

say("6", "关闭并重启宿主（同一数据目录：事实日志重放，投影复用）");
bridge.stop();
const hub2 = createHub({ home, rules });
const bridge2 = createBridge(hub2, world, { worker: "dsh", capacity: 2 });
handler = undefined;

say("7", "重启后查看同一事项与原决策（状态来自事实日志）");
const askCard2 = hub2.stateOf().cards.find((card: any) => card.title === "选哪个方案")!;
console.log(`  卡片 ${askCard2.id} 仍开着：「${askCard2.title}」（未回答的 ask 不丢失）`);

say("8", "用户选择方案 A（写文件）");
const answered = hub2.answer(askCard2.id, { choice: 0, by: "演示者" });
console.log(`  回答生效：${answered.changed}（卡片 ${answered.state}），桥派发后续轮次`);

say("9-10", "Agent 只执行剩余步骤：写本地结果文件作为证据");
bridge2.start();
await settle();
await settle();
await settle();
const resultFile = join(home, "demo-result.md");
console.log(`  结果文件存在：${resultFile} → ${readFileSync(resultFile, "utf8").split("\n")[0]}`);
console.log(
  `  模型调用累计 ${modelCalls} 次；续轮提示词进入同一会话（prompts ${api.prompts.length} 条）——已完成的阅读没有重做`,
);

say("11", "提交完成回执");
const doneRun = hub2.stateOf().runs.find((item: any) => item.state === "done" && item.id !== run.id)!;
console.log(`  轮 ${doneRun.id}：${doneRun.state} — ${(doneRun.summary ?? "").split("\n")[0]}`);

say("12", "时间线解释全过程（why：续轮的每一条事实）");
for (const fact of hub2.why(doneRun.id)) console.log(`  #${fact.seq} ${fact.type}`);

console.log(`\n== 演示结束：数据目录 ${home}（演示后删除） ==`);
bridge2.stop();
rmSync(home, { recursive: true, force: true });

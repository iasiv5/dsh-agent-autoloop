// Failure cases this file guards: a claimed run that never reaches a session, a receipt that silently fails to apply,
// an answer starting a second execution in a different session, a failed run losing the events that arrived meanwhile,
// a turn-end error being taken as success, and a restart losing a claimed run's session intent.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHub } from "../host/hub.ts";
import { parseRules } from "../protocol/rules.ts";
import { createBridge, type BridgeWorld } from "../dsh/src/bridge.ts";

const RULES_TEXT = JSON.stringify({
  agents: { dsh: { name: "DSH", worker: "dsh", use: "dsh", access: "edit" } },
  sources: { local: { name: "本地" } },
  rules: [
    { name: "演示", when: { source: "local", types: ["demo.*"] }, to: "dsh", cwd: "/tmp", prompt: "按资料处理。" },
  ],
});

function setup() {
  const home = mkdtempSync(join(tmpdir(), "autoloop-bridge-"));
  const rules = parseRules(RULES_TEXT, Date.now(), "Asia/Shanghai");
  const hub = createHub({ home, rules });
  const sessions = new Map<string, { id: string; messages: string[]; send(message: any): void; cancel(): void }>();
  const created: string[] = [];
  const resumed: string[] = [];
  const resumeFailures = new Set<string>();
  let handler: ((sessionId: string, event: any) => void) | undefined;
  const timers: { ms: number; fn: () => void }[] = [];
  const sessionsApi = (sessionId: string) => {
    const api = {
      id: sessionId,
      messages: [] as string[],
      dispose() {},
      send(message: any) {
        api.messages.push(
          Array.isArray(message?.content)
            ? message.content.map((block: any) => block?.text ?? "").join("")
            : String(message?.content ?? ""),
        );
      },
      cancel() {},
    };
    sessions.set(sessionId, api);
    return api;
  };
  const createdOptions: { model?: string; effort?: string; provider?: string }[] = [];
  const world: BridgeWorld = {
    async createAgent(sessionId, cwd, options) {
      created.push(sessionId);
      createdOptions.push(options ?? {});
      assert.equal(cwd, "/tmp");
      sessions.set(sessionId, sessionsApi(sessionId));
      return { agent: sessions.get(sessionId)!, dispose() {} };
    },
    async resumeAgent(sessionId) {
      if (resumeFailures.has(sessionId)) throw new Error("session not persisted");
      resumed.push(sessionId);
      if (!sessions.has(sessionId)) sessions.set(sessionId, sessionsApi(sessionId));
      return { agent: sessions.get(sessionId)!, dispose() {} };
    },
    liveAgent(sessionId) {
      return sessions.has(sessionId) ? { agent: sessions.get(sessionId)!, dispose() {} } : undefined;
    },
    onSessionEvent(subscribed) {
      handler = subscribed;
      return () => {
        handler = undefined;
      };
    },
    schedule(ms: number, fn: () => void) {
      timers.push({ ms, fn });
      return () => {
        timers.splice(
          timers.findIndex((timer) => timer.fn === fn),
          1,
        );
      };
    },
    now: Date.now,
    log: () => {},
    runsDir: join(home, "runs"),
    userMessage: (text) => ({ content: [{ type: "text", text }] }),
  };
  const bridge = createBridge(hub, world, { worker: "dsh", capacity: 2, provider: "zai-coding-cn" });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return {
    hub,
    bridge,
    createdOptions,
    sessions,
    created,
    resumed,
    resumeFailures,
    home,
    timers,
    flush,
    emit(sessionId: string, event: any) {
      handler!(sessionId, event);
    },
    async complete(sessionId: string, turn: number, text: string | undefined, reason: any = "completed") {
      if (text !== undefined) {
        this.emit(sessionId, {
          type: "assistant/message",
          data: { turn, step: 1, message: { role: "assistant", content: [{ type: "text", text }] }, stream: [] },
        });
      }
      this.emit(sessionId, { type: "turn/end", data: { turn, reason } });
      await this.flush();
    },
    async dispatchAndWait() {
      this.bridge.dispatch();
      await this.flush();
      await this.flush();
      return this.bridge.held();
    },
    cleanup() {
      bridge.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

const receipt = (body: string) => `做完了\n\n\`\`\`agent-autoloop\n${body}\n\`\`\``;

test("a manual event runs a session, applies its receipt and opens the notice card", async () => {
  const s = setup();
  try {
    s.bridge.start();
    const ack = s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    assert.deepEqual(ack.routed, ["演示"]);
    const held = await s.dispatchAndWait();
    assert.equal(held.length, 1);
    assert.match(held[0].sessionId, /^agent-autoloop-r\d+a1$/);
    assert.ok(s.created.includes(held[0].sessionId));
    assert.ok(s.sessions.get(held[0].sessionId)!.messages[0].includes("按资料处理。"));
    assert.ok(
      existsSync(join(s.home, "runs", `${held[0].run}-1`, "context.json")),
      "context file written before dispatch",
    );
    await s.complete(held[0].sessionId, 1, receipt('{"notice":[{"title":"巡检完成","text":"一切正常","key":"done"}]}'));
    const state = s.hub.stateOf();
    assert.equal(state.totals.done, 1);
    const card = state.cards.find((item: any) => item.title === "巡检完成");
    assert.ok(card, "notice card opened");
    assert.equal(s.bridge.held().length, 0);
  } finally {
    assert.equal(s.createdOptions.at(-1)?.provider, "zai-coding-cn");
    s.cleanup();
  }
});

test("an answer continues the asking session instead of a new one", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const first = await s.dispatchAndWait();
    const session1 = first[0].sessionId;
    await s.complete(
      session1,
      1,
      receipt(
        '{"ask":[{"title":"怎么发货","text":"两种方式今天都能发出","options":["快递","自提"],"key":"ship","about":"发货方式"}]}',
      ),
    );
    const card = s.hub.stateOf().cards.find((item: any) => item.title === "怎么发货");
    assert.ok(card, "ask card open");
    const answered = s.hub.answer(card.id, { choice: 0, by: "本人" });
    assert.equal(answered.changed, true);
    const held = await s.dispatchAndWait();
    assert.equal(held.length, 1);
    assert.equal(held[0].sessionId, session1, "same session reused");
    assert.deepEqual(s.created, [session1], "no second agent created");
    assert.equal(s.sessions.get(session1)!.messages.length, 2, "follow-up prompt in the same session");
    await s.complete(session1, 2, "没事可做：已经发完货");
    assert.equal(s.hub.stateOf().totals.nothing, 1);
  } finally {
    s.cleanup();
  }
});

test("a failed turn goes back to queued and waits out its backoff with new events attached", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const first = await s.dispatchAndWait();
    await s.complete(first[0].sessionId, 1, "没跑成：临时故障");
    const queued = s.hub.stateOf().runs.find((run: any) => run.state === "queued");
    assert.ok(queued, "failed run queued for retry");
    assert.equal(queued.attempts, 1);
    assert.match(queued.error, /临时故障/);
    s.hub.ingest("local", { id: "e2", type: "demo.more", subject: "s1" });
    const held = await s.dispatchAndWait();
    assert.equal(held.length, 0, "not_before keeps it waiting");
  } finally {
    s.cleanup();
  }
});

test("a turn-end error is a failure, never a success", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const first = await s.dispatchAndWait();
    await s.complete(first[0].sessionId, 1, undefined, { kind: "error", error: { message: "模型不可用" } });
    const run = s.hub.stateOf().runs.find((item: any) => item.id === first[0].run)!;
    assert.equal(run.state, "queued");
    assert.equal(run.attempts, 1);
    assert.ok(run.error.length > 0);
  } finally {
    s.cleanup();
  }
});

test("an unreadable receipt is repaired in the same session without redoing work", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const first = await s.dispatchAndWait();
    // A receipt block that parses but carries an unknown field: the worker contract treats this as unreadable and
    // asks for a rewrite, while the first line's outcome stands and no control action applies.
    await s.complete(first[0].sessionId, 1, `做完了\n\n\`\`\`agent-autoloop\n{"bogus":true}\n\`\`\``);
    assert.equal(s.hub.stateOf().totals.done, 0, "nothing applied yet");
    assert.equal(s.bridge.held()[0].repairs, 1);
    assert.match(s.sessions.get(first[0].sessionId)!.messages.at(-1)!, /重写/);
    await s.complete(first[0].sessionId, 2, receipt('{"notice":[{"title":"好了","text":"已完成","key":"ok"}]}'));
    assert.equal(s.hub.stateOf().totals.done, 1);
    assert.equal(s.sessions.get(first[0].sessionId)!.messages.length, 2, "repair asked once, work never redone");
  } finally {
    s.cleanup();
  }
});

test("a restart takes over a claimed run through its recorded session", async () => {
  const s = setup();
  try {
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const job = s.hub.claimNext("dsh", "manual-claim");
    assert.ok(job, "claimed outside the bridge");
    s.hub.started(job.run, job.token, { session: "agent-autoloop-r1a1" });
    s.resumeFailures.add("other");
    s.bridge.start();
    await s.flush();
    const held = s.bridge.held();
    assert.equal(held.length, 1);
    assert.equal(held[0].sessionId, "agent-autoloop-r1a1");
    assert.deepEqual(s.resumed, ["agent-autoloop-r1a1"]);
    assert.match(s.sessions.get("agent-autoloop-r1a1")!.messages[0], /宿主重启/);
    await s.complete("agent-autoloop-r1a1", 1, receipt('{"notice":[{"title":"接上了","text":"已恢复","key":"back"}]}'));
    assert.equal(s.hub.stateOf().totals.done, 1);
  } finally {
    s.cleanup();
  }
});

test("the pause gate stops claiming and resuming the gate dispatches again", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.bridge.setPaused(true);
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const held = await s.dispatchAndWait();
    assert.equal(held.length, 0, "paused bridge claims nothing");
    s.bridge.setPaused(false);
    const heldAfter = await s.dispatchAndWait();
    assert.equal(heldAfter.length, 1, "unpausing dispatches");
  } finally {
    s.cleanup();
  }
});

test("an unload during a turn leaves no result; a disposed turn never finishes", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const first = await s.dispatchAndWait();
    s.emit(first[0].sessionId, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "aborted", reason: "disposed" } },
    });
    await s.flush();
    assert.equal(s.bridge.held().length, 0);
    const run = s.hub.stateOf().runs.find((item: any) => item.id === first[0].run)!;
    assert.equal(run.state, "claimed", "left claimed for the sweep to call unknown");
  } finally {
    s.cleanup();
  }
});

test("a dispatch arms a watchdog at the rule's timeout, and firing it fails the run instead of cancelling", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const held = await s.dispatchAndWait();
    const armed = s.timers.at(-1)!;
    assert.equal(armed.ms, 180 * 60_000, "default timeout is 180 minutes");
    armed.fn();
    await s.flush();
    await s.complete(held[0].sessionId, 1, undefined, { kind: "aborted", reason: "user" });
    const run = s.hub.stateOf().runs.find((item: any) => item.id === held[0].run)!;
    assert.equal(run.state, "queued", "timeout is a failure, so the kernel schedules a retry");
    assert.match(run.error, /超过 180 分钟/);
  } finally {
    s.cleanup();
  }
});

test("usage reported by assistant messages accumulates once and lands in the finished run", async () => {
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const held = await s.dispatchAndWait();
    s.emit(held[0].sessionId, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        stream: [],
        usage: { input: 10, output: 5 },
      },
    });
    s.emit(held[0].sessionId, {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 2,
        message: { role: "assistant", content: [] },
        stream: [],
        usage: { input: 10, output: 5 },
      },
    });
    await s.complete(held[0].sessionId, 1, receipt('{"notice":[{"title":"好","text":"了","key":"u"}]}'));
    const run = s.hub.stateOf().runs.find((item: any) => item.id === held[0].run)!;
    assert.deepEqual(run.usage, { input: 20, output: 10 });
  } finally {
    s.cleanup();
  }
});

test("an idle bridge still beats every minute, so a worker is never read as dead while its claims wait", () => {
  // Failure mode: with nothing held, the bridge armed only the next kernel deadline (possibly days away). The kernel
  // then reads the worker as offline, skips the lease check, and a claimed run from before a restart pins a slot forever.
  const s = setup();
  try {
    s.bridge.start();
    const armed = s.timers.at(-1)!;
    assert.ok(armed.ms <= 60_000, `idle beat is at most 60s, got ${armed.ms}ms`);
  } finally {
    s.cleanup();
  }
});

test("one matter costs a bounded number of claims: a commit never re-enters dispatch", async () => {
  // Failure mode: a claim commits a fact, the kernel calls onChange synchronously, and onChange dispatched again,
  // recursing until the stack gave out. One ingested matter must claim a handful of times at most.
  const s = setup();
  const hub = s.hub as unknown as { claimNext: (...args: unknown[]) => unknown };
  const kernelClaim = hub.claimNext.bind(s.hub);
  let claims = 0;
  hub.claimNext = (...args: unknown[]) => {
    claims += 1;
    assert.ok(claims <= 10, `claimNext re-entered ${claims} times`);
    return kernelClaim(...args);
  };
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    await s.flush();
    assert.ok(claims <= 3, `one matter claimed ${claims} times`);
  } finally {
    s.cleanup();
  }
});

test("every matter's first message opens with the Auto-Loop tag, so its session can be found in the sidebar", async () => {
  // The sidebar title is derived from the first input; without the tag an Auto-Loop session is indistinguishable.
  const s = setup();
  try {
    s.bridge.start();
    s.hub.ingest("local", { id: "e1", type: "demo.start", subject: "s1" });
    const held = await s.dispatchAndWait();
    const first = s.sessions.get(held[0].sessionId)!.messages[0];
    assert.ok(first.startsWith("【Auto-Loop】"), `first message opens with the tag, got: ${first.slice(0, 16)}`);
  } finally {
    s.cleanup();
  }
});

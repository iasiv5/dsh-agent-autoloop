// The native execution bridge: claimed kernel runs become DSH agent sessions, and their durable session turns become
// kernel facts. Session events arrive on the cordis 'session/event' feed; receipts reuse the standalone worker's
// contract (promptFor/readMessage/resultFrom) so a model's last message is read exactly as the HTTP worker would read
// it. Everything the host provides is narrowed behind BridgeWorld, so the whole loop runs against fakes in tests.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promptFor, readMessage, repairPrompt, resultFrom } from "../../worker/contract.ts";
import type { Job } from "../../protocol/job.ts";
import { addUsage, type Usage } from "../../protocol/validate.ts";
import type { Hub } from "../../host/hub.ts";

export type BridgeAgentHandle = {
  agent: {
    id: string;
    send(message: unknown, target?: string, wakeup?: boolean): unknown;
    cancel(cause?: string): unknown;
  };
  dispose(): Promise<void> | void;
};

export type SessionEventLike = { type: string; data: any };
export type BridgeOptions = { worker: string; capacity: number; provider?: string };
export type BridgeWorld = {
  /** Create a fresh agent bound to this session id; cwd comes from the rule. */
  createAgent(
    sessionId: string,
    cwd: string,
    options?: { model?: string; effort?: string; provider?: string },
  ): Promise<BridgeAgentHandle>;
  /** Open a persisted session for writing; rejects when the session was never materialized or is already live. */
  resumeAgent(sessionId: string): Promise<BridgeAgentHandle>;
  /** The live handle for a session this bridge still owns, if any. */
  liveAgent(sessionId: string): BridgeAgentHandle | undefined;
  /** Subscribe to every appended session event; returns the disposer. */
  onSessionEvent(handler: (sessionId: string, event: SessionEventLike) => void): () => void;
  /** One-shot timer; returns the disposer. The bridge arms the single earliest kernel deadline through this. */
  schedule(ms: number, fn: () => void): () => void;
  now(): number;
  log(line: string): void;
  /** Where per-run context files live (inside the plugin's data dir). */
  runsDir: string;
  /** Build the user-role message carrying the prompt. */
  userMessage(text: string): unknown;
};

type Entry = {
  job: Job;
  sessionId: string;
  handle: BridgeAgentHandle | undefined;
  turn: number | undefined;
  lastText: string | undefined;
  usage: Usage | undefined;
  watchdog: (() => void) | undefined;
  repairs: number;
  settling: boolean;
  timedOut: boolean | undefined;
};

const textOf = (message: any): string => {
  const blocks = message?.content;
  return Array.isArray(blocks)
    ? blocks
        .filter((block: any) => block?.type === "text")
        .map((block: any) => block.text)
        .join("")
    : typeof blocks === "string"
      ? blocks
      : "";
};
const claimId = () => `dsh-${Math.random().toString(36).slice(2)}`;
const timeoutMs = (job: Job) => Math.max(1, job.agent.timeout ?? 180) * 60_000;
/** Turn-end reasons are tagged variants (goal driver reads `reason.kind`): {kind:'completed'|'aborted'|…}; accept plain
 * strings too. */
const kindOf = (reason: any): string => {
  if (typeof reason === "string") return reason;
  if (reason && typeof reason === "object") {
    if (reason.kind !== undefined) return String(reason.kind);
    if (reason.error !== undefined) return "error";
    if (reason.reason !== undefined) return "aborted";
    if (reason.type !== undefined) return String(reason.type);
  }
  return "unknown";
};
const describeReason = (reason: any): string =>
  typeof reason === "string" ? reason : (JSON.stringify(reason)?.slice(0, 200) ?? "unknown");

export function createBridge(hub: Hub, world: BridgeWorld, options: BridgeOptions) {
  const entries = new Map<number, Entry>();
  const bySession = new Map<string, number>();
  const claimRandom = () => claimId();
  let stopped = false;
  let paused = false;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeHub: (() => void) | undefined;
  let armDisposer: (() => void) | undefined;

  /** One bridge beat: hand in what ended (via events), keep the lease, take on more work. */
  function beat() {
    if (stopped) return;
    hub.heartbeat(
      options.worker,
      [...entries.values()].filter((entry) => entry.handle).map((entry) => entry.job.run),
    );
    dispatch();
    arm();
  }

  /** Arm the single earliest kernel deadline; firing it ticks the hub and takes more work. While runs are held, the
   * next beat never sits further out than the heartbeat floor — the kernel's lease (WORKER_FRESH/RUN_LEASE) assumes a
   * live worker keeps saying so. */
  function arm() {
    armDisposer?.();
    if (stopped) return;
    const due = hub.one<{ at: number }>(
      "SELECT MIN(json_extract(data, '$.at')) AS at FROM projections WHERE collection='due'",
    );
    let ms = Math.min(Math.max((due?.at ?? Infinity) - world.now(), 1000), 2147483647);
    if (entries.size) ms = Math.min(ms, 2 * 60_000);
    armDisposer = world.schedule(ms, () => {
      hub.tick();
      beat();
    });
  }

  function dispatch() {
    if (paused) return; // pause is a bridge-side gate: held runs keep their lease, nothing new is claimed
    while ([...entries.values()].filter((entry) => !entry.settling).length < options.capacity) {
      const job = hub.claimNext(options.worker, claimRandom());
      if (!job) return;
      void start(job);
    }
  }

  async function start(job: Job) {
    const fresh = `agent-autoloop-r${job.run}a${job.attempt}`;
    const planned = job.session ?? fresh;
    // Persist the dispatch intent (session id) before anything slow can fail: a stop here still leaves the run
    // claimed with its intent recorded, and the next boot takes it over through the same session id.
    hub.started(job.run, job.token, { session: planned });
    const entry: Entry = {
      job,
      sessionId: planned,
      handle: undefined,
      turn: undefined,
      lastText: undefined,
      repairs: 0,
      settling: false,
      usage: undefined,
      watchdog: undefined,
      timedOut: undefined,
    };
    entries.set(job.run, entry);
    bySession.set(planned, job.run);
    try {
      const dir = join(world.runsDir, `${job.run}-${job.attempt}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const contextFile = join(dir, "context.json");
      writeFileSync(contextFile, JSON.stringify(job.context, null, 2), { mode: 0o600 });
      const prompt = promptFor(job, contextFile);
      // An answer continues the asking session: reuse the live handle, else resume the persisted one; only when the
      // session can't be opened does the run fall back to a fresh session of its own attempt.
      entry.handle = world.liveAgent(planned);
      if (!entry.handle && job.session) entry.handle = await world.resumeAgent(planned).catch(() => undefined);
      if (!entry.handle) {
        const used = job.session ? fresh : planned;
        entry.handle = await world.createAgent(used, job.rule.cwd, {
          model: job.agent.model,
          effort: job.agent.effort,
          provider: options.provider,
        });
        if (used !== entry.sessionId) {
          bySession.delete(entry.sessionId);
          entry.sessionId = used;
          bySession.set(used, job.run);
          hub.started(job.run, job.token, { session: used });
        }
      }
      await entry.handle.agent.send(world.userMessage(prompt), "next-turn", true);
      entry.watchdog = world.schedule(timeoutMs(job), () => {
        world.log(`run ${job.run}: watchdog fired (${timeoutMs(job) / 60000}min); stopping the turn`);
        entry.timedOut = true;
        entry.handle?.agent.cancel("timeout");
      });
      world.log(`run ${job.run} (${job.rule.name}) dispatched as ${entry.sessionId}`);
    } catch (error) {
      world.log(`run ${job.run} dispatch failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`);
      // Leave the run claimed: without a session the sweep turns it unknown and the owner hears about it.
      entries.delete(job.run);
      bySession.delete(planned);
    }
  }

  /** Receipt repair: ask the same session to rewrite only its last message, at most twice, never redoing work. */
  async function requestRepair(entry: Entry, problem: string) {
    entry.repairs += 1;
    entry.lastText = undefined;
    await entry.handle!.agent.send(world.userMessage(repairPrompt(problem)), "next-turn", true);
    world.log(`run ${entry.job.run}: receipt unreadable (${problem}); asking again (${entry.repairs}/2)`);
  }

  function settle(entry: Entry, data: { turn: number; reason: any }) {
    if (entry.settling) return;
    const { run, token } = entry.job;
    const kind = kindOf(data.reason);
    if (kind === "interrupted") {
      // A crash closer for a turn that never ended: what happened is unknown; the sweep path reports it.
      world.log(`run ${run}: turn interrupted; leaving it for reconciliation`);
      forget(entry);
      return;
    }
    if (kind === "aborted" && data.reason?.reason === "disposed") {
      // Unload while the turn ran: no result may be committed from a dying scope.
      forget(entry);
      return;
    }
    entry.settling = true;
    entry.watchdog?.();
    entry.watchdog = undefined;
    if (entry.timedOut) {
      const minutes = Math.round(timeoutMs(entry.job) / 60000);
      hub.finish(run, token, {
        outcome: "failed",
        error: `超过 ${minutes} 分钟还没结束，已停止`,
        session: entry.sessionId,
        ...(entry.usage && { usage: entry.usage }),
      });
      forget(entry);
      return;
    }
    if (kind === "completed") {
      const { result, problem } = resultFrom(readMessage(entry.lastText ?? ""), { session: entry.sessionId });
      if (problem && entry.repairs < 2) {
        entry.settling = false;
        void requestRepair(entry, problem);
        return;
      }
      if (problem) {
        // The receipt never took effect; the first line's outcome stands, and the owner hears where the original is.
        result.notice = [
          ...(result.notice ?? []),
          {
            title: `「${entry.job.rule.name}」的回执读不懂`,
            text: `这一轮按第一行算结束，但它要中台做的事没有生效（${problem}）。原文是会话 ${entry.sessionId} 的最后一条回复。`,
          },
        ];
      }
      hub.finish(run, token, { ...result, session: entry.sessionId, ...(entry.usage && { usage: entry.usage }) });
      world.log(`run ${run}: ${result.outcome}${problem ? `（回执未生效：${problem}）` : ""}`);
      forget(entry);
      return;
    }
    if (kind === "aborted") {
      hub.finish(run, token, { outcome: "cancelled", summary: "已停止", session: entry.sessionId });
      void retire(entry);
      forget(entry);
      return;
    }
    hub.finish(run, token, { outcome: "failed", error: describeReason(data.reason), session: entry.sessionId });
    void retire(entry);
    forget(entry);
  }

  /** A failed or cancelled turn ends a poisoned session: retire it so the retry falls back to a fresh session that
   * picks up the current trusted options, instead of resurrecting the exact context that just failed. */
  async function retire(entry: Entry) {
    try {
      await entry.handle?.dispose();
    } catch {
      // Already gone with the unloading scope.
    }
  }

  function forget(entry: Entry) {
    entry.watchdog?.();
    entry.watchdog = undefined;
    entries.delete(entry.job.run);
    bySession.delete(entry.sessionId);
  }

  function onSessionEvent(sessionId: string, event: SessionEventLike) {
    const run = bySession.get(sessionId);
    if (run === undefined) return;
    const entry = entries.get(run);
    if (!entry || entry.settling) return;
    if (event.type === "turn/start") {
      entry.turn = event.data.turn;
      hub.started(run, entry.job.token, { link: `turn:${event.data.turn}` });
      return;
    }
    if (event.type === "assistant/message") {
      if (!event.data.interrupted) entry.lastText = textOf(event.data.message);
      if (event.data.usage) entry.usage = addUsage(entry.usage, event.data.usage);
      return;
    }
    if (event.type === "turn/end") settle(entry, event.data);
  }

  /** Boot recovery: take over runs this worker claimed before a restart, resuming their persisted sessions. */
  async function takeOver() {
    for (const run of hub.stateOf().runs.filter((item) => item.state === "claimed" && !item.stopping)) {
      if (entries.has(run.id)) continue;
      const agentConfig = hub.ruleNamed(run.rule);
      if (!agentConfig) continue;
      const config = hub.rules.agents[run.agent];
      if (!config || config.worker !== options.worker) continue;
      const job = hub.jobOf(run.id);
      if (!job) continue;
      const sessionId = run.session ?? `agent-autoloop-r${run.id}a${run.attempts + 1}`;
      const entry: Entry = {
        job,
        sessionId,
        handle: undefined,
        turn: undefined,
        lastText: undefined,
        repairs: 0,
        settling: false,
        usage: undefined,
        watchdog: undefined,
        timedOut: undefined,
      };
      entries.set(run.id, entry);
      bySession.set(sessionId, run.id);
      try {
        entry.handle = world.liveAgent(sessionId) ?? (await world.resumeAgent(sessionId));
        await entry.handle.agent.send(
          world.userMessage(
            "上一轮宿主重启中断了。核实当前事实，接着把剩余步骤做完，不要重做已完成的业务，然后按原格式输出这一轮的结论和回执。",
          ),
          "next-turn",
          true,
        );
        world.log(`run ${run.id}: took over session ${sessionId} after restart`);
      } catch (error) {
        world.log(
          `run ${run.id}: session ${sessionId} 无法恢复（${String((error as Error)?.message ?? error).slice(0, 160)}）；留给复查路径处理`,
        );
        forget(entry);
      }
    }
  }

  function stop() {
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeHub?.();
    unsubscribeHub = undefined;
    armDisposer?.();
    armDisposer = undefined;
    entries.clear();
    bySession.clear();
  }

  return {
    /** Wire the world: subscribe session events, take over orphaned runs, arm the deadline timer, first dispatch. */
    start() {
      unsubscribe = world.onSessionEvent(onSessionEvent);
      // Facts committed by this process (dashboard routes, commands) must wake dispatch immediately, not at the next
      // deadline; the kernel facade's onChange fires once per committed fact.
      unsubscribeHub = hub.onChange(() => {
        if (stopped) return;
        dispatch();
        arm();
      });
      void takeOver().finally(() => beat());
      beat();
    },
    beat,
    dispatch,
    arm,
    stop,
    /** Exposed for tests and the status route: what the bridge holds right now. */
    held(): { run: number; sessionId: string; turn: number | undefined; repairs: number }[] {
      return [...entries.values()].map((entry) => ({
        run: entry.job.run,
        sessionId: entry.sessionId,
        turn: entry.turn,
        repairs: entry.repairs,
      }));
    },
    /** Bridge-side pause gate: nothing new is claimed while paused; held runs keep their lease. */
    setPaused(value: boolean) {
      paused = value;
      if (!value) beat();
    },
    paused: () => paused,
  };
}

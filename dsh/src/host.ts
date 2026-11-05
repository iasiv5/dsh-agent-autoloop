// The DSH-native entry of Agent Autoloop. Stage C: the shared kernel core (host/hub.ts) instantiated on the plugin's
// profile-scoped data dir, the native execution bridge driving ctx.agens through claimed runs, the user commands and
// the dashboard's read-only status route. No standalone shell is loaded, and nothing under ~/.agent-autoloop is read.
// Unloading unwinds the bridge, commands, route, timers and the data lock in one effect.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createHub } from "../../host/hub.ts";
import { readConfig } from "./config.ts";
import { acquireDataLock, dataDir } from "./paths.ts";
import { createBridge, type BridgeAgentHandle, type BridgeWorld } from "./bridge.ts";
import { registerCommands } from "./commands.ts";
import { dashboardRoutes, type Route } from "./web.ts";

/** The bridge's own options, derived from the validated config in one place. A field left out at the call site
 * silently hands every run back to the host's default model (observed 2026-11-05: runs went to github-copilot). */
export const bridgeOptions = (config: { worker: string; capacity: number; provider?: string }) => ({
  worker: config.worker,
  capacity: config.capacity,
  provider: config.provider,
});

export const name = "agent-autoloop";
export const inject: string[] = [
  "webServer",
  "commands",
  "agents",
  "sessionPersistence",
  "workingDirectory",
  "agentDefaultModel",
  "timer",
  "approval",
];

export interface WebServerContext {
  register(route: unknown): (() => void) | void;
}
export interface EffectContext {
  effect(execute: () => (() => void) | void, label?: string): unknown;
  webServer?: WebServerContext;
  commands?: { register(definition: unknown): () => void };
  agents?: {
    create(options: Record<string, unknown>): Promise<BridgeAgentHandle>;
    resume(options: Record<string, unknown>): Promise<BridgeAgentHandle>;
    get(sessionId: string): BridgeAgentHandle["agent"] | undefined;
    dispose?(agent: BridgeAgentHandle["agent"]): unknown;
  };
  workingDirectory?: { set(agent: BridgeAgentHandle["agent"], path: string, signal?: AbortSignal): Promise<void> };
  approval?: { setPolicy(agent: BridgeAgentHandle["agent"], policy: "ask" | "never"): void };
  agentDefaultModel?: { currentSelection(): { provider: string; model: string; reasoningEffort?: string } };
  on(name: string, handler: (...args: any[]) => unknown): () => void;
}

export function apply(ctx: EffectContext): void {
  ctx.effect(() => {
    const dir = dataDir();
    const release = acquireDataLock(dir);
    const config = readConfig(dir);
    if (!config.rules) {
      throw new Error("还没有配置规则：在数据目录的 config.json 里写 rules 之后重启宿主");
    }
    const hub = createHub({ home: join(dir, "hub"), rules: config.rules, publicUrl: config.publicUrl ?? "" });

    const timers = new Set<ReturnType<typeof setTimeout>>();
    // The official message factory when the host's dsh-llm resolves from here; a structurally equal message otherwise.
    let messageFactory: ((text: string) => unknown) | undefined;
    // The specifier is composed so TypeScript doesn't demand the host's types; at runtime it resolves (or the
    // structurally-equal fallback below is used).
    import("@deepseek-ai/dsh" + "-llm")
      .then((module: any) => {
        messageFactory = (text: string) =>
          module.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
      })
      .catch(() => {});
    const userMessage = (text: string): unknown =>
      messageFactory
        ? messageFactory(text)
        : { id: randomUUID(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } };

    const world: BridgeWorld = {
      async createAgent(sessionId, cwd, agentOptions) {
        // 程序化创建的会话必须显式安装模型选择（headless 同款）：setup 里 agent.model.select(...)。
        // 可信规则的 model/effort 优先；宿主默认选择（agentDefaultModel）补齐 provider 等缺口。
        const defaults = ctx.agentDefaultModel?.currentSelection?.() ?? { provider: "", model: "" };
        const configured = {
          provider: agentOptions?.provider ?? defaults.provider,
          model: agentOptions?.model ?? defaults.model,
          reasoningEffort: agentOptions?.effort ?? defaults.reasoningEffort,
        };
        const setup = (agentCtx: unknown, agent: { model?: { select(selection: unknown): void } }) => {
          agent.model?.select?.(configured);
        };
        const handle = await ctx.agents!.create({
          sessionId,
          meta: { cwd },
          agentOptions: configured,
          setup,
        });
        // meta.cwd only lands in the session header; the tools' actual directory is this service's to set.
        await ctx.workingDirectory?.set(handle.agent, cwd);
        // Only an explicitly configured policy is applied; otherwise the deployment default (ask) stays in charge,
        // because a business decision from the kernel never doubles as a tool approval.
        if (config.approvalPolicy) ctx.approval?.setPolicy(handle.agent, config.approvalPolicy);
        handles.set(sessionId, handle);
        return handle;
      },
      async resumeAgent(sessionId) {
        const handle = await ctx.agents!.resume({ sessionId });
        return handle;
      },
      liveAgent(sessionId) {
        const known = handles.get(sessionId);
        if (known) return known;
        const agent = ctx.agents!.get(sessionId);
        return agent ? { agent, dispose: () => void ctx.agents?.dispose?.(agent) } : undefined;
      },
      onSessionEvent(handler) {
        return ctx.on("session/event", (session: any, event: any) => handler(String(session?.id ?? ""), event));
      },
      schedule(ms, fn) {
        const contextTimer = (ctx as any).timeout as ((cb: () => void, delay: number) => () => void) | undefined;
        if (contextTimer) return contextTimer(fn, ms);
        const timer = setTimeout(fn, ms);
        timers.add(timer);
        return () => {
          clearTimeout(timer);
          timers.delete(timer);
        };
      },
      now: Date.now,
      log: (line) => console.log(`${new Date().toISOString()} [agent-autoloop] ${line}`),
      runsDir: join(dir, "runs"),
      userMessage,
    };

    const handles = new Map<string, BridgeAgentHandle>();
    const bridge = createBridge(hub, world, bridgeOptions(config));
    const disposeCommands = ctx.commands
      ? registerCommands((definition) => ctx.commands!.register(definition), hub, "local")
      : undefined;
    const routeDisposers: (() => void)[] = [];
    for (const route of dashboardRoutes({ hub, bridge, config, configDir: dir })) {
      const dispose = ctx.webServer?.register(route);
      if (dispose) routeDisposers.push(dispose);
    }
    bridge.start();

    return () => {
      bridge.stop();
      disposeCommands?.();
      for (const dispose of routeDisposers) {
        try {
          dispose();
        } catch {
          // The route's fiber may already be down.
        }
      }
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      release();
    };
  }, "agent-autoloop:runtime");
}

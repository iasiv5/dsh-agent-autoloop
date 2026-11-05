// The dashboard's data door: one read-only family plus write actions, all behind the same-origin fence. Browsers put
// an Origin header on cross-site fetches but not on same-origin ones, so an Origin that doesn't match our Host is
// refused. Every accepted action lands in the kernel's fact log — that log is the journal; no separate audit trail is
// kept here. Rules writes validate with the standalone parser and persist to config.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRules as checkRules, RulesError } from "../../protocol/rules.ts";
import type { Hub } from "../../host/hub.ts";
import type { AutoloopConfig } from "./config.ts";

export const STATUS_PATH = "/api/agent-autoloop/status";

type Requestish = { method?: string; headers?: Record<string, unknown>; url?: string; body?: string };
type Responseish = {
  statusCode?: number;
  writeHead(status: number, headers: Record<string, string>): unknown;
  end(body?: string): unknown;
};
export type Route = {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: Requestish, res: Responseish) => void | Promise<void>;
};

function reply(res: Responseish, status: number, body: unknown) {
  res.statusCode = status;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Same-origin fence plus method check; false means a reply (403/405) has already gone out. */
function guard(req: Requestish, res: Responseish, method: string): boolean {
  const origin = String(req.headers?.origin ?? "");
  if (origin) {
    try {
      if (new URL(origin).host !== String(req.headers?.host ?? "")) {
        reply(res, 403, { ok: false, error: "跨源请求被拒绝" });
        return false;
      }
    } catch {
      reply(res, 403, { ok: false, error: "跨源请求被拒绝" });
      return false;
    }
  }
  if ((req.method ?? "GET") !== method) {
    reply(res, 405, { ok: false, error: `只接受 ${method}` });
    return false;
  }
  return true;
}

/** Read the request body: tests inject a ready string, the live server hands a stream. Capped at 1 MB. */
async function readJson(req: Requestish): Promise<any> {
  let text: string;
  if (typeof req.body === "string") text = req.body;
  else if (req.body && typeof req.body === "object") text = JSON.stringify(req.body);
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > 1048576) throw new Error("请求最多 1 MB");
      chunks.push(Buffer.from(chunk));
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (!text.trim()) return {}; // pause/resume post nothing
  const body = JSON.parse(text);
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("要是一个 JSON 对象");
  return body;
}

export function pluginVersion(): string {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "?");
  } catch {
    return "?";
  }
}

export type DashboardIo = {
  hub: Hub;
  bridge: {
    setPaused(paused: boolean): void;
    paused(): boolean;
    held(): { run: number; sessionId: string; turn: number | undefined; repairs: number }[];
  };
  config: AutoloopConfig;
  /** Where config.json lives (the data dir). */
  configDir: string;
};

export function dashboardRoutes(io: DashboardIo): Route[] {
  const post = (
    path: string,
    action: (body: any) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Route => ({
    kind: "exact",
    path,
    async handler(req, res) {
      if (!guard(req, res, "POST")) return;
      let body: any;
      try {
        body = await readJson(req);
      } catch (error) {
        return reply(res, 400, { ok: false, error: String((error as Error).message) });
      }
      try {
        reply(res, 200, { ok: true, ...(await action(body)) });
      } catch (error) {
        reply(res, 400, { ok: false, error: String((error as Error)?.message ?? error).slice(0, 300) });
      }
    },
  });

  return [
    {
      kind: "exact",
      path: STATUS_PATH,
      handler(req, res) {
        if (!guard(req, res, "GET")) return;
        const state = io.hub.stateOf();
        reply(res, 200, {
          ok: true,
          plugin: "agent-autoloop",
          version: pluginVersion(),
          stage: "D（完整 Dashboard）",
          at: new Date().toISOString(),
          kernel: {
            worker: io.config.worker,
            capacity: io.config.capacity,
            totals: state.totals,
            held: io.bridge.held(),
            paused: io.bridge.paused(),
          },
        });
      },
    },
    {
      kind: "exact",
      path: "/api/agent-autoloop/overview",
      handler(req, res) {
        if (!guard(req, res, "GET")) return;
        const state = io.hub.stateOf();
        reply(res, 200, {
          ok: true,
          paused: io.bridge.paused(),
          totals: state.totals as unknown as Record<string, unknown>,
          cards: state.cards,
          recentCards: state.recentCards,
          runs: state.runs.map((run: any) => ({ ...run, session: undefined, link: undefined })),
          lines: state.lines,
          held: io.bridge.held(),
        });
      },
    },
    {
      // Prefix route: /api/agent-autoloop/why/<run> returns the raw facts behind one run.
      kind: "prefix",
      path: "/api/agent-autoloop/why",
      handler(req, res) {
        if (!guard(req, res, "GET")) return;
        const run = Number(
          String(req.url ?? "")
            .split("/")
            .at(-1),
        );
        if (!Number.isSafeInteger(run) || run < 1) return reply(res, 400, { ok: false, error: "要给出轮次编号" });
        try {
          reply(res, 200, { ok: true, facts: io.hub.why(run) });
        } catch (error) {
          reply(res, 404, { ok: false, error: String((error as Error)?.message ?? error) });
        }
      },
    },
    post("/api/agent-autoloop/answer", (body) => {
      const card = Number(body.card);
      if (!Number.isSafeInteger(card) || card < 1) throw new Error("card 要是正整数");
      const given: Record<string, unknown> = { by: "面板" };
      if (body.choice !== undefined) given.choice = Number(body.choice);
      else if (body.text !== undefined) given.text = String(body.text);
      else throw new Error("要 choice 或 text");
      const result = io.hub.answer(card, given as any);
      if (!result.changed) throw new Error(`卡片没有变更（状态：${result.state}）`);
      return { state: result.state };
    }),
    post("/api/agent-autoloop/resolve", (body) => {
      const card = Number(body.card);
      const reason = String(body.reason ?? "").trim();
      if (!Number.isSafeInteger(card) || card < 1) throw new Error("card 要是正整数");
      if (!reason) throw new Error("要写处理结果");
      const changed = io.hub.resolve(card, reason.slice(0, 1000), "面板");
      if (!changed) throw new Error("卡片没有变更（可能已关闭）");
      return { changed };
    }),
    post("/api/agent-autoloop/cancel", (body) => {
      const run = Number(body.run);
      if (!Number.isSafeInteger(run) || run < 1) throw new Error("run 要是正整数");
      io.hub.cancel(run);
      return { cancelled: run };
    }),
    post("/api/agent-autoloop/pause", () => {
      io.bridge.setPaused(true);
      return { paused: true };
    }),
    post("/api/agent-autoloop/resume", () => {
      io.bridge.setPaused(false);
      return { paused: false };
    }),
    post("/api/agent-autoloop/emit", (body) => {
      const source = Object.keys(io.hub.rules.sources)[0] ?? "local";
      const ack = io.hub.ingest(source, body);
      return { event: ack.event, duplicate: ack.duplicate, routed: ack.routed };
    }),
    {
      // GET returns the live rules; PUT validates, persists to config.json and applies them as a fact.
      kind: "exact",
      path: "/api/agent-autoloop/rules",
      async handler(req, res) {
        const method = req.method ?? "GET";
        if (!guard(req, res, method)) return;
        if (method === "GET") return reply(res, 200, { ok: true, rules: io.hub.rules });
        let checked: any;
        try {
          checked = await readJson(req);
        } catch (error) {
          return reply(res, 400, { ok: false, error: String((error as Error).message) });
        }
        try {
          const rules = checkRules(
            JSON.stringify(checked),
            Date.now(),
            Intl.DateTimeFormat().resolvedOptions().timeZone,
          );
          const file = join(io.configDir, "config.json");
          let previous: Record<string, unknown> = {};
          try {
            previous = JSON.parse(readFileSync(file, "utf8"));
          } catch {}
          writeFileSync(file, JSON.stringify({ ...previous, rules: checked }, null, 2), { mode: 0o600 });
          io.hub.execute("rules", [rules]);
          reply(res, 200, { ok: true, ruleCount: rules.rules.length });
        } catch (error) {
          const message = error instanceof RulesError ? error.message : String((error as Error)?.message ?? error);
          reply(res, 400, { ok: false, error: message.slice(0, 500) });
        }
      },
    },
  ];
}

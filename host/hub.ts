// The parameterized hub core: a database, the view kept from the log, the rules source, and one way to apply an
// input. Both shells instantiate it — the standalone CLI (host/runtime.ts) with its HOME and watched rules file, the
// DSH plugin (dsh/) with its profile data dir and inline trusted rules. The behavior is written here once, so the two
// shells cannot drift. Importing createHub is side-effect free; calling it opens the database.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { stateOf as state, viewStatements } from "./state.ts";
import { cardHash, digest, whose as keyHolder } from "../kernel/credentials.ts";
import { decide } from "../kernel/decide.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import { initialize, rows, statement, type Fact, type Row, type Table } from "../kernel/evolve.ts";
import * as query from "../kernel/query.ts";
import { eventRule, typeMatches, type Rules } from "../kernel/rules.ts";
import { commitLatest, openView } from "../kernel/store.ts";
import type { Job } from "../protocol/job.ts";
import { parseRules as checkRules, RulesError } from "../protocol/rules.ts";
import type { Rejected } from "../protocol/validate.ts";

export type HubOptions = {
  /** The data directory: hub.db and master.key live here; created 0700 if missing. */
  home: string;
  /** The rules file to watch; omit for a shell that keeps rules elsewhere (then pass `rules`). */
  rulesFile?: string;
  /** Trusted rules for shells without a rules file; applied when the store has none or differs. */
  rules?: Rules;
  /** The public root for card links; empty keeps links off. */
  publicUrl?: string;
};

export type Answer = { choice?: number; text?: string; by?: string; channel?: string; ref?: string };
export type KeyKind = "source" | "worker" | "channel" | "owner";
type EventAck = { event: number; duplicate: boolean; routed: string[] };
type ReceiptAck = { rejected: Rejected[]; duplicate?: boolean };
type CardAck = { card: number; duplicate: boolean };
type Listener = (type: string, facts: Fact[]) => void;

export function createHub(options: HubOptions) {
  const { home } = options;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const masterKeyFile = join(home, "master.key");
  if (!existsSync(masterKeyFile)) {
    writeFileSync(masterKeyFile, randomBytes(32).toString("base64url"), { mode: 0o600, flag: "wx" });
  }
  const masterKey = readFileSync(masterKeyFile, "utf8").trim();
  // An empty or cut-short key would still sign links, and card links derive from what channels see. Replacing it would
  // void every link and token, so that is left to the owner.
  if (!/^[A-Za-z0-9_-]{43}$/.test(masterKey)) {
    throw new Error(
      `${masterKeyFile} 坏了（应该是 43 个字符），中台不启动。从备份恢复这个文件；没有备份就删掉它，` +
        "重启会生成新的，但已经发出的卡片链接和正在跑的轮次会失效。",
    );
  }
  const environment = { secret: masterKey, publicUrl: options.publicUrl ?? "" };

  const db = new DatabaseSync(join(home, "hub.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
  db.function("card_hash", { deterministic: true }, (id, at) => cardHash(environment, id, at));
  initialize(db);

  // Other processes must see either the old views or the new ones, never the gap between DROP and CREATE.
  db.exec(`BEGIN IMMEDIATE; ${viewStatements.join(";")}; COMMIT`);

  const CARD_HASH_INDEX =
    "CREATE INDEX IF NOT EXISTS projection_card_hash ON projections(card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))) WHERE collection='cards'";

  // The persisted projection is expendable; the log alone rebuilds it, which an upgrade has to wait for. Only the files
  // that decide what's stored count here, whole. Both shells compute this fingerprint from the same sources, so either
  // one can reuse the other's projection.
  const format = digest(
    ["../kernel/evolve.ts", "../kernel/credentials.ts"]
      .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
      .join("\n") +
      CARD_HASH_INDEX +
      digest(environment.secret),
  );
  let current = openView(db, format);
  db.exec(CARD_HASH_INDEX);

  const all = <T>(sql: string, params: SQLInputValue[] = []) =>
    db
      .prepare(sql)
      .all(...params)
      .map((row) => ({ ...row }) as T);

  const one = <T>(sql: string, params: SQLInputValue[] = []) => {
    const row = db.prepare(sql).get(...params);
    return row ? ({ ...row } as T) : undefined;
  };

  function getView() {
    current = openView(db, format);
    return current;
  }

  const listeners = new Set<Listener>();
  const onChange = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  // The view is read inside the write lock, so a command and a shell's own writes never decide on a stale view.
  function execute(type: string, args: any[], now = Date.now()) {
    let facts: Fact[] = [];
    let value: any;
    current = commitLatest(db, format, (latest) => {
      ({ facts, value } = decide(latest, { type, args }, now, environment));
      return facts;
    });
    if (facts.length) for (const listener of listeners) listener(type, facts);
    return value;
  }

  const parseRules = (json: string, now = Date.now()) =>
    checkRules(json, now, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const currentRules = () => query.configuration(getView());

  function unreadable(file: string, error: NodeJS.ErrnoException) {
    if (error.code === "ENOENT") return `找不到 ${file}，被删掉或移走了？放回去就会接着用`;
    if (error.code === "EACCES" || error.code === "EPERM") return `没有权限读 ${file}，改回能读的权限就会接着用`;
    return `读不到 ${file}：${error.code ?? error.message}`;
  }

  function reloadRules(file: string): { problem?: string } {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      return { problem: unreadable(file, error as NodeJS.ErrnoException) };
    }
    try {
      const next = parseRules(text);
      const differs = JSON.stringify(next) !== JSON.stringify(currentRules());
      const reportedBroken = (card: Row) => card.key.startsWith("rules:") && card.state === "open";
      if (differs || rows(current, "cards", { state: "open" }).some(reportedBroken)) execute("rules", [next]);
      return {};
    } catch (error) {
      if (error instanceof RulesError) return { problem: error.message };
      throw error;
    }
  }

  if (options.rulesFile) {
    const initial = reloadRules(options.rulesFile);
    if (!currentRules()) throw new Error(initial.problem ?? "缺少规则");
  } else if (options.rules) {
    // Trusted rules from the shell: applied once here and persisted as a fact, so restarts replay them without the
    // option ever being read again.
    const differs = JSON.stringify(options.rules) !== JSON.stringify(currentRules());
    if (!currentRules() || differs) execute("rules", [options.rules]);
  } else {
    throw new Error("缺少规则");
  }

  let toldOf: string | undefined;

  function tick(now = Date.now()) {
    if (options.rulesFile) {
      const { problem } = reloadRules(options.rulesFile);
      // A file still gone or still wrong is a problem at every tick, and an owner who closed the card has heard.
      if (problem && problem !== toldOf) execute("rulesError", [problem], now);
      toldOf = problem;
    }
    execute("tick", [], now);
  }

  const ruleNamed = (name: string) => currentRules().rules.find((rule) => rule.name === name);
  const rulesFor = (source: string, type: string) =>
    currentRules().rules.filter(
      (rule) => eventRule(rule) && rule.when.source === source && typeMatches(rule.when.types, type),
    );
  const workers = () => [...new Set(Object.values(currentRules().agents).map((agent) => agent.worker))];
  const agentsOf = (worker: string) => query.agentsOf(getView(), worker);
  const limitOf = (group: string) => currentRules().rules.find((rule) => rule.group === group)?.parallel ?? 1;

  const ingest = (source: string, input: unknown, now = Date.now()): EventAck =>
    execute("ingest", [source, input], now);
  const claimNext = (worker: string, claim: string, now = Date.now()): Job | null =>
    execute("claimNext", [worker, claim], now);
  const heartbeat = (worker: string, running: number[], now = Date.now()) =>
    execute("heartbeat", [worker, running], now);
  const started = (run: number, token: string, input: unknown, now = Date.now()) =>
    execute("started", [run, token, input], now);
  const finish = (run: number, token: string, input: unknown, now = Date.now()): ReceiptAck =>
    execute("finish", [run, token, input], now);
  const cancel = (run: number, now = Date.now()) => execute("cancel", [run], now);
  const cancels = (worker: string) => query.cancels(getView(), worker);
  const sweep = (now = Date.now()) => execute("sweep", [], now);

  const createCard = (spec: Row, now = Date.now()) => execute("createCard", [spec], now);
  const tell = (key: string, title: string, text: string, now = Date.now()): CardAck =>
    execute("tell", [key, title, text], now);
  const answer = (id: number, given: Answer, now = Date.now()): { changed: boolean; state: string } =>
    execute("answer", [id, given], now);
  const resolve = (id: number, reason: string, by: string, now = Date.now()): boolean =>
    execute("resolve", [id, reason, by], now);
  const nextCard = (channel: string, now = Date.now()): ReturnType<typeof query.cardView> | null =>
    execute("nextCard", [channel], now);
  const delivered = (channel: string, id: number, version: number, ref: string | null, now = Date.now()) =>
    execute("delivered", [channel, id, version, ref], now);
  const failed = (channel: string, id: number, version: number, error: string, now = Date.now()) =>
    execute("failed", [channel, id, version, error], now);

  function cardByToken(token: string) {
    const row = statement(
      db,
      "SELECT data FROM projections WHERE collection='cards' AND card_hash(json_extract(data,'$.id'),json_extract(data,'$.created_at'))=?",
    ).get(digest(token));
    return row ? (JSON.parse(String(row.data)) as Row) : undefined;
  }

  function cardAtLink(token: string) {
    const card = cardByToken(token);
    if (!card || !Object.values(currentRules().channels).some((channel) => channel.links))
      throw new NotFound("没有这张卡片");
    return card;
  }

  function answerByLink(token: string, given: Answer, now = Date.now()) {
    const card = cardAtLink(token);
    if (now - Date.parse(card.created_at) > 7 * 86400_000) {
      throw new AuthError(`这个链接过期了。在装它的电脑上运行 agent-autoloop answer ${card.id} 回答`);
    }
    return answer(card.id, { ...given, by: "链接" }, now);
  }

  const view = (card: Row, ref: string | null = null, links = false) => query.cardView(card, environment, ref, links);
  const unrouted = (limit = 20) => query.unrouted(getView(), limit);
  const stateOf = (now = Date.now(), before?: number) => state(now, before, currentRules(), { all, view, unrouted });

  const keepKeyHash = (kind: KeyKind, name: string, hash: string, now = Date.now()) =>
    execute("key", [kind, name, hash], now);

  function addKey(kind: KeyKind, name: string, now = Date.now()) {
    const key = randomBytes(32).toString("base64url");
    keepKeyHash(kind, name, digest(key), now);
    return key;
  }

  const removeKey = (kind: KeyKind, name: string) => execute("removeKey", [kind, name]);
  const listKeys = () =>
    all<{ kind: string; name: string; created_at: string }>("SELECT kind,name,created_at FROM keys ORDER BY kind,name");
  const whose = (kind: string, key: string) => keyHolder(getView(), kind, key);

  /** The Job of one currently claimed run, rebuilt from the view: the shell the run was claimed by may have died, and
   * a new one needs the same token, context and session to take it over. */
  const jobOf = (id: number): Job | null => {
    const latest = getView();
    const run = latest.get("runs", id);
    return run && run.state === "claimed" ? query.jobOf(latest, run, environment) : null;
  };

  const logAfter = (after = 0, limit = -1) =>
    db
      .prepare("SELECT fact FROM facts WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(after, limit)
      .map((row) => query.safeFact(JSON.parse(String(row.fact))));

  /** The part of the log that explains one run: its events, cards and receipts, and the rules it ran under. */
  function why(id: number) {
    const latest = getView();
    if (!latest.get("runs", id)) throw new NotFound("没有这一轮");
    const events = query.eventsOf(latest, id).map((event) => event.id);
    const cards = [...rows(latest, "cards", { run_id: id }), ...rows(latest, "cards", { answer_event: events })];
    const sequences = new Set<number>();
    const include = (table: Table, key: string | number) => {
      for (const row of statement(db, "SELECT seq FROM projection_refs WHERE collection=? AND key=?").all(
        table,
        String(key),
      ))
        sequences.add(Number(row.seq));
    };
    include("runs", id);
    const read = (seq: number): Fact =>
      JSON.parse(String(statement(db, "SELECT fact FROM facts WHERE seq=?").get(seq)!.fact));
    for (const seq of [...sequences])
      for (const change of read(seq).changes)
        if (change.table === "runs" && change.key === String(id) && change.row?.rules_version)
          sequences.add(change.row.rules_version);
    for (const event of events) include("events", event);
    for (const card of cards) include("cards", card.id);
    return [...sequences].sort((a, b) => a - b).map((seq) => query.safeFact(read(seq)));
  }

  return {
    environment,
    db,
    all,
    one,
    getView,
    onChange,
    execute,
    parseRules,
    get rules() {
      return currentRules();
    },
    reloadRules,
    ruleNamed,
    rulesFor,
    workers,
    agentsOf,
    limitOf,
    ingest,
    claimNext,
    heartbeat,
    started,
    finish,
    cancel,
    cancels,
    sweep,
    tick,
    createCard,
    tell,
    answer,
    resolve,
    nextCard,
    delivered,
    failed,
    cardByToken,
    cardAtLink,
    answerByLink,
    view,
    unrouted,
    stateOf,
    keepKeyHash,
    addKey,
    removeKey,
    listKeys,
    whose,
    jobOf,
    logAfter,
    why,
  };
}

export type Hub = ReturnType<typeof createHub>;
export type { RulesError };

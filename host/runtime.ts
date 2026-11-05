// The standalone shell's hub: the shared core (host/hub.ts) instantiated with this install's HOME and watched rules
// file. Everything below is delegation, so the CLI shell and the DSH plugin cannot drift apart. Importing this still
// opens them all, which is why the checks that must survive a bad rules file import it late.
import { HOME, RULES_FILE } from "./home.ts";
import { createHub } from "./hub.ts";
import { evolve, rows, keyOf, type Table } from "../kernel/evolve.ts";

export const hub = createHub({
  home: HOME,
  rulesFile: RULES_FILE,
  publicUrl: process.env.AGENT_AUTOLOOP_PUBLIC_URL ?? "",
});
export const environment = hub.environment;
export const db = hub.db;
export const all = hub.all;
export const one = hub.one;
export const getView = hub.getView;
export const onChange = hub.onChange;
export const execute = hub.execute;
export const parseRules = hub.parseRules;
export { RulesError } from "../protocol/rules.ts";
export { typeMatches } from "../kernel/rules.ts";
export type { Answer, KeyKind } from "./hub.ts";
export let rules = hub.rules;
export const reloadRules = (file = RULES_FILE) => {
  const result = hub.reloadRules(file);
  rules = hub.rules;
  return result;
};
export const ruleNamed = (name: string) => hub.ruleNamed(name);
export const rulesFor = hub.rulesFor;
export const workers = hub.workers;
export const agentsOf = hub.agentsOf;
export const limitOf = hub.limitOf;
export const ingest = hub.ingest;
export const claimNext = hub.claimNext;
export const heartbeat = hub.heartbeat;
export const started = hub.started;
export const finish = hub.finish;
export const cancel = hub.cancel;
export const cancels = hub.cancels;
export const sweep = hub.sweep;
export function tick(now = Date.now()) {
  const result = hub.tick(now);
  rules = hub.rules;
  return result;
}
export const createCard = hub.createCard;
export const tell = hub.tell;
export const answer = hub.answer;
export const resolve = hub.resolve;
export const nextCard = hub.nextCard;
export const delivered = hub.delivered;
export const failed = hub.failed;
export const cardByToken = hub.cardByToken;
export const cardAtLink = hub.cardAtLink;
export const answerByLink = hub.answerByLink;
export const view = hub.view;
export const unrouted = hub.unrouted;
export const stateOf = hub.stateOf;
export const keepKeyHash = hub.keepKeyHash;
export const addKey = hub.addKey;
export const removeKey = hub.removeKey;
export const listKeys = hub.listKeys;
export const whose = hub.whose;
export const logAfter = hub.logAfter;
export const why = hub.why;

// Test fixtures use this to discard rows without changing the behavioral assertions inherited from the SQL kernel.
export function fixtureClear(table: Table) {
  const latest = getView();
  const changes = rows(latest, table)
    .map((row) => keyOf(table, row))
    .map((key) => ({ table, key, row: null }));
  evolve(latest, [{ version: 1, seq: latest.seq, at: 0, type: "fixture", changes }], db);
}

// The user's commands: status, manual events and decision answers, executed against the receiving agent without the
// model ever seeing them. These are the human door of the stage-C loop; the dashboard calls the same hub through its
// own routes and never through the model.
import type { Hub } from "../../host/hub.ts";

export type CommandRegistration = { register(definition: unknown): () => void };

const line = (row: Record<string, unknown>, fields: [string, string][]) =>
  fields
    .map(([key, label]) => {
      const value = row[key];
      return `${label}=${value === undefined || value === null || value === "" ? "—" : String(value)}`;
    })
    .join(" ");

export function registerCommands(register: CommandRegistration["register"], hub: Hub, source: string): () => void {
  const disposers = [
    register({
      name: "autoloop-status",
      description: "Agent Autoloop：事项、卡片与轮次总览",
      handler: () => {
        const state = hub.stateOf();
        const totals = `进行中 ${state.totals.running} · 排队 ${state.totals.queued} · 待决策卡片 ${state.totals.attention} · 完成 ${state.totals.done}`;
        const cards = state.cards
          .slice(0, 20)
          .map(
            (card: any) =>
              `卡${card.id}「${card.title}」${card.kind === "ask" ? `（选项：${card.options.join("／")}）` : ""}`,
          )
          .join("\n");
        const runs = state.runs
          .slice(0, 20)
          .map(
            (run: any) =>
              `轮${run.id}「${run.rule}」${run.state}${run.summary ? `：${run.summary}` : run.error ? `：${run.error}` : ""}`,
          )
          .join("\n");
        return {
          kind: "success" as const,
          text: [
            totals,
            cards ? `待决策：\n${cards}` : "待决策：无",
            runs ? `最近轮次：\n${runs}` : "最近轮次：无",
          ].join("\n\n"),
        };
      },
    }),
    register({
      name: "autoloop-emit",
      description: 'Agent Autoloop：提交一个本地事件，格式 {"id":…,"type":…,"subject":…}',
      handler: ({ rawInput }: any) => {
        let event: unknown;
        try {
          event = JSON.parse(rawInput);
        } catch {
          return { kind: "error" as const, text: '事件要是一个 JSON 对象：{"id":"…","type":"…","subject":"…"}' };
        }
        const ack = hub.ingest(source, event);
        return {
          kind: "success" as const,
          text: ack.duplicate
            ? `事件 ${ack.event} 之前已收过（幂等），未重复派发`
            : `事件 ${ack.event} 已入账${ack.routed.length ? `，路由到：${ack.routed.join("、")}` : "，没有匹配的规则（留在未路由里）"}`,
        };
      },
    }),
    register({
      name: "autoloop-answer",
      description: "Agent Autoloop：回答一个待决策卡片，格式 <卡片编号> <选项序号|自由回答>",
      handler: ({ rawInput }: any) => {
        const match = /^(\d+)\s+([\s\S]+)$/.exec(rawInput.trim());
        if (!match) return { kind: "error" as const, text: "格式：<卡片编号> <选项序号 或 自由回答>" };
        const id = Number(match[1]);
        const rest = match[2].trim();
        const given = /^\d+$/.test(rest) ? { choice: Number(rest) } : { text: rest };
        const result = hub.answer(id, { ...given, by: "本人" });
        return result.changed
          ? { kind: "success" as const, text: `卡片 ${id} 已回答（${result.state}），相关事项会接着推进` }
          : { kind: "error" as const, text: `卡片 ${id} 没有变更（状态：${result.state}）` };
      },
    }),
  ];
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // The command registry may already be down.
      }
    }
  };
}

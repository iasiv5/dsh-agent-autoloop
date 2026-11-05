// The dashboard's browser half: an entry button in the sidebar footer opening a floating multi-view panel on
// shell.overlay — 总览/待决策/轮次/规则/时间线. Reads come from the same-origin routes the host half registers
// (fetched document-relative: the web UI serves under <base href="./">); every write lands in the kernel's fact log.
// React is the host's own copy: the module-loader factory passes require through, so the build keeps react external.
type ReactModule = {
  createElement: (...args: any[]) => any;
  useState: <S>(initial: S) => [S, (next: S | ((current: S) => S)) => void];
  useEffect: (run: () => void | (() => void), deps?: unknown[]) => void;
};

interface Slots {
  inject(name: string, register: () => unknown): unknown;
  register(entry: Record<string, unknown>, component: (...args: any[]) => any): unknown;
}
export interface ClientContext {
  slots?: Slots | null;
  effect(execute: () => (() => void) | void, label?: string): unknown;
}

declare function require(id: string): any;

export const name = "agent-autoloop-client";
export const inject: string[] = ["slots"];

function loadReact(): ReactModule | null {
  try {
    const react = require("react") as ReactModule;
    if (
      react &&
      typeof react.createElement === "function" &&
      typeof react.useState === "function" &&
      typeof react.useEffect === "function"
    ) {
      return react;
    }
    return null;
  } catch {
    return null;
  }
}

const API = "api/agent-autoloop";
const TABS = ["总览", "待决策", "轮次", "规则", "时间线"] as const;

export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const slots = ctx.slots;
    if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
    const React = loadReact();
    if (!React) return;

    let open = false;
    const listeners = new Set<() => void>();
    const setOpen = (next: boolean) => {
      open = next;
      for (const listener of listeners) listener();
    };
    const useOpen = (): boolean => {
      const [current, setCurrent] = React.useState(open);
      React.useEffect(() => {
        const listener = () => setCurrent(open);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }, []);
      return current;
    };

    const EntryButton = () =>
      React.createElement(
        "button",
        {
          title: "Agent Autoloop：事项与待决策",
          onClick: () => setOpen(!open),
          style: {
            font: "inherit",
            cursor: "pointer",
            borderRadius: 8,
            border: "1px solid CanvasText",
            padding: "2px 8px",
            background: open ? "CanvasText" : "Canvas",
            color: open ? "Canvas" : "CanvasText",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
        },
        open ? "▾ Autoloop" : "▴ Autoloop",
      );

    const jsonFetch = async (path: string, method?: string, body?: unknown) => {
      const res = await fetch(API + path, {
        method: method ?? "GET",
        ...(body !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
      return (await res.json()) as any;
    };

    const Panel = () => {
      const isOpen = useOpen();
      const [tab, setTab] = React.useState<(typeof TABS)[number]>("总览");
      const [overview, setOverview] = React.useState<any>(null);
      const [rules, setRules] = React.useState<string>("");
      const [message, setMessage] = React.useState("");
      const [whyRun, setWhyRun] = React.useState("");
      const [timeline, setTimeline] = React.useState<string[]>([]);
      const [emitText, setEmitText] = React.useState('{"id":"本地事件1","type":"demo.start","subject":"手工"}');

      React.useEffect(() => {
        if (!isOpen) return;
        let stopped = false;
        const load = async () => {
          const data = await jsonFetch("/overview").catch(() => null);
          if (data?.ok && !stopped) setOverview(data);
        };
        load();
        const timer = setInterval(load, 10_000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [isOpen]);
      React.useEffect(() => {
        if (!isOpen || tab !== "规则") return;
        let stopped = false;
        jsonFetch("/rules")
          .then((data) => {
            if (data?.ok && !stopped) setRules(JSON.stringify(data.rules, null, 2));
          })
          .catch(() => {});
        return () => {
          stopped = true;
        };
      }, [isOpen, tab]);

      if (!isOpen) return null;
      const act = async (path: string, body: unknown, note: string) => {
        const data = await jsonFetch(path, "POST", body).catch((error) => ({ ok: false, error: String(error) }));
        setMessage(`${note}: ${data?.ok ? "已执行" : (data?.error ?? "失败")}`);
        const fresh = await jsonFetch("/overview").catch(() => null);
        if (fresh?.ok) setOverview(fresh);
      };

      const cardRow = (card: any) => {
        if (card.kind === "ask") {
          return React.createElement(
            "div",
            { key: `c${card.id}`, style: cardBox },
            React.createElement(
              "div",
              null,
              React.createElement("b", null, `卡${card.id} ${card.title}`),
              ` — ${card.text}`,
            ),
            React.createElement(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 } },
              ...card.options.map((option: string, index: number) =>
                React.createElement(
                  "button",
                  {
                    key: option,
                    style: buttonStyle,
                    onClick: () => act("/answer", { card: card.id, choice: index }, `卡${card.id} 选「${option}」`),
                  },
                  option,
                ),
              ),
            ),
          );
        }
        return React.createElement(
          "div",
          { key: `c${card.id}`, style: cardBox },
          React.createElement(
            "div",
            null,
            React.createElement("b", null, `卡${card.id} ${card.title}`),
            ` — ${card.text}`,
          ),
          React.createElement(
            "button",
            {
              style: { ...buttonStyle, marginTop: 6 },
              onClick: () => act("/answer", { card: card.id, text: "已处理" }, `卡${card.id}`),
            },
            "已处理",
          ),
        );
      };

      const runRow = (run: any) =>
        React.createElement(
          "div",
          { key: `r${run.id}`, style: cardBox },
          React.createElement(
            "div",
            null,
            React.createElement("b", null, `轮${run.id}「${run.rule}」`),
            ` ${run.state}${run.attempts > 0 ? `（第 ${run.attempts + 1} 次）` : ""}`,
          ),
          run.summary ? React.createElement("div", null, run.summary) : null,
          run.error ? React.createElement("div", { style: { color: "CanvasText", opacity: 0.75 } }, run.error) : null,
          ["queued", "claimed"].includes(run.state)
            ? React.createElement(
                "button",
                {
                  style: { ...buttonStyle, marginTop: 6 },
                  onClick: () => act("/cancel", { run: run.id }, `轮${run.id} 取消`),
                },
                "取消",
              )
            : null,
          React.createElement(
            "button",
            {
              style: { ...buttonStyle, marginTop: 6, marginLeft: 6 },
              onClick: () => {
                setWhyRun(String(run.id));
                setTab("时间线");
              },
            },
            "时间线",
          ),
        );

      const body = (() => {
        if (!overview) return React.createElement("div", null, "读不到状态（宿主半未就绪？）");
        const totals = overview.totals ?? {};
        const line = rowLine(React);
        if (tab === "总览") {
          return React.createElement(
            "div",
            null,
            line("进行中", totals.running),
            line("排队", totals.queued),
            line("重试中", totals.retrying),
            line("结果不明", totals.unknown),
            line("已完成", totals.done),
            line("待决策卡片", totals.attention),
            React.createElement(
              "div",
              { style: { marginTop: 10 } },
              overview.paused ? "已暂停（不领取新事项）" : "运行中",
              React.createElement(
                "button",
                {
                  style: { ...buttonStyle, marginLeft: 8 },
                  onClick: () => act(overview.paused ? "/resume" : "/pause", {}, overview.paused ? "恢复" : "暂停"),
                },
                overview.paused ? "恢复" : "暂停",
              ),
            ),
            React.createElement(
              "div",
              { style: { marginTop: 10 } },
              "提交本地事件（JSON）：",
              React.createElement("textarea", {
                value: emitText,
                onChange: (e: any) => setEmitText(e.target.value),
                style: { width: "100%", minHeight: 60, font: "12px ui-monospace, monospace" },
              }),
              React.createElement(
                "button",
                {
                  style: { ...buttonStyle, marginTop: 6 },
                  onClick: () => {
                    try {
                      act("/emit", JSON.parse(emitText), "提交事件");
                    } catch {
                      setMessage("事件不是合法 JSON");
                    }
                  },
                },
                "提交",
              ),
            ),
          );
        }
        if (tab === "待决策") {
          const cards = overview.cards ?? [];
          return cards.length
            ? React.createElement("div", null, ...cards.map(cardRow))
            : React.createElement("div", null, "没有待决策的卡片");
        }
        if (tab === "轮次") {
          const runs = overview.runs ?? [];
          return runs.length
            ? React.createElement("div", null, ...runs.map(runRow))
            : React.createElement("div", null, "还没有轮次");
        }
        if (tab === "规则") {
          return React.createElement(
            "div",
            null,
            "规则（与 standalone rules.json 同一校验器）：",
            React.createElement("textarea", {
              value: rules,
              onChange: (e: any) => setRules(e.target.value),
              style: { width: "100%", minHeight: 180, font: "12px ui-monospace, monospace" },
            }),
            React.createElement(
              "button",
              {
                style: { ...buttonStyle, marginTop: 6 },
                onClick: async () => {
                  try {
                    const data = await jsonFetch("/rules", "PUT", JSON.parse(rules));
                    setMessage(`规则: ${data?.ok ? `已保存并生效（${data.ruleCount} 条）` : (data?.error ?? "失败")}`);
                  } catch {
                    setMessage("规则: 不是合法 JSON");
                  }
                },
              },
              "保存并生效",
            ),
          );
        }
        return React.createElement(
          "div",
          null,
          "轮次编号：",
          React.createElement("input", {
            value: whyRun,
            onChange: (e: any) => setWhyRun(e.target.value),
            style: { width: 80, font: "inherit" },
          }),
          React.createElement(
            "button",
            {
              style: { ...buttonStyle, marginLeft: 6 },
              onClick: async () => {
                const data = await jsonFetch(`/why/${whyRun}`).catch(() => null);
                if (!data?.ok) return setTimeline([data?.error ?? "查不到这一轮"]);
                setTimeline(
                  (data.facts as any[]).map(
                    (fact) => `#${fact.seq} ${fact.type} ${new Date(fact.at).toLocaleTimeString()}`,
                  ),
                );
              },
            },
            "查看时间线",
          ),
          React.createElement(
            "div",
            { style: { marginTop: 8, font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap" } },
            timeline.length ? timeline.join("\n") : "（输入编号后查看）",
          ),
        );
      })();

      return React.createElement(
        "div",
        {
          onClick: (event: any) => event.stopPropagation(),
          style: {
            position: "fixed",
            right: 16,
            bottom: 64,
            width: 380,
            maxHeight: "70vh",
            overflow: "auto",
            background: "Canvas",
            color: "CanvasText",
            border: "1px solid CanvasText",
            borderRadius: 12,
            padding: 14,
            font: "13px/1.5 system-ui, sans-serif",
            pointerEvents: "auto",
            zIndex: 60,
            boxShadow: "0 8px 30px rgba(0,0,0,.25)",
          },
        },
        React.createElement("div", { style: { fontWeight: 700, marginBottom: 6 } }, "Agent Autoloop"),
        React.createElement(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 } },
          ...TABS.map((name) =>
            React.createElement(
              "button",
              {
                key: name,
                style: {
                  ...buttonStyle,
                  background: tab === name ? "CanvasText" : "Canvas",
                  color: tab === name ? "Canvas" : "CanvasText",
                },
                onClick: () => setTab(name),
              },
              name,
            ),
          ),
        ),
        body,
        message ? React.createElement("div", { style: { marginTop: 8, opacity: 0.85 } }, message) : null,
        React.createElement(
          "button",
          { onClick: () => setOpen(false), style: { ...buttonStyle, marginTop: 10 } },
          "关闭",
        ),
      );
    };

    const disposers = [
      slots.inject("sidebar.footer.action", () =>
        slots.register({ name: "sidebar.footer.action", id: "agent-autoloop-entry" }, EntryButton),
      ),
      slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "agent-autoloop-panel" }, Panel)),
    ];
    return () => {
      listeners.clear();
      for (const dispose of disposers) {
        try {
          (dispose as (() => void) | undefined)?.();
        } catch {
          // The seat's fiber may already be down.
        }
      }
    };
  }, "agent-autoloop:dashboard");
}

const cardBox: Record<string, any> = { border: "1px solid CanvasText", borderRadius: 8, padding: 8, marginTop: 8 };
const buttonStyle: Record<string, any> = {
  font: "inherit",
  cursor: "pointer",
  borderRadius: 6,
  border: "1px solid CanvasText",
  padding: "2px 8px",
  background: "Canvas",
  color: "CanvasText",
};

const rowLine = (React: ReactModule) => (label: string, value: any) =>
  React.createElement(
    "div",
    { key: label, style: { display: "flex", gap: 8 } },
    React.createElement("b", null, label),
    String(value ?? "—"),
  );

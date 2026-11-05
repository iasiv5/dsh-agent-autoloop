window.__ModuleLoader__.load({
	id: "@iasiv5/dsh-agent-autoloop",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  name: () => name
});
module.exports = __toCommonJS(client_exports);
var name = "agent-autoloop-client";
var inject = ["slots"];
function loadReact() {
  try {
    const react = require("react");
    if (react && typeof react.createElement === "function" && typeof react.useState === "function" && typeof react.useEffect === "function") {
      return react;
    }
    return null;
  } catch {
    return null;
  }
}
var API = "api/agent-autoloop";
var TABS = ["\u603B\u89C8", "\u5F85\u51B3\u7B56", "\u8F6E\u6B21", "\u89C4\u5219", "\u65F6\u95F4\u7EBF"];
function apply(ctx) {
  ctx.effect(() => {
    const slots = ctx.slots;
    if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
    const React = loadReact();
    if (!React) return;
    let open = false;
    const listeners = /* @__PURE__ */ new Set();
    const setOpen = (next) => {
      open = next;
      for (const listener of listeners) listener();
    };
    const useOpen = () => {
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
    const EntryButton = () => React.createElement(
      "button",
      {
        title: "Agent Autoloop\uFF1A\u4E8B\u9879\u4E0E\u5F85\u51B3\u7B56",
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
          whiteSpace: "nowrap"
        }
      },
      open ? "\u25BE Autoloop" : "\u25B4 Autoloop"
    );
    const jsonFetch = async (path, method, body) => {
      const res = await fetch(API + path, {
        method: method ?? "GET",
        ...body !== void 0 && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }
      });
      return await res.json();
    };
    const Panel = () => {
      const isOpen = useOpen();
      const [tab, setTab] = React.useState("\u603B\u89C8");
      const [overview, setOverview] = React.useState(null);
      const [rules, setRules] = React.useState("");
      const [message, setMessage] = React.useState("");
      const [whyRun, setWhyRun] = React.useState("");
      const [timeline, setTimeline] = React.useState([]);
      const [emitText, setEmitText] = React.useState('{"id":"\u672C\u5730\u4E8B\u4EF61","type":"demo.start","subject":"\u624B\u5DE5"}');
      React.useEffect(() => {
        if (!isOpen) return;
        let stopped = false;
        const load = async () => {
          const data = await jsonFetch("/overview").catch(() => null);
          if (data?.ok && !stopped) setOverview(data);
        };
        load();
        const timer = setInterval(load, 1e4);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [isOpen]);
      React.useEffect(() => {
        if (!isOpen || tab !== "\u89C4\u5219") return;
        let stopped = false;
        jsonFetch("/rules").then((data) => {
          if (data?.ok && !stopped) setRules(JSON.stringify(data.rules, null, 2));
        }).catch(() => {
        });
        return () => {
          stopped = true;
        };
      }, [isOpen, tab]);
      if (!isOpen) return null;
      const act = async (path, body2, note) => {
        const data = await jsonFetch(path, "POST", body2).catch((error) => ({ ok: false, error: String(error) }));
        setMessage(`${note}: ${data?.ok ? "\u5DF2\u6267\u884C" : data?.error ?? "\u5931\u8D25"}`);
        const fresh = await jsonFetch("/overview").catch(() => null);
        if (fresh?.ok) setOverview(fresh);
      };
      const cardRow = (card) => {
        if (card.kind === "ask") {
          return React.createElement(
            "div",
            { key: `c${card.id}`, style: cardBox },
            React.createElement(
              "div",
              null,
              React.createElement("b", null, `\u5361${card.id} ${card.title}`),
              ` \u2014 ${card.text}`
            ),
            React.createElement(
              "div",
              { style: { display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 } },
              ...card.options.map(
                (option, index) => React.createElement(
                  "button",
                  {
                    key: option,
                    style: buttonStyle,
                    onClick: () => act("/answer", { card: card.id, choice: index }, `\u5361${card.id} \u9009\u300C${option}\u300D`)
                  },
                  option
                )
              )
            )
          );
        }
        return React.createElement(
          "div",
          { key: `c${card.id}`, style: cardBox },
          React.createElement(
            "div",
            null,
            React.createElement("b", null, `\u5361${card.id} ${card.title}`),
            ` \u2014 ${card.text}`
          ),
          React.createElement(
            "button",
            {
              style: { ...buttonStyle, marginTop: 6 },
              onClick: () => act("/answer", { card: card.id, text: "\u5DF2\u5904\u7406" }, `\u5361${card.id}`)
            },
            "\u5DF2\u5904\u7406"
          )
        );
      };
      const runRow = (run) => React.createElement(
        "div",
        { key: `r${run.id}`, style: cardBox },
        React.createElement(
          "div",
          null,
          React.createElement("b", null, `\u8F6E${run.id}\u300C${run.rule}\u300D`),
          ` ${run.state}${run.attempts > 0 ? `\uFF08\u7B2C ${run.attempts + 1} \u6B21\uFF09` : ""}`
        ),
        run.summary ? React.createElement("div", null, run.summary) : null,
        run.error ? React.createElement("div", { style: { color: "CanvasText", opacity: 0.75 } }, run.error) : null,
        ["queued", "claimed"].includes(run.state) ? React.createElement(
          "button",
          {
            style: { ...buttonStyle, marginTop: 6 },
            onClick: () => act("/cancel", { run: run.id }, `\u8F6E${run.id} \u53D6\u6D88`)
          },
          "\u53D6\u6D88"
        ) : null,
        React.createElement(
          "button",
          {
            style: { ...buttonStyle, marginTop: 6, marginLeft: 6 },
            onClick: () => {
              setWhyRun(String(run.id));
              setTab("\u65F6\u95F4\u7EBF");
            }
          },
          "\u65F6\u95F4\u7EBF"
        )
      );
      const body = (() => {
        if (!overview) return React.createElement("div", null, "\u8BFB\u4E0D\u5230\u72B6\u6001\uFF08\u5BBF\u4E3B\u534A\u672A\u5C31\u7EEA\uFF1F\uFF09");
        const totals = overview.totals ?? {};
        const line = rowLine(React);
        if (tab === "\u603B\u89C8") {
          return React.createElement(
            "div",
            null,
            line("\u8FDB\u884C\u4E2D", totals.running),
            line("\u6392\u961F", totals.queued),
            line("\u91CD\u8BD5\u4E2D", totals.retrying),
            line("\u7ED3\u679C\u4E0D\u660E", totals.unknown),
            line("\u5DF2\u5B8C\u6210", totals.done),
            line("\u5F85\u51B3\u7B56\u5361\u7247", totals.attention),
            React.createElement(
              "div",
              { style: { marginTop: 10 } },
              overview.paused ? "\u5DF2\u6682\u505C\uFF08\u4E0D\u9886\u53D6\u65B0\u4E8B\u9879\uFF09" : "\u8FD0\u884C\u4E2D",
              React.createElement(
                "button",
                {
                  style: { ...buttonStyle, marginLeft: 8 },
                  onClick: () => act(overview.paused ? "/resume" : "/pause", {}, overview.paused ? "\u6062\u590D" : "\u6682\u505C")
                },
                overview.paused ? "\u6062\u590D" : "\u6682\u505C"
              )
            ),
            React.createElement(
              "div",
              { style: { marginTop: 10 } },
              "\u63D0\u4EA4\u672C\u5730\u4E8B\u4EF6\uFF08JSON\uFF09\uFF1A",
              React.createElement("textarea", {
                value: emitText,
                onChange: (e) => setEmitText(e.target.value),
                style: { width: "100%", minHeight: 60, font: "12px ui-monospace, monospace" }
              }),
              React.createElement(
                "button",
                {
                  style: { ...buttonStyle, marginTop: 6 },
                  onClick: () => {
                    try {
                      act("/emit", JSON.parse(emitText), "\u63D0\u4EA4\u4E8B\u4EF6");
                    } catch {
                      setMessage("\u4E8B\u4EF6\u4E0D\u662F\u5408\u6CD5 JSON");
                    }
                  }
                },
                "\u63D0\u4EA4"
              )
            )
          );
        }
        if (tab === "\u5F85\u51B3\u7B56") {
          const cards = overview.cards ?? [];
          return cards.length ? React.createElement("div", null, ...cards.map(cardRow)) : React.createElement("div", null, "\u6CA1\u6709\u5F85\u51B3\u7B56\u7684\u5361\u7247");
        }
        if (tab === "\u8F6E\u6B21") {
          const runs = overview.runs ?? [];
          return runs.length ? React.createElement("div", null, ...runs.map(runRow)) : React.createElement("div", null, "\u8FD8\u6CA1\u6709\u8F6E\u6B21");
        }
        if (tab === "\u89C4\u5219") {
          return React.createElement(
            "div",
            null,
            "\u89C4\u5219\uFF08\u4E0E standalone rules.json \u540C\u4E00\u6821\u9A8C\u5668\uFF09\uFF1A",
            React.createElement("textarea", {
              value: rules,
              onChange: (e) => setRules(e.target.value),
              style: { width: "100%", minHeight: 180, font: "12px ui-monospace, monospace" }
            }),
            React.createElement(
              "button",
              {
                style: { ...buttonStyle, marginTop: 6 },
                onClick: async () => {
                  try {
                    const data = await jsonFetch("/rules", "PUT", JSON.parse(rules));
                    setMessage(`\u89C4\u5219: ${data?.ok ? `\u5DF2\u4FDD\u5B58\u5E76\u751F\u6548\uFF08${data.ruleCount} \u6761\uFF09` : data?.error ?? "\u5931\u8D25"}`);
                  } catch {
                    setMessage("\u89C4\u5219: \u4E0D\u662F\u5408\u6CD5 JSON");
                  }
                }
              },
              "\u4FDD\u5B58\u5E76\u751F\u6548"
            )
          );
        }
        return React.createElement(
          "div",
          null,
          "\u8F6E\u6B21\u7F16\u53F7\uFF1A",
          React.createElement("input", {
            value: whyRun,
            onChange: (e) => setWhyRun(e.target.value),
            style: { width: 80, font: "inherit" }
          }),
          React.createElement(
            "button",
            {
              style: { ...buttonStyle, marginLeft: 6 },
              onClick: async () => {
                const data = await jsonFetch(`/why/${whyRun}`).catch(() => null);
                if (!data?.ok) return setTimeline([data?.error ?? "\u67E5\u4E0D\u5230\u8FD9\u4E00\u8F6E"]);
                setTimeline(
                  data.facts.map(
                    (fact) => `#${fact.seq} ${fact.type} ${new Date(fact.at).toLocaleTimeString()}`
                  )
                );
              }
            },
            "\u67E5\u770B\u65F6\u95F4\u7EBF"
          ),
          React.createElement(
            "div",
            { style: { marginTop: 8, font: "12px ui-monospace, monospace", whiteSpace: "pre-wrap" } },
            timeline.length ? timeline.join("\n") : "\uFF08\u8F93\u5165\u7F16\u53F7\u540E\u67E5\u770B\uFF09"
          )
        );
      })();
      return React.createElement(
        "div",
        {
          onClick: (event) => event.stopPropagation(),
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
            boxShadow: "0 8px 30px rgba(0,0,0,.25)"
          }
        },
        React.createElement("div", { style: { fontWeight: 700, marginBottom: 6 } }, "Agent Autoloop"),
        React.createElement(
          "div",
          { style: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 } },
          ...TABS.map(
            (name2) => React.createElement(
              "button",
              {
                key: name2,
                style: {
                  ...buttonStyle,
                  background: tab === name2 ? "CanvasText" : "Canvas",
                  color: tab === name2 ? "Canvas" : "CanvasText"
                },
                onClick: () => setTab(name2)
              },
              name2
            )
          )
        ),
        body,
        message ? React.createElement("div", { style: { marginTop: 8, opacity: 0.85 } }, message) : null,
        React.createElement(
          "button",
          { onClick: () => setOpen(false), style: { ...buttonStyle, marginTop: 10 } },
          "\u5173\u95ED"
        )
      );
    };
    const disposers = [
      slots.inject(
        "sidebar.footer.action",
        () => slots.register({ name: "sidebar.footer.action", id: "agent-autoloop-entry" }, EntryButton)
      ),
      slots.inject("shell.overlay", () => slots.register({ name: "shell.overlay", id: "agent-autoloop-panel" }, Panel))
    ];
    return () => {
      listeners.clear();
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
        }
      }
    };
  }, "agent-autoloop:dashboard");
}
var cardBox = { border: "1px solid CanvasText", borderRadius: 8, padding: 8, marginTop: 8 };
var buttonStyle = {
  font: "inherit",
  cursor: "pointer",
  borderRadius: 6,
  border: "1px solid CanvasText",
  padding: "2px 8px",
  background: "Canvas",
  color: "CanvasText"
};
var rowLine = (React) => (label, value) => React.createElement(
  "div",
  { key: label, style: { display: "flex", gap: 8 } },
  React.createElement("b", null, label),
  String(value ?? "\u2014")
);

		return module.exports;
	}
});

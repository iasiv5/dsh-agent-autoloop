# 设计对齐记录（dsh-alignment）

状态：第一轮对齐进行中（2026-11-04 晚）。本文随回答持续更新；用户确认设计基线前不进行架构性实现。
对齐机制说明：任务书指定调用 grill-with-docs skill；本会话技能目录中**不存在**该确切名称，可用的同族技能为 `grilling`（本仓库 skills 体系中两者并称，见 writing-plans 技能对 `/grill-with-docs /grilling` 的并列引用）。本文对齐过程按 grilling 的真实流程（设计树+分轮+推荐答案）执行，**以文档为证据来源——这是替代流程，非 grill-with-docs 原技能的执行结果**，特此留痕。

## 1. 已确定约束（不再询问）

来自任务书：原生插件方向；只在宿主运行期工作、不做独立 daemon；主要编排 DSH 自己的会话；不用外部 CLI 冒充原生集成；保留持久事项闭环与既有可靠性语义；开发分支 dsh-agent-autoloop；未经授权不推送/发布/操作真实业务系统；不修改 DSH 核心；首版不做飞书/钉钉/Slack 账号集成、多机 Worker、GitHub 自动交付、Dashboard、插件市场。

来自环境证据：宿主版本锁定 `@deepseek-ai/dsh@0.2.2-rc.1`（engines node>=24.9.0，cordis 4.1.0）；本机 web profile（~/.dsh/profiles/web）；插件=cordis 入口 npm 包；node:sqlite 可用。

## 2. 审计发现（证据全文见 docs/dsh-migration-audit.md 与 docs/dsh-api-mapping.md）

- 内核 ~1650 行零依赖、全输入面在 decide.ts HANDLERS；事项=rule+lane 隐式；可靠性语义完备且被 268 用例+20 万步模拟+40320 序穷举+23 变异钉住。基线全绿（296/294/0/2）。
- 原生闭环可零内核语义改动实现：claimNext→ctx.agents→turn/end 取证→started/finish 持久化关联。
- DSH 公开能力充分：ctx.agents.create/resume（SessionAlreadyOwnedError/SessionPersistenceNotFoundError 契约）、durable turn/start|end（TurnEndReason 六种）、sessionPersistence（flush=唯一落盘屏障）、ctx.commands（人类入口不进模型）、ctx.approval（ask|never，默认 ask）、cordis 生命周期与定时器。
- 关键风险五处显式清单需同步（tsconfig include、purity 两处目录清单、ci-scope、mutate 沙箱、测试 glob）+ dispose 会移除 session store 记录（阶段 2 探针验证）。

## 3. 第一轮未决问题（前置均已落定，见对齐消息 Q1–Q7）

| # | 问题 | 证据 | 推荐 | 结果（2026-11-05 第一轮） |
|---|---|---|---|---|
| Q1 | 回执主路径 A（解析最终 assistant 消息+复用 contract）vs B（宿主回执工具） | api-mapping §5；contract.ts 全套既有测试 | A | ✅ 用户确认：路径 A |
| Q2 | 预算口径：硬限=hops+单轮时长，轮数/费用首版软限制 | due.ts/decide.ts 退避既有；宿主用量钩子未证实 | 是 | ✅ 用户确认 |
| Q3 | 数据与实例边界：profile 级隔离+目录锁 | api-mapping §1 profile 结构；up.ts:17-27 锁先例 | 是 | ✅ 用户确认 |
| Q4 | 暂停=桥层 gate 不写事实；卸载=disposal+数据保留 | cancel/终态不可变既有；协议是产品（改协议成本高） | 是 | ✅ 用户确认 |
| Q5 | 首版入口=一组用户命令，不做 UI 注入 | dsh-commands「不发给模型」语义；client 注入证据不足（缺口9） | 是 | ⚠️ 用户选择**做 Dashboard 页**——偏离推荐，也与任务书「首版不做大型 Dashboard」默认不同；范围待第二轮澄清，宿主 UI 注入能力勘察中 |
| Q6 | 真实模型 smoke 授权（最小、受控、临时目录） | 任务书 §十七 测试分层要求授权 | 允许 | ✅ 用户确认：允许最小 smoke |
| Q7 | 阶段 1–4 验收载体=独立测试 profile，不碰活 web | 活 web 重启腰斩会话（know-how 037） | 是 | ✅ 用户确认 |

## 4. 工程默认（低风险细节，工程师决策并留痕；用户可否决）

| 默认 | 依据 |
|---|---|
| 宿主兼容声明 `engines.dsh: ">=0.2.2-rc.1"`，首版仅面向 web profile，desktop 延后 | 环境证据 A |
| 错过周期/过期决策沿用内核语义：cron 只补最近一次、timer 触发一次、ask 卡不过期不自动取消 | schedule.test.ts/cron.test.ts 钉住；低打扰原则 |
| 完成证据=终态 run 的 finish 事实链（回执 JSON+summary+关联卡片收敛），模型自述不作唯一证据 | 任务书 §10 + invariants.ts:76-78 |
| 自动重试/人工核对边界沿用既有：failed 退避合并、三连失败通知、askFirst 默认七类 | decide.ts 既有语义+测试 |
| 旧 standalone 完整保留（代码+测试+文档），首版不删不改行为 | 任务书 §九 |
| 新目录名 `dsh/`、包名提案 `@iasiv5/dsh-agent-autoloop` | ADR-0001 D2/D7 |
| rules 来源：首版插件配置（profile 内可信配置文件）注入，校验复用 protocol/rules.ts | 审计 §5 差异表第 5 行 |

## 5. 用户确认结论

**第一轮（2026-11-05）已确认**：
- 回执走路径 A（解析最终 assistant 消息 + 复用 contract 校验/修复）。
- 预算硬限=hops≤8 + 单轮时长（默认 180 分钟可配）；累计轮数与费用为软限制（状态如实报告）。
- 数据 profile 级隔离 + 目录锁（第二实例拒绝派发），不导入旧 ~/.agent-autoloop 数据。
- 暂停=桥层停止领取（不写内核事实）；取消=既有 cancel；卸载=disposal 回收+数据保留；关宿主=重启按事实日志恢复。
- 允许最小真实模型 smoke（少量费用、受控资料、临时目录、不触真实业务）。
- 阶段 1–4 验收在独立测试 profile；活 web profile 仅事后经用户明确同意安装（需重启）。

**待澄清（第二轮）**：Q5 入口形态——用户要求 Dashboard 页（偏离工程师推荐）。范围（只读状态页 vs 含操作面板）、与命令入口的关系、宿主 UI 注入可行性证据，待勘察报告回来后第二轮对齐。

**第二轮（2026-11-05）**：UI 注入证据补全（api-mapping §12）后提问 Q8/Q9：
- Q8（Dashboard 范围）：工程师推荐「①轻量面板+命令」；**用户选择「③完整 Dashboard」（含规则编辑、多视图）**——与任务书 §十五「首版不做大型 Dashboard」默认冲突，需用户明确确认覆盖，并确定分期。
- Q9（设计基线确认）：**用户选择「还要修改」，未给出修改点**——第三轮需问清具体修改内容。

**第三轮（2026-11-05）与最终结论**：
- Q10：基线修改点**仅 Dashboard 范围**一项，其余已确认项全部维持。
- Q11：**完整 Dashboard 并入首版**，阶段重排：①可安装原生骨架 → ②面板基础（入口钮+悬浮面板+只读状态 API）→ ③核心闭环（事件→执行→回执→ask/answer→重启恢复→复查→故障窗口）→ ④完整 Dashboard（操作按钮、规则编辑器、多视图）→ ⑤安全、预算、打包与文档。此选择同时构成用户对任务书 §十五「首版不做大型 Dashboard」默认的**有意覆盖**（留痕）。
- grilling 设计树 frontier 已空；设计基线经三轮逐项确认成立，进入实现。

## 5.1 最终设计基线（2026-11-05 确认版）

1. 内核零语义改动复用；新顶层目录 `dsh/` 承载「内核门面 + 原生执行桥 + 宿主交互」；不加载旧 host/worker 外壳；standalone 完整保留。
2. 执行：`ctx.agents.create/resume`；完成证据 = durable `turn/end`（TurnEndReason 判定）；心跳沿用租约语义；并发沿用 group/lane。
3. 回执：路径 A（最终 assistant 消息 + contract 解析/校验/修复≤2 次）。
4. 预算：硬限 = hops≤8 + 单轮时长（默认 180min 可配）；累计轮数/费用 = 软限制（状态如实报告）。
5. 数据：profile 级插件数据目录 + 目录锁（第二实例拒绝派发）；不导入旧 ~/.agent-autoloop。
6. 人工决策：内核卡片不变；用户入口 = Dashboard 面板 + `autoloop` 命令（回答/取消/暂停/why）；模型不得触碰人工入口；业务批准≠工具审批。
7. 暂停 = 桥层停止领取（不写事实）；卸载 = cordis disposal 回收 + 数据保留；关宿主 = 重启按事实日志恢复。
8. 验收：阶段 1 起全部在独立测试 profile；真实模型最小 smoke 已授权；活 web 仅事后经同意安装。
9. 入口：完整 Dashboard（多视图 + 规则编辑器）并入首版（阶段④），面板与命令双入口，面板写操作走自建 `/api` 路由（同源+配对护栏）。

**相对任务书的变更**（全量）：仅「首版交互」一条——任务书默认命令入口、不做大型 Dashboard；经三轮对齐改为「完整 Dashboard 并入首版 + 命令兜底」，其余设计均按任务书执行。
**不阻塞实现的剩余问题**（阶段内实测回填）：session jsonl 物理格式；dispose 移除 session store 的语义；skills 注入途径；`ctx.on` 清理签名；沙箱模式枚举权威定义位置。

## 6. 延后事项

- client UI 注入（缺口 9 证据不足）；真实通道集成；GitHub 交付插件原生迁移；多 profile 并行实例；desktop 支持。

## 7. 验收标准

最终标准（任务书原文）：在不修改 DSH 核心、不启动独立中台、不调用外部 dsh CLI 的情况下，插件能通过宿主自己的会话完成：事件接入、事项编排、人工等待、重启恢复、定时复查和可追溯交付。分阶段验收按任务书 §十六 阶段 0–5 与 §十七 T01–T30 分层执行（确定性内核单测→fake Agent 桥接→真实宿主+fake 模型→隔离 profile 端到端→经授权真实模型 smoke）。

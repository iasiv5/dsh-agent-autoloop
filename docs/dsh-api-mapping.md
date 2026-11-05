# DSH 宿主 API 映射（dsh-api-mapping）

状态：首版定稿候选（基于安装实体逐文件核实；缺口如实列出，未发现的能力不编造）。
版本锁定依据：本机 DSH web 实际运行 `@deepseek-ai/dsh@0.2.2-rc.1`（`<dsh-runtime>/node_modules/@deepseek-ai/dsh/package.json`，engines `node >=24.9.0`；cordis 4.1.0）。兼容性说明锁定到 0.2.2-rc.1，不使用浮动 latest。
证据记法：`P/` = `<dsh-runtime>/node_modules/.pnpm/@deepseek-ai+<包>@0.2.2-rc.1_<hash>/node_modules/@deepseek-ai/<包>/lib/types/*.d.ts`（hash 可 glob 还原）。勘察方式：读安装实体 .d.ts + 两个已装插件实例（`~/.dsh/profiles/web/`）。

## 0. 结论速览

| 任务书能力 | 宿主公开能力 | 判定 |
|---|---|---|
| 1 插件安装与组合 | npm 包 + cordis 入口 `name/inject/apply` + `dsh` 元数据；profile= pnpm workspace，`dsh.profile.bundles` 有序数组 | ✅ 可用 |
| 2 Agent 创建与恢复 | `ctx.agents.create/resume/get/list/turnBoundaryOf/isOwnedBy`，`AgentHandle{agent,dispose}` | ✅ 可用 |
| 3 输入与轮次关联 | `agent.send/followup/steer/inject`；durable 事件 `turn/start`、`turn/end{reason}`、`user/message`、`assistant/message{usage?}` | ✅ 可用（turn 序号持久化） |
| 4 执行结束 | `TurnEndReason`: completed/aborted/blocked/error/max-tokens/interrupted/forked（merge-extensible） | ✅ 可用；`whenIdle()` 仅为静止信号，不作成功证据（与任务书一致） |
| 5 Session 持久化 | `ctx.sessionPersistence`；append=best-effort，**flush 才是 durability barrier**；崩溃恢复补 `interrupted` 收尾事件 | ✅ 可用（「未 materialize 的会话等于不存在」） |
| 6 结构化回执 | 路径 B：`ctx.tools.register`（JSON Schema + scoped + 审批在管线内）；路径 A：读 durable `assistant/message` + 复用 contract 解析 | ✅ 两条都可行，首版择一（对齐项 J） |
| 7 用户操作入口 | `ctx.commands.register(CommandDefinition)`：「不把命令发给模型，直接执行」；`command/run|done` durable | ✅ 可用 |
| 8 工具授权 | `ctx.approval`：`ApprovalPolicy='ask'|'never'`，默认 'ask'，可按 session/agent 设置，`approval/policy` 持久 log-only；agentPreset/permissionPresets 存在 | ✅ 可用（access→宿主权限映射为设计项） |
| 9 卸载与取消 | cordis `ctx.effect`、`ctx.setTimeout/setInterval`（cordis-plugin-timer）；`AgentHandle.dispose` 停循环→等退出→注销→**移除 session store 记录**；provider 卸载会 drain 其创建的全部 live handle | ✅ 可用（卸载语义需明确写入 ADR） |
| 10 定时与后台 | `ctx.schedule`（durable）、`ctx.jobs`、`ctx.goals` 均存在且插件可复用 | ✅ 存在；**不挪用**：事项调度仍由内核 due 表承担（避免第二套语义），宿主定时器仅作 due 表的 arm 机制 |

## 1. 插件安装与组合【已验证】

- 实证样例 `~/.dsh/profiles/web/node_modules/@iasiv5/dsh-quota-watch/package.json`：`"type":"module"`、`"main"`/`exports`、`peerDependencies:{"@deepseek-ai/cordis":"^4.0.2"}`、`dsh:{engines:{dsh:">=0.2.0-rc.1"}, bundle:{patch:"./cordis.patch.yml"}, client:{platform,inject:[...]}}`。无 keywords 要求。
- 兼容规则 `P/dsh-app-boot…/plugin-compatibility.d.ts` `evaluatePluginCompatibility`：**自有 `engines.dsh` 范围单独生效、peerDependencies 被忽略；否则逐个校验 @deepseek-ai/dsh(-*) peers**。
- profile 是 pnpm workspace；宿主读写 API `P/dsh-app-boot…/profile-plugins.d.ts`：`readProfilePlugins()`、`writeProfileBundles(profileDir, manifest, bundles)`。bundle patch：`dsh.bundle.patch`（profile.d.ts:10），合成顺序 bundles patch → cordis.patch.yml → overlays。
- 安装全流程（阶段 A 实测，官方 installer 验证）：`dsh plugin --profile <name> add <pkg>` 初始化 profile 并 pnpm 装依赖；**纯依赖不会被加载**——installer 明确警告 "declares no dsh.bundle — installed as a plain dependency, not a profile layer"。插件必须声明 `dsh.bundle.patch`，installer 才把它写进 profile manifest 的 `dsh.profile.bundles` 并挂载合成层（dump-config 可无挂载验证）。禁用=用户层 `cordis.patch.yml` 写 `- {id, disabled: true}`；卸载=`dsh plugin remove`（移除 bundle 层与依赖清单；link: 目录残留不进合成树、不影响加载）。
- 入口（cordis 插件形态，实证 dsh-command-goal index.d.ts:6-9）：
  ```ts
  export const name = "…";
  export const inject: string[] = […];
  export function apply(ctx: Context): void { … }
  ```
  cordis 4.1.0 类型面 **无 `reusable` 字段**（grep 零命中）。
- 加载器 `P/cordis-plugin-loader@1.1.0…/index.d.ts:66` `class Loader extends EntryTree`。

**对本插件含义**：发布为一个 npm 包（如 `@iasiv5/dsh-agent-autoloop`），`engines.dsh: ">=0.2.2-rc.1"`、peer `@deepseek-ai/cordis ^4.1.0`，入口 apply 内装配全部服务；不经 `dsh.profile.bundles` 手改——安装走宿主插件机制（dshm）。

## 2. Agent 创建与恢复【已验证】

`P/dsh-agent@0.2.2-rc.1_d9740b81…/lib/types/index.d.ts`（下称 agent/index）：

- `ctx.agents: AgentRegistry`（agent/index:19-23，cordis Context 增强）。
- `create(options: CreateAgentOptions): Promise<AgentHandle>`（:292）；`CreateAgentOptions`（:49-106）：`sessionId`（调用方提供，稳定）、`parentAgent?`、`meta?{cwd?, parentSession?, isSeeded?, origin?, delegationDepth?, agentPreset?}`、`inheritedEventCount?`、`seed?: readonly SessionEvent[]`、`agentOptions?: AgentOptions{provider?,model?,reasoningEffort?,maxTokens?}`（runtime-types:27-36）、`signal?`、`setup?`。**没有 prompt/skills/workdir 直接参数**：prompt 走创建后的 `send`，cwd 在 `meta.cwd`，模型在 `agentOptions`。
- `resume(options: ResumeAgentOptions): Promise<AgentHandle>`（:300）：「opens the persisted session for write … must be called after `ctx.sessionPersistence` exists」（:179-189）。不存在 → `SessionPersistenceNotFoundError`；已 live → `SessionAlreadyOwnedError`（session-persistence/index:130-131）【推断：open 契约串联】；同 id 重复 register reject（:302）。
- `AgentHandle{agent, dispose()}`（:145-148）；`Agent`：`id/status('idle'|'running')/inbox/send(target:'next-turn'|'next-step',wakeup)/followup/steer/inject/cancel(cause,opts?)/whenIdle():Promise<void>/model/session/ctx`（runtime-types:163-237）。
- `isOwnedBy(id, owner)`（:366）、`turnBoundaryOf(session)`（:221）——所有权与轮次边界查询可用。

**映射**：`run 领取 → create({sessionId: 桥接生成的稳定 id, meta:{cwd: rule.cwd}})`；`resume → run.resume` 接续（回答/later 延续）；「已 live 不能重复 resume」由 `SessionAlreadyOwnedError` 保证；`dispose()` 所有权在桥（Task 十一 释放本轮资源）。

## 3. 输入与轮次关联【已验证】

- durable（session 日志内，`P/dsh-session…/types.d.ts` SessionEventMap）：`turn/start{turn}`(:268)、`turn/end{turn, reason}`(:279)、`step/start|end`(:284,:289)、`user/message`(:294-300，区分 human/agent.inject/goal continuation)、`assistant/message{turn,step,message,stream,usage?,interrupted?}`(:338)、`tool-call` 系列(:358+)、`agent/inbox/spliced`（dsh-agent/types:97-103）。
- 进程内（非持久化，runtime-types:239-444）：`agent/created|disposed|status`、`agent/inbox/inserted|claimed{agent,message,turn}|discarded`、`agent/pre-step`、`agent/turn-stopping`、`agent/error` 等。
- `TurnEndReason`（session types:170-216，merge-extensible）：`completed` / `aborted{reason: user|parent|hook|disposed|legacy}` / `blocked` / `error{error:LlmFailure}` / `max-tokens` / `interrupted`（崩溃遗留 open turn 的追补收尾）/ `forked`。

**映射**：一次输入的完成证据 = 该 session 的 `turn/end`（带 turn 序号与 reason）；**不用**「最新 assistant 消息」或 `whenIdle()` 猜测结果（任务书 7 项边界成立）。run ↔ (sessionId, turn) 的关联经内核 `started` 输入持久化（session 字段存 DSH sessionId；link 存 `turn:<n>` 引用），见 ADR。

## 4. Session 持久化【已验证】

`P/dsh-session-persistence…/{index,handle}.d.ts`：

- `ctx.sessionPersistence: SessionPersistence`（index:83-87）：`create(header,opts?)`(:119)、`open(id,'read'|'write',opts?)`(:133)、`flush()`(:145 全句柄 barrier)、`stat`(:160)、`list`(:166)。
- `SessionHandle`：`read(offset?,length?)`、`append(events)`（best-effort）、`flush()`（**唯一 durability barrier + materialize**，:89-99）、`close()`(AsyncDisposable)。「a session that never materialized before a crash never existed」（index:98-103）。
- 落盘时机：loop 不在 turn 边界 flush（session types:272-277 明示）；`dsh-session-checkpoint-policy` 在模型请求 dispatch 前/工具记录前做 semantic checkpoint（fail-closed）。
- 崩溃恢复：resume 时对最后一轮未结束的日志补 `interrupted` 收尾事件，此前事件保留（session types:196-204）。JSONL 后端 `dsh-session-persistence-jsonl` 存在（物理格式未读，缺口 3）。

**映射**：任务书 §13 故障窗口的「输入已送达但确认丢失」等场景，对账证据 = session 日志（`open(id,'read')` + `stat`/`read`）；桥在收到 `turn/end` 并提交回执后不主动 dispose，避免误删（dispose 会移除 session store 记录，见 §8）。宿主关闭期间：内核事实已 WAL+FULL 落盘，session 是否 flush 由 checkpoint policy 决定——恢复时以 `turn/end` 有无 + `interrupted` 追补为准，**不把会话对象存在当作可恢复**（resume 失败 → 开新会话接续，内核 resume 语义本来就允许）。

## 5. 工具注册【已验证】

`P/dsh-tools…/{index,contracts}.d.ts` + `P/dsh-llm…/types.d.ts:496-507`：

- `ctx.tools: ToolsService`；`register(definition, options?): () => void`（index:50）——agent scope 内注册即 scoped、shadow 全局；`run_code` 保留名。
- `ToolSchema{name, description, parameters: JSON Schema}`（dsh-llm types:496-507）；`ToolDefinition` + 必填 `output` + `execute(args, exec: ToolRunContext)`（contracts:23-36）。
- 管线：extensible pre-execute policy → **approval** → guards → dispatch（index:133-142）；审批挂点在执行管线内。

**映射（回执路径 B 候选）**：在派发 run 的 agent scope 内注册 `autoloop_receipt` 工具，schema 即 Result 结构，execute 暂存本轮意图；轮次边界（turn/end）统一提交内核 `finish`。工具可被审批/守卫覆盖，模型无法伪造人工批准。路径 A（解析最终 assistant 文本 + contract 校验）同样可行且改动更小——首版择一见对齐项 J。

## 6. 用户操作入口【已验证】

`P/dsh-commands…/{index,types,builtin}.d.ts`：

- `ctx.commands: CommandRuntime`；`register(CommandDefinition): () => void`（index:94）。
- `CommandDefinition{definitionId?, name(无斜杠小写), description, input?{hint,attachments?}, recordInput?(默认 true), handler(invocation)=>CommandResult}`（:38-55）；`CommandResult = {kind:'success',text?,sourceEventSeq?} | {kind:'error',text}`。
- 关键语义（index:53-54）：**「Execute against the receiving agent without sending the command to the model」**——命令是人类入口，handler 直接执行，不进模型上下文；`command/run`/`command/done` durable（recordInput 控制原始输入是否落日志）。内建命令含 goal/plan/feedback/compact/permission/export。
- `dsh-cmdline` 是进程 argv 级 launcher，与 slash 命令无关。

**映射**：首版用户入口用一组命令（如 `autoloop`（状态总览/子动作）、或拆分 `autoloop-status / autoloop-answer / autoloop-pause / autoloop-cancel / autoloop-why / autoloop-later`，命名遵循宿主规范，对齐项 B）。回答决策=命令 handler → 内核 `answer` 输入；**不向模型暴露任何「代答/批准」工具**。

## 7. 权限与审批【已验证（沙箱枚举位置为缺口）】

`P/dsh-user-approval…/index.d.ts`：

- `ctx.approval: ApprovalService`(:20-22)；`ApprovalPolicy = 'ask' | 'never'`(:54)，**默认 'ask'**（:48，无 answerer 时 fail-closed）；`setApprovalPolicy(session, policy)`(:63)、`approval.setPolicy(agent, policy)`(:119)；部署级 `Config.policy`(:93-98)。
- `'approval/policy'` SessionEvent：log-only、durable、可重放、不进模型转录（:26-35）；`approval/decided` 审计配对（types:32-45）。
- `CreateAgentOptions.meta.agentPreset`(:71)、`ctx.permissionPresets`（dsh-permission-presets index:11-13）存在——预设生效机制未逐行展开【推断】。
- 沙箱：`P/dsh-bash-sandbox…/index.d.ts` `SandboxBashExecutor`，fallback root=`workspace-write`（:18-20），「result.sandbox reports the mode」；模式字符串全集的权威定义位置未定位【缺口 7】。

**映射**：内核 `access: read|edit|full` → 桥按对齐结论映射到 `{approval policy, agentPreset/permissionPresets, sandbox}` 组合；默认不给 `full`（任务书：默认不启用 full access；`ask` 策略文本不是强制安全机制，走宿主真实审批管线）。**业务批准（卡片回答）与工具审批（approval）是两条线，不互相替代**。

## 8. 卸载与取消【已验证（ctx.on 清理为推断）】

- cordis `ctx.effect(execute,label?)`（`P/cordis@4.1.0…/fiber.d.ts:161-163`）；定时器 `ctx.setTimeout/setInterval/interval/timeout/throttle/debounce`（cordis-plugin-timer index.d.ts:3-16，返回 disposer，随上下文回收【自动清理属 effect 常规语义→推断】）；`ctx.on` 返回 disposer【推断，未逐行验证】。
- `AgentHandle.dispose()`：「stops the loop, awaits its exit, unregisters the agent, **removes its session from the store**, and finally unwinds its scoped world」（agent/index:136-143）；「provider unload stops and drains every live handle it made」(:133-136)；scoped 工具随 disposal unwind（runtime-types:175-176）。
- `agent/disposed` 在 driver quiescence 后发出（runtime-types:259-269）；`agent/created` 监听器内禁止 `await whenIdle()`（:246-248）。

**映射**：插件停用/卸载 = cordis disposal：桥的 effect 回收全部监听/定时器，主动 `dispose()` 本插件创建的在途 handle（或按对齐项 K 选择「留待宿主 drain」），内核侧这些 run 之后会经 sweep→unknown→通知的既有路径收敛；迟到 `turn/end` 监听随 disposal 失效，不会复活已取消/卸载的执行（内核 cancel_at/终态兜底）。

## 9. 内置调度（存在性核实，不挪用）【已验证/推断混合】

- `ctx.schedule: ScheduleService`（`P/dsh-schedule…/index.d.ts:23-26`「Durable Host-wide reminder management」；`create/list/catalog/deliveryLimits` :78-115；`scheduleDomain` 走 dsh-storage 域 :130；交付经 Session 恢复 :70）——持久化 ✅。
- `ctx.jobs: JobRegistry`（`P/dsh-jobs…/index.d.ts:59`；`start(spec)/list/get/read`；`dsh-jobs-local` 存在）——持久化【推断，未见显式声明】。
- `ctx.goals: GoalService`（`P/dsh-goal…/index.d.ts:18-21,:55`；`dsh-command-goal` 头注释「persisted same-session goal domain」）——goal 持久化于 session 域；goal continuation 以 `user/message` source 出现（session types:294-298）。
- 三者均为 cordis Context 键，插件可复用。**决定**：首版不把事项调度托付给 schedule/jobs/goals——事项模型、重试、合并、hops 由内核唯一承担（任务书「不假设 Schedule=持久事项调度器」）；宿主定时器（`ctx.setTimeout`）只作为内核 due 表的 arm 机制（对应 host/server.ts:76-96 的单一 setTimeout 模式）。

## 10. 缺口清单（未找到/未展开，全部如实）

1. cordis 4.1.0 无 `reusable` 插件字段。
2. `CreateAgentOptions` 无 prompt/skills/workdir 直接参数；skills 注入途径（agentPreset 内容/工具层）未逐行展开——阶段 1 骨架实测。
3. session 日志物理格式与落盘路径（dsh-session-persistence-jsonl 未读）。
4. jobs 持久化无显式类型面声明（推断）。
5. cordis `ctx.on()` 监听清理签名未逐行验证（推断随 owner 回收）。
6. `ToolExecutor/ToolBatchInput/ToolBatchResult` 完整形状未展开（回执路径 B 需补读 executor.d.ts）。
7. 沙箱模式字符串全集的权威定义位置未定位。
8. `ask_user`/user-questions 与 approval answerer 组合细节未展开（人工介入方式对齐项 C 相关）。
9. ~~client 侧 UI 注入~~ → 已补全，见 §12（`dsh.client` 四字段 schema、`exports["./client"]` 约定、68 个 slot、webServer 路由通道均已核实）。

以上缺口不阻塞阶段 0 结论与阶段 1 骨架（骨架加载本身即为缺口 2/3 的实测手段）；若阶段 2+ 撞上硬缺口，按任务书 §7 保守降级并回此清单留痕。

## 11. 验证方式

- 版本：`node -e "console.log(require('@deepseek-ai/dsh/package.json').version)"`（宿主进程内）或读安装实体 package.json【已做】。
- 行为：阶段 1 骨架在目标 profile 实际加载（可启用/禁用/卸载）；阶段 2 fake-agent 桥接测试 + 宿主集成测试（真实宿主、fake 模型）；`turn/end` 关联、`interrupted` 恢复、dispose 语义用最小探针验证后写回本文。

## 12. 客户端 UI 注入能力（2026-11-05 二轮勘察补全）【已验证】

- **声明格式**（`@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts` L82-95）：`dsh.client = { platform: "web", inject?: string[]（包名依赖边，非 cordis 服务注入）, immediately?: boolean, external?: string[] }`；**无 entry 字段**——client bundle 路径由约定固定为 `exports["./client"]`（`dsh-client-modules` resolveMeta L777-795 缺失即报错）。真正的服务注入是 client 模块内 `export const inject = ['slots', …]`（cordis 强制，漏声明拒绝访问）。
- **加载**：宿主合成 `window.__DSH_BOOT__` boot 图，bundle 经 `/plugins/<pkg>/client.js` combo `<script>` 投递，浏览器侧惰性 CJS 模块表（`__ModuleLoader__.load({id,factory})`），`factory(require)` 惰性物化；HMR 由 `dsh-client-hmr` stat-poll+SSE 原地换码。单文件自包含 IIFE（esbuild）；可用宿主 React（`require('react')`，0.2.x shells 用自己的 React 渲染注册组件）。**宿主半同理必须是构建产物**：阶段 A 实测 Node 拒绝对 `node_modules` 内文件做类型剥离（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），installed 入口不能是 `.ts`——本插件以 esbuild 打 `lib/host.js`（已验证可从模拟 profile 布局 import 并加载）。
- **slots**：`ctx.slots.inject(name, () => slots.register({name, id, order?}, ReactComponent))`；68 个 SlotMap 名已枚举。关键位：
  - `sidebar.footer.action`（list）——两个已装插件同款的入口钮位（quota-watch src/client.mjs L1533、skins lib/client.js L2261）。
  - `shell.overlay`（list，additive、默认 click-through、组件内 opt-in pointer events）——registry.d.ts 官方注释钦点 "a surface of your own that floats over the whole app"，**插件自绘面板的正门**；组件内部完全自由布局。
  - `root` 明令禁止插件注册；`sidebar.right.pane.tab` 官方支持外部 tab 类型但第三方「打开」路径未验证（不采用）。
- **client↔host 数据/操作通道**：宿主半 `ctx.webServer.register({kind:'exact', path:'/api/<plugin>/…', handler})`（`dsh-host-webserver`，handler 可挂 SSE）；客户端用文档相对路径 `fetch('api/<plugin>/…')`（web UI 服务于 `<base href="./">`）。配同源+配对护栏（connection 内置 loopback 判定；quota-watch `isPairedOrLoopbackAllowed` 先例）。**无**第三方 client→宿主任意方法的 typert remote 公开通道；自建路由即安全通道。
- **`actionCards.register(kind)`**（宿主 `@deepseek-ai/dsh-action-cards` + client `dsh-client-ui-action-cards`）：会话流内、模型经 `propose_action` 触发的卡片+按钮（Body 有 `act(verb,payload)` 真回程）——是模型发起，不是插件随时召唤的 UI；与本插件「模型不能自行控制人工入口」的原则相性一般，首版不采用。
- **无独立顶级路由/页面注册 API**（如实记录）；「Dashboard 页」的现实形态 = 入口钮 + `shell.overlay` 悬浮面板 + 自建 `/api` 路由。
- **阶段 B 实测补充（2026-11-05）**：①client 模块的 `export const inject: string[]` 是 cordis 服务访问的**执行期强制门**——缺失时报 `cannot get property "slots" without inject` 且宿主 shell 只报 "entry did not activate: failed" 不透出根因（manifest 的 `dsh.client.inject` 不是执行期门，本插件实测缺它也能激活；两者语义不同，前者=cordis 服务声明，后者=boot 图依赖边）；②`sidebar.footer.action` 与 `shell.overlay` 两个 seat 实测可注册、可渲染、可交互，shell.overlay 组件返回 null 时不占视觉；③全新 profile 有「Get started / Preview Notice」引导对话框，其 mask 会拦截全页点击直到关闭——与插件无关的宿主正常行为；④webServer 自建路由实测可用：GET `/api/<pkg>/status` 返回 JSON、跨源 Origin 403。
- **阶段 C 实测补充（2026-11-05，二轮勘察 + 真宿主验证）**：①会话事件订阅走 cordis 总线 `ctx.on('session/event', (session, event) => …)`（Session 非 EventEmitter、无 `ctx.on('turn/end')`；payload 为 `(session, event: SessionEvent)`，`event.data` 即 SessionEventMap 载荷，`event.data.reason.kind` 为 TurnEndReason 判别——goal-round-driver 实证）；②`createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})` 为标准投递（dsh-llm message.d.ts:195；goal 驱动同款）；③`meta.cwd` 只进会话头，工具实际目录必须 `ctx.workingDirectory.set(agent, cwd)`（subagent 实证）；④命令 success.text 回派发 UI + `command/done` log-only 落日志、不进模型上下文；⑤`ctx.timeout` 混入内部读 `timer` 服务——**inject 必须声明 "timer"**，否则 `cannot get property "timer" without inject` 宿主级 fatal（本插件踩实）；⑥`envData` 仅 loader 有且只含 startTime，插件拿 profile 目录无官方途径（数据目录探测链保持自足）；⑦插件打包需携带指纹输入四文件（kernel/evolve.ts、schema.sql、credentials.ts、hub.ts 副本）——既满足 createHub 的运行期读取，也使两壳哈希出相同投影指纹（hub.db 可跨壳迁移，投影免重建）。
- **阶段 B 实测补充（2026-11-05）**：①client 模块的 `export const inject: string[]` 是 cordis 服务访问的**执行期强制门**——缺失时报 `cannot get property "slots" without inject` 且宿主 shell 只报 "entry did not activate: failed" 不透出根因（manifest 的 `dsh.client.inject` 不是执行期门，本插件实测缺它也能激活；两者语义不同，前者=cordis 服务声明，后者=boot 图依赖边）；②`sidebar.footer.action` 与 `shell.overlay` 两个 seat 实测可注册、可渲染、可交互，shell.overlay 组件返回 null 时不占视觉；③全新 profile 有「Get started / Preview Notice」引导对话框，其 mask 会拦截全页点击直到关闭——与插件无关的宿主正常行为；④webServer 自建路由实测可用：GET `/api/<pkg>/status` 返回 JSON、跨源 Origin 403。

**对本插件含义**：若首版包含事项面板：宿主半加 `webServer` 路由（GET 状态快照、POST 回答/取消/暂停，写操作加同源+配对+确认日志），client 半注入 `sidebar.footer.action` 入口钮与 `shell.overlay` 面板；不新造 slot 名、不用 `root`、不走 action-cards。

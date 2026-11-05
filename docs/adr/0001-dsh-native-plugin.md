# ADR-0001：Agent Autoloop 转向 DSH 原生编排插件

状态：已确认（设计基线经三轮对齐于 2026-11-05 获用户确认；唯一边界变更：完整 Dashboard 并入首版，见 docs/dsh-alignment.md §5.1）。
日期：2026-11-04。基线：`3930f09`（分支 dsh-agent-autoloop）。宿主：DSH `@deepseek-ai/dsh@0.2.2-rc.1`（cordis 4.1.0）。
关联文档：docs/dsh-migration-audit.md（审计）、docs/dsh-api-mapping.md（宿主 API 证据）。

## 背景

仓库现状是一个独立事件驱动 Agent 中台：确定性内核（kernel/，事实日志+投影，~1650 行）+ Node HTTP 运行外壳（host/）+ 外部 CLI 接单程序（worker/，spawn detached 进程跑 claude/codex/dsh 等 CLI）。DSH 目前仅是 README 中 `use:"command"` 的一行 CLI 示例（README.md:153），与宿主零代码耦合。

产品目标改为：让 DSH 会话承担可持续跟进的事项——有事件就推进，有阻塞就存档，需要决策才找人。约束（任务书已定，不再讨论）：只在 DSH 宿主运行期内工作；不做独立 daemon；主要编排 DSH 自己的会话；不经授权不推送/发布/真实外呼。

## 决策

### D1 保留确定性事项内核，零语义改动

复用 kernel/{decide,evolve,store,query,due,cron,rules,credentials,state,errors}.ts 与 protocol/{validate,rules,job,schema}.ts。事项模型（rule/lane/grp 隐式事项，见审计 §2）、队列合并、退避重试、回执幂等、hops、cron 补办等可靠性语义原样保留。内核继续不知道任何产品名、不做 IO、不读时钟随机（tests/purity.test.ts 守卫继续有效）。

**不改**内核的前提下能否实现闭环？能：内核的全部输入面（decide.ts HANDLERS）就是执行编排所需的完整状态机——claimNext 产 Job、started 记会话、finish 收回执；执行主体换成谁它不关心（这正是「内核只收、只分、只派、只记」）。

### D2 新顶层目录承载 DSH 原生层（不塞进 host/）

新增顶层目录（名称提案 `dsh/`，对齐项可改）承载三部分，对应任务书架构 A/B/C：
- **A 内核门面**：从 host/runtime.ts 抽出参数化组装（数据目录、规则来源、secret、时钟注入 → execute/getView/why/stateOf），host/runtime.ts 改为薄包装调用同一门面（standalone 行为不变，测试不破）；DSH 门面是同一门面的另一实例化。
- **B 原生执行桥**：领取（直接调门面 execute("claimNext")，不经 HTTP）→ 持久化派发意图（started 输入：session=DSH sessionId，link=`turn:<n>`）→ `ctx.agents.create/resume` 执行 → 订阅 durable `turn/end` 取证（reason 判定 completed/aborted/error/blocked/max-tokens）→ 收集最终 assistant 消息 → 回执校验（复用 worker/contract.ts readMessage/resultFrom 或路径 B 工具，见 D5）→ finish 提交 → handle 所有权收尾。心跳（heartbeat 输入）在派发/回执时顺带提交，保住租约/unknown 语义。
- **C 宿主交互与事件接入**：ctx.commands 用户入口；手动事件（ingest 输入）与 later 复查（timers）接入；due 表的 arm 用 `ctx.setTimeout`（单一定时器模式，对应 host/server.ts:76-96）。

同步守卫（审计 §7.4，缺一不可）：tsconfig include、tests/purity.test.ts 两处目录清单（kernel 清单维持非递归现状不动）、scripts/ci-scope.sh、sim/mutate.ts 沙箱清单、package.json 测试 glob（新目录测试放 tests/ 顶层命名 `dsh-*.test.ts`，不动 glob）。

### D3 原生路径不加载旧运行外壳；standalone 路径保留兼容

- DSH 路径 **禁止 import host/runtime.ts**（其模块加载即 mkdir ~/.agent-autoloop + 打开 hub.db，host/runtime.ts:20-31——误装进插件会私开数据库）。用 D2 的共享门面替代。
- 原生路径不加载：host/{server,http,up,service,config,channels,plugins}.ts、worker/worker.ts、worker/agents.ts（进程模型）、cli/、plugins/（旧发现体系——不在插件内再造第二套安装发现，任务书边界 6/7/8）。
- 保留不动：上述全部旧模块与 CLI（standalone 兼容路径），首版不删除；`dsh --profile headless {prompt}` 等 command 用法对 standalone 用户照旧。

### D4 执行证据与状态判定

完成证据 = 该 (sessionId, turn) 的 durable `turn/end` 事件（docs/dsh-api-mapping.md §3），reason 映射：completed→正常收回执；error/max-tokens→failed（走内核退避合并）；aborted{disposed}→卸载路径；blocked→failed 或人工 ask（对齐项 D）；interrupted→崩溃追补，核对后按结果不明处理（不盲目重做写操作）。`whenIdle()`、「会话空闲」「对象存在」一律不作成功证据。

### D5 回执主路径【待确认——对齐项 J】

- 路径 A（推荐，改动最小）：桥读该轮 durable `assistant/message` 最终文本 → 复用 worker/contract.ts 的 readMessage/resultFrom（```agent-autoloop 代码块 + 首行结局 + parseResult 校验）→ finish 提交。修复复用 repairPrompt（resume 同会话重写最后一条，≤2 次，不重做业务）。零宿主工具面改动。
- 路径 B：agent scope 内 `ctx.tools.register` 注册回执工具（JSON Schema=Result），execute 暂存、turn/end 边界统一提交。结构化更强但多一条工具管线依赖。
首版只实现一个，另一个留 ADR 记录不实现。

### D6 人工决策与入口（2026-11-05 用户确认修订：完整 Dashboard 并入首版）

ask 落卡片（内核不变）→ 宿主内呈现与操作走**双入口**：①完整 Dashboard 面板（client 半 `sidebar.footer.action` 入口钮 + `shell.overlay` 悬浮面板；查看多视图 + 操作回答/取消/暂停；宿主半 `ctx.webServer` 自建 `/api` 路由，同源+配对护栏，见 api-mapping §12）；②`ctx.commands` 用户命令兜底（回答/状态/取消/why）。两条入口都终结于同一批内核输入（answer/cancel/…）。等待人工期间零模型调用、无悬挂工具调用。模型工具与用户入口严格分族；不向模型暴露任何「代答/批准」工具；业务批准≠工具审批（ctx.approval 默认 'ask' 保持宿主管线）。面板为受控配置编辑器（写插件配置 + 复用 protocol/rules.ts 校验），不是通用工作流编辑器。

### D7 依赖与分发隔离

- 发布形态：单个 npm 包（peerDependencies `@deepseek-ai/cordis ^4.1.0` + `engines.dsh ">=0.2.2-rc.1"`；**dependencies 维持空**——purity.test.ts:31-34 守卫不动，宿主能力全部运行时注入，符合「时间环境由外壳注入」的同构原则）。
- 构建产物：宿主半与 client 半都以 esbuild 打成 `dsh/lib/*.js` 随包发布（阶段 A 实测：Node 拒绝对 node_modules 内文件做类型剥离，installed 入口不能是 `.ts`）；构建期 devDependency 仅 esbuild，消费侧无安装脚本。
- 宿主类型只允许出现在新顶层目录；kernel/protocol/ 出现 `@deepseek-ai/*` import 视为架构违规（建议加进 purity 守卫，阶段 1 实现）。
- 不修改宿主核心；不用 spawn dsh CLI 冒充；不启动旧中台进程。

### D8 持久化与升级

- 数据：内核事实库（hub.db 同构 SQLite WAL+FULL + master 类实例密钥文件）放宿主允许的持久化位置，按对齐项 H 的实例边界隔离；不写安装包目录；不自动导入用户旧 ~/.agent-autoloop 数据。
- 多实例所有权：数据目录加锁文件（参考 host/up.ts:17-27 up.pid 模式）；同库多实例写冲突由 commit 的 seq Conflict + BEGIN IMMEDIATE 兜底，但派发所有权必须由锁保证（任务书 T28）。
- 升级：零迁移——投影指纹变化自动从日志重建（store.ts:24-33 既有机制）；插件版本升级不改事实语义时指纹不变、复用投影。
- 卸载：cordis disposal 回收监听/定时器/在途 handle（api-mapping §8）；内核数据保留（对齐项 K 确认保留策略），迟到回调不复活终态 run（cancel_at/终态不可变，invariants.ts:76-78）。

### D9 旧约束的处置

AGENTS.md 原则逐条核对：
- 「内核只收只分只派只记」「文字是资料规则是指令」「一轮不等人」「协议是产品」——继续有效，且被 D1/D4/D6 强化。
- 「没有运行时依赖」——继续有效（dependencies 空，宿主经 peer/cordis 注入）。
- 「没有界面」——按 standalone 语境解释：内核仍无界面；DSH 交互层在新目录，不进 kernel（purity 守卫「无 web/、kernel 无 <script」不变）。
- 「插件统一 plugins/<名字>/」——**仅适用于 standalone 中台**；原生插件是宿主 cordis 插件，两套发现并存但互不加载，ADR 即为书面依据（避免偷偷违反）。
- 「不要再加另一套发现路径」——指事件/Agent/通道插件发现；DSH 插件自身安装走宿主机制，不是第三套业务插件发现。
- AGENTS.md/协议/README 的更新与 ci-scope 调整在阶段 5 文档步完成，不提前删除 standalone 表述。

## 后果

- 正面：~3230 行内核与全套行为测试/模拟/穷举/变异资产直接复用；可靠性语义（幂等、合并、退避、hops）零重写；standalone 与原生两条路径共享一个门面，不发散。
- 代价：host/runtime.ts 需一次参数化抽取（行为不变，由现有 268 用例回归兜底）；新增目录需同步 5 处清单；回执路径 A 依赖读 durable assistant 消息（缺口：jsonl 物理格式未读，阶段 2 用 ctx.sessionPersistence.read 实测）。
- 风险：dispose 移除 session store 记录（api-mapping §8）——桥的 handle 收尾策略必须避免误删仍需 resume 的会话，阶段 2 以探针验证后固化。

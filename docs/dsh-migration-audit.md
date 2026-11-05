# DSH 原生化改造：仓库审计报告（dsh-migration-audit）

状态：定稿候选。内核/外壳/接单为本人逐行审计；外围模块、tests/sim、DSH 宿主 API 为三路并行勘察并经交叉核对后回填（勘察报告全文要点已并入 §4.1、§7 与 docs/dsh-api-mapping.md）。
标记约定：【A=已验证】指本人在基线 commit 上逐行读过代码或跑过命令；【B=设计建议】基于 A 事实提出，需对齐确认；【C=待验证】必须经本地 checkout 或锁定宿主版本核实。

## 0. 基线

- 仓库：https://github.com/iasiv5/dsh-agent-autoloop，本地 <repo>
- 远端默认分支：`main`；`dsh-agent-autoloop` 分支本地与远端都不存在（case C）
- 开发分支：`dsh-agent-autoloop`，自基线创建：`3930f09770822678ab7b695dcb622939dc89f5f9`（2026-11-04 15:35 +0800，「测试改成条件等待，修掉压力下偶发失败的 loop 和 worker 测试 (#33)」）
- 工作区状态：切换后干净（仅后续新增 docs/ 本审计文档）
- 环境：Node v24.20.0 / npm 11.19.0 / pnpm 10.34.5 / git 2.43.0；宿主（DSH）本机安装版本 `@deepseek-ai/dsh-harness-dev-context@0.2.2-rc.1`（cordis 4.1.0）
- 依赖：`npm ci` 退出码 0（5 packages；package.json 无任何 install/prepare 脚本，仅 devDependencies: @types/node 26.6.4 / prettier 3.9.10 / typescript 7.0.2）
- 基线测试（修改前）：
  - `npx tsc -p .`（typecheck）退出码 0【A】
  - `npx prettier --check "**/*.{ts,json,yml}"` 退出码 0【A】
  - `test:quick`（除 simulation 外全部）：291 tests，289 pass / 0 fail / 2 skipped，退出码 0【A】
  - 完整 `npm test`（含固定种子 20 万步模拟与穷举）：296 tests，294 pass / 0 fail / 2 skipped，退出码 0，耗时约 17 分钟【A】
- engines：node >=24；`"type":"module"`；无运行时依赖（tests/purity.test.ts:31-34 强制 `dependencies == {}`）

## 1. 真实调用链【A】

一条本地事件的完整生命周期（全部在单一 Node 进程内完成；单机部署下三口子也走同一 HTTP 协议）：

```
POST /v1/events（host/http.ts:65-78 把 Node req 变成 Request）
  → kernel/http.ts route (208-242)：Bearer 密钥 → whose() 查 keys 表（kernel/credentials.ts:14-21）
  → act("ingest")（kernel/http.ts:77）→ host/runtime.ts execute()（95-105）
  → kernel/store.ts commit()（34-44）：BEGIN IMMEDIATE → decide() → INSERT facts → evolve() 更新 projections → COMMIT
  → kernel/decide.ts ingest()（168-184）：
      parseEvent（protocol/validate.ts:46-78：字段白名单/长度/subject 字符集/link ASCII）
      → 去重：events 表 (source,key) 已存在则 duplicate:true（decide.ts:170-171）
      → 规则匹配 typeMatches（kernel/rules.ts:22-25）→ enqueue()（136-146）
  → 事实落库后 host/server.ts onChange → arm() 按 due 表最早时刻 arm 定时器（76-96）
  → 接单程序 GET /v1/work?claim=<uuid>&running=…（长轮询，kernel/http.ts:140-156 work()）
      每次轮询先 act("heartbeat") 记 seen + 刷新在跑 run 的 seen_at
  → decide.claimNext()（234-256）：
      可领取 = queued ∧ not_before≤now ∧ agent 属此 worker ∧ 同 grp+lane 无 claimed ∧ 同 grp claimed 数 < groupLimit
      同 claim 幂等：先找 held（同 claim 且同 worker 的 claimed run）→ 返回同一份 Job
      token = HMAC(env.secret,"run",id,issued=seq)（credentials.ts:9-12），重复 claim 重新签发、旧的失效
  → Job（kernel/query.ts jobOf 73-118）：规则取 claimed 时的 rules_version 版本；context 组装 events/answers/timers/waiting/open/decided
  → worker/worker.ts start()（238-265）：先原子写 entry.json（save 79-83）再写 context.json（资料文件）
      → adapter.command(turn)（worker/agents.ts:27-36）→ spawn 脱离进程组的 /bin/sh 包装（launch 177-231）
      → Agent 最后一条消息 = 回执；退出码写 exit-N 文件
  → worker check()（339-395）：读 exit 文件/ps 活性 → conclude()（287-336）
      → readMessage（worker/contract.ts:91-120：第一行结局 + ```agent-autoloop 代码块）
      → resultFrom → parseResult（protocol/validate.ts:143-175）
      回执读不懂：repairPrompt 重写最后一条消息（最多 2 次，contract.ts:71-73；worker.ts:324-334），仍失败 discardReceipt（272-284）保留第一行结局 + 通知卡片，不重做业务
  → settle()（407-420）：POST /v1/runs/<id>/result；HubError 5xx 保留 entry 下轮重交，4xx 丢弃并记录
  → decide.finish()（342-369）：
      重交幂等：last_issued token 匹配 ∧ 内容哈希相同 → duplicate:true 返回上次 rejected；内容不同 → Conflict 409
      failed → retryLater（259-290）：退避 5min×2^(n-1) 封顶 60min；同 thread 排队 run 及其事件并进来；只 notice 生效；第 3 次连续失败发通知
      cancelled → 终态（359-366）
      done/nothing → applyReceipt（309-340）：resolve 仅限 openInScope；ask/notice 落卡片（key=`thread:rule:lane:name` 去重）；later 落 timers（同 key 改期/取消）；events 须规则 emits 许可、hops+1 再 ingest
  → 通道 GET /v1/cards/next 长轮询 → decide.nextCard（400-419，RESEND_AT 表重发）
  → 送达 delivered/失败 failed（520-538）；人回答 answer（371-398）：
      通道回答须 answerers 名单 ∧ delivery.ref 与发出一致；首答生效（非 open 直接 changed:false）
      ask 回答 → recordEvent(`card:<id>`, card.answered, hops=card.hops) → enqueue(rule, eventId, lane, resume=卡片.session) 下一轮
  → 下一轮 claimNext 时 jobOf 的 session 取 run.session ?? run.resume（query.ts:93）→ 接续会话
```

时钟入口：唯一 setTimeout 挂在 due 表最早时刻（host/server.ts arm 76-96）；tick 输入（decide.ts:422-452）处理 cron 到期（只补最近一次 `latestBefore`，key=`规则名@时刻` 去重）、timers 到期（event_id 置位防重复）、sweep。

## 2. 核心实体与状态【A】

**没有独立「事项」表。** 事项 = `rule + lane` 隐式表达（decide.ts:137 `lane = rule.parallel ? subject : ""`）：

| 实体（投影表） | 键 | 状态/字段 | 语义 |
|---|---|---|---|
| events | 自增 id；(source,key) 唯一 | hops、routed | 原始事实；内部事件 id 形如 `card:N`/`timer:N`/`规则名@ISO`，冲突加 `:N` 后缀（decide.ts:149-166） |
| runs | 自增 id | state: queued→claimed→done/nothing/failed/cancelled；sweep 可置 unknown；grp/lane/session/resume/attempts/claim/issued/last_issued/last_result/last_answer/cancel_at/rules_version | 一轮执行=一行；事项=同 (rule,lane) 的轮序列 |
| run_events | (run_id,event_id) | — | 事件→轮的多对多；合并与追踪的枢纽 |
| cards | 自增 id；key 去重 | state: open→decided→done / closed；kind: ask/notice；version | 提问/通知；`thread:rule:lane:name` 同 key 开卡不重复 |
| deliveries | (card_id,channel) | tries/first_try_at/not_before/given_up/ref/version | 每通道投递账本 |
| timers | 自增 id；(rule,lane,key) | event_id=null 待触发；session/hops/about/at | later 复查；触发即置 event_id，只触发一次 |
| schedules | rule 主键 | cron/next_at | cron 游标，错过只补最近一次 |
| seen | (kind,name) | seen_at | worker/channel 心跳在线判断 |
| keys | (kind,name) | hash（SHA-256） | 访问密钥只存哈希 |
| config | "rules" + 每版本一份拷贝 | value/version | 规则版本；claim 后的 run 按 rules_version 读旧版（evolve.ts:218） |
| due | (kind,key) | at | cron/later/retry/delivery/offline/lease 六类到期（due.ts:14-53），外壳只挂一个定时器 |

事实日志：`facts(seq, fact JSON)`；`Fact = {version,seq,at,type,changes:[{table,key,row|null}]}`（evolve.ts:19）。投影 `projections(collection,key,data)` + `projection_meta(seq,next,format指纹)` + `projection_refs`（why 时间线索引）+ `projection_pending`（通道重派派生索引，evolve.ts:229-235）。

## 3. 审计十二问的回答【A】

1. **调用链**：见 §1。
2. **事项身份**：无独立实体，隐式于 rule/lane/grp；cards/timers 用 `thread:` key 挂到事项。claimable 的并发判定（decide.ts:239-245）：同 grp+lane 互斥，同 grp 总数 ≤ `groupLimit(grp)`（= 拥有该 group 名的第一条规则的 parallel ?? 1，decide.ts:238）。
3. **确定性边界**：decide/evolve/store/query/rules/cron/due/state/card-page/credentials 为确定性计算（时钟/密钥/随机由外壳注入；purity.test.ts:41-49 禁 kernel 用 Date.now/Math.random/randomUUID/process.env/node:fs/setTimeout）。外壳 = host/*（SQLite 连接、WAL+FULL、master.key、HTTP、定时器、rules 文件 watch、launchd/systemd 服务）、worker/*（子进程、文件账本、hub 客户端）。
4. **事务边界**：`commit()` 一个 `BEGIN IMMEDIATE` 内完成「重读最新 seq（不一致抛 Conflict）→ decide 产事实 → INSERT facts → evolve 更新投影」（store.ts:34-44）。重建：`projection_meta.format` 指纹 = digest(evolve.ts+schema.sql+credentials.ts+runtime.ts 源码 + digest(secret))（runtime.ts:61-65），不匹配或无 meta 时同一事务内逐条流式重放日志重建（store.ts:24-27），不整读内存、不覆盖新提交。
5. **claim/token/attempt/session/resume**：claim=接单端生成的 UUID，同 claim 取回同一份活（幂等）；token 绑定 (run, issued=claim 时事实 seq)，重复领取重签、旧 token 立即失效；attempt=run.attempts+1 仅是代次展示+工作目录名；session/resume=Agent 会话接续优化（接不上开新的）。这些语义同时服务协议与幂等，原生桥可整体复用（token 机制不必走 HTTP 也能保留幂等核）。
6. **合并与并发**：排队合并=enqueue 找同 (rule,lane,queued) 复用（decide.ts:140-143）；执行期间新事件因 claimed 不属 queued 而落成同 lane 新排队 run，被 claimable 的同 lane 互斥挡住，直到当前轮终态；retryLater 把同 thread 排队 run 的事件并入存活 run（decide.ts:266-276），原始事件不丢（run_events 只增链接，events 行不删）。
7. **规则更新**：`rules` 输入 → config 新版本 → 仅对 queued run assignQueued（重定 agent/rules_version，换 agent 清 session，decide.ts:94-100,456-460）；claimed run 保留领取时版本（jobOf 用 configuration(view,run.rules_version)）；回执校验（emits/tell）用提交回执时的现行规则（applyReceipt/cardFromReceipt 用 ruleNamed=configuration(view)）。
8. **失败语义**：failed=退避重派+合并+只许 notice；cancelled=终态不重派（取消由 cancel 输入置 cancel_at，worker 轮询 cancels() 确认进程组死透后才交 cancelled，worker.ts:397-404）；unknown=在线但 5 分钟没心跳的 claimed run（sweep），放开组并通知，迟到的 finish 仍收（heldRun 允许 claimed|unknown，decide.ts:350）；结果提交失败：5xx 留账重交（幂等），4xx 丢弃留痕；执行成功但提交前崩溃：entry.json 已落盘，重启接着交。
9. **contract**：promptFor 只放中台自证字段（sourceName/type/subject/link，入库时已过字符集白名单），正文资料全在 context.json；readMessage 解析第一行结局词（没跑成/没事可做）+最后一个 agent-autoloop 代码块；修复=只重写最后一条消息（resume 同会话、不许调工具、≤2 次），失败保留原结局+通知，不重做业务。
10. **回执控制项**：同一 Fact 内原子生效；ask/notice 同 key 去重（open 卡存在即跳过）；resolve 限 openInScope（同 grp+source、claimed_at 之前创建，越界进 rejected 不影响本轮）；later 同 (rule,lane,key) 改期/cancel；events 须规则 emits 白名单；failed 轮 ask/resolve/later/events 全部拒绝（retryLater:277-280）；重交幂等见 §1。
11. **因果链与 hops**：回答事件 hops=card.hops；timer 事件 hops=timer.hops；回执派生事件强制 max(本轮事件 hops)+1（decide.ts:102,336）；>8 只记录不派发并一次性通知（once 卡）。why() 用 projection_refs 反查相关事实 seq 输出时间线（runtime.ts:227-250）。
12. **测试**：行为规格集中在 tests/{kernel,events,runs,cards,schedule,hops,cron,rules,schema,contract,projection,stream}.test.ts 与全套 sim/（20 万步模拟 + 8!=40320 序穷举 + 真进程 SIGKILL + 23 条变异检出率 ≥95%）；详表见 §7。内核语义测试只 import kernel/protocol + 内存视图，可整体随内核搬走；HTTP/worker/CLI/安装类测试绑旧外壳，迁移时重写等价断言。

## 4. 文件与职责映射【A】

| 文件 | 行数 | 职责 | 原生化归类 |
|---|---|---|---|
| kernel/decide.ts | 541 | 全部输入处理器：ingest/rules/claimNext/finish/answer/tick/sweep/cancel/… | **复用**（不改语义） |
| kernel/evolve.ts | 254 | View/fork、SQL 投影读写、evolve 唯一投影写入者、指纹 | **复用** |
| kernel/store.ts | 44 | 事务、日志追加、重建、openView | **复用** |
| kernel/query.ts | 131 | jobOf/openInScope/cancels/cardView/why 读模型 | **复用** |
| kernel/due.ts | 53 | 六类到期计算 | **复用** |
| kernel/cron.ts | 128 | 五段 cron、时区/DST/补最近一次 | **复用** |
| kernel/rules.ts | 27 | 规则类型与匹配（可信配置） | **复用** |
| kernel/state.ts | 135 | /v1/state 汇总读模型 | 复用（桥接 status 命令可复用 tally/spending） |
| kernel/http.ts | 257 | HTTP 门：鉴权/限长/输入→decide 输入 | 原生路径**不加载**；保留为 standalone 兼容路径 |
| kernel/card-page.ts | 55 | 卡片链接表单页（唯一页面） | 首版不启用（DSH 内用宿主交互） |
| kernel/credentials.ts | 21 | HMAC token/digest/whose | **复用** |
| kernel/errors.ts | 5 | InputError/AuthError/Conflict/NotFound | **复用** |
| kernel/schema.sql | 126 | 只读 SQL 视图列声明（非业务实体表） | **复用** |
| host/runtime.ts | 259 | 外壳组装：HOME/master.key/db/视图/execute()/rules 重载/keys/why | **需抽取**：参数化（数据目录、规则来源、secret 注入）供两个外壳共用 |
| host/server.ts | 142 | Services 实现：due 定时器、长轮询唤醒、SSE、webhook 适配 | 参考其 arm()/onChange 模式；原生路径不加载 |
| host/http.ts | 38 | Node http ↔ Request 适配（≤50 行受 purity 守卫） | standalone 专属 |
| host/up.ts | 95 | 单进程组合 hub+worker+channels、up.pid 单实例锁 | 原生路径不加载；锁模式参考 |
| host/service.ts | 120 | launchd/systemd 安装/卸载 | standalone 专属 |
| host/config.ts、home.ts、channels.ts、plugins.ts、version.ts | 145 | config/HOME/通道加载/插件发现/版本 | plugins.ts 的「安装目录优先」发现属旧体系，原生路径不建第二套 |
| worker/worker.ts | 495 | 领取循环、脱离进程、心跳、停止、恢复、回执修复、settle | **替换**（原生执行桥接管其职责：无进程组/文件账本/HTTP 轮询） |
| worker/contract.ts | 141 | promptFor/readMessage/resultFrom/repairPrompt | **复用**（回执主路径 A 直接用） |
| worker/agents.ts | 71 | Adapter 接口与插件发现 | 原生路径不加载（外部 CLI 适配器）；类型定义可参考 |
| protocol/validate.ts | 175 | parseEvent/parseResult/addUsage/dateTime | **复用** |
| protocol/job.ts | 47 | Job 类型 | **复用** |
| protocol/client.ts / conformance.ts / rules.ts / schema.* | — | HTTP 客户端、一致性检查、规则文件校验、JSON Schema | rules.ts **复用**（可信规则校验）；client/conformance 为 standalone 协议件 |
| cli/ bin/ | — | 子命令、MCP、why/spend/try/uninstall | standalone 专属；命令形态迁移到 DSH 用户命令 |
| plugins/claude|codex|acp|command | — | 外部 CLI Agent 适配器 | 原生路径不加载（保留 standalone 用） |
| plugins/delivery | 10 文件 | GitHub 交付流水线 | 首版不启用（任务书：首版不做完整 GitHub 自动交付） |
| plugins/desktop|feishu|webhook|github | — | 通道与事件源 | 首版不启用 |
| install.sh / host/service.ts / cli/uninstall.ts | — | 安装/服务/卸载 | 不适用于 DSH 插件分发 |

### 4.1 外围模块勘察结论（protocol/cli/plugins/examples/docs）【A，委托逐行勘察】

**协议层是全仓最干净的可搬运资产**：protocol/{schema.json(900 行,24 个 $defs),schema.ts(零依赖校验器),validate.ts,rules.ts,job.ts,conformance.ts} 零产品名零依赖。client.ts 是 14 个 HTTP 门的 fetch 封装（client.ts:32-58），若原生桥不走 HTTP 则只取其端点语义。

**插件机制真相**（host/plugins.ts:7-13）：发现只有一条路径——`plugins/<name>/{agent,channel,source}.ts`，`find(existsSync)` 安装目录优先，无 manifest 无注册表；`agent-autoloop add` 只 `git clone` 到 `~/.agent-autoloop/plugins/<name>`（main.ts:512-525），不装依赖不跑脚本。三接口签名：Adapter `{command(turn),read(stdout,code,stderr),link?,check?}`（agents.ts:27-36）；Channel `(ctx:{hub,options,log,signal})=>Promise<void>`，hub 仅 nextCard/delivered/failed/answer 四法（channels.ts:21-26）；Source 同步纯函数 `({headers,body,secret})=>EventInput[]`，抛错一律 401（server.ts:56-68）。

**access 三档已有四种成熟翻译**：claude `{read:plan,edit:acceptEdits,full:bypassPermissions}`→`--permission-mode`（claude/agent.ts:8）；codex `{read-only,workspace-write,danger-full-access}` 经 `-c sandbox_mode=… -c approval_policy=never`（codex/agent.ts:6,21-25）；ACP 在桥接层按工具种类+cwd realpath 裁决（acp/bridge.ts:14-26）；command 不翻译（SKILL.md:59）。会话 resume：claude `--resume/--session-id`、codex `exec resume`、ACP `session/load|new`，会话号经 `started` 上报进 why 时间线。

**与 DeepSeek Harness 的现状耦合 = 零代码**：全仓仅 README.md:153（`dsh --profile headless {prompt}` 一行示例，且自注「还没有逐个跑过」）与两张架构图的举例文字提到 DSH。

**cli/**：22 个子命令（main.ts:541-568 分派）；MCP 恰七个工具 status/why/answer/resolve/stop/emit/tell，按本机已有密钥显隐（mcp.ts:28-39）；uninstall 只删指向自身的链接/服务/app，数据全保留（uninstall.ts:11-20,43-46）。`why`/`spend` 是事实日志与 /v1/state 之上的纯格式化，语义可复用但类型与 kernel（Fact/Row/Rule/Spending）强耦合——复用须连内核一起。

**delivery 插件**（首版不启用，模式参考价值高）：poll.ts 稳定事件 id=`${repo}#${number}:${标签事件}:${head}`（poll.ts:5-25,input.ts:43）；delivery.ts 是「读回确认」式状态机（关闭 automerge→main 读设置→快照审查→等完整检查→复核标签/main/审查→squash 合并→Ship+健康版本核对），与内核的唯一接口是普通回执（stdout 的 agent-autoloop 围栏），不直连中台 HTTP。

**外围三栏归类**（详表见勘察报告）：
- 可复用：protocol/schema.json、schema.ts、validate.ts、job.ts、rules.ts、conformance.ts；cli/try.ts、spend.ts、why.ts（纯格式化）
- 需适配：claude/codex/acp/command 四 Adapter 的 access 映射与 resume 约定（进程模型换 DSH）；delivery 状态机/稳定 id/无 checkout 审查（模式）
- standalone 专属：cli/main.ts、bin/、uninstall、mcp 外壳；desktop/feishu/webhook 通道；install.sh、INSTALL、SKILL.md、examples/、README.en.md

## 5. 目标行为差异（standalone → DSH 原生）【B，待对齐】

| # | standalone 现状 | 原生目标 | 差异处理 |
|---|---|---|---|
| 1 | 独立进程 + launchd/systemd 常驻 | 只在 DSH 宿主运行期内工作，宿主退出即停 | 宿主关闭期间不执行；重启后按事实日志恢复（内核天然支持） |
| 2 | HTTP + JSON 三口协议，密钥四类 | 插件进程内直调内核门面；无 HTTP、无 Bearer 密钥 | 保留事实日志/回执幂等语义；token 机制退化为进程内 HMAC 幂等核 |
| 3 | worker=另一台电脑上的接单程序，脱离进程组跑 CLI | ctx.agents 原生会话执行，无子进程账本 | 「结果不明」语义改为：宿主侧 turn 结束原因 + 派发意图持久化核对 |
| 4 | 通道=飞书/钉钉/webhook/桌面通知 | 首版用 DSH 宿主内交互（命令/面板）呈递 ask/notice | cards/deliveries 投影保留；投递账本可挂「dsh」虚拟通道 |
| 5 | rules.json 文件 + mtime watch | 插件配置注入可信规则（宿主 profile 内） | 规则校验仍走 protocol/rules.ts；规则版本语义不变 |
| 6 | AGENT_AUTOLOOP_HOME 数据目录 | 宿主允许的持久化位置，按实例边界隔离 | 待宿主 API 勘察结论（C） |
| 7 | 密钥四类 + master.key | 无跨进程密钥需求；master.key 换为实例密钥文件 | 保留 HMAC 推导，密钥不进事实日志（safeFact 已滤 keys 表） |
| 8 | 心跳/租约（2min fresh/5min lease/10min offline） | 同事务内核不变；「心跳」由桥在派发/回执时顺带提交 | unknown 语义保留，避免宿主内误报 |

## 6. 已验证事实 / 设计建议 / 待验证假设

**已验证（A）**：§0-§4 全部带 file:line 的结论；purity.test.ts 守卫清单（kernel 无厂商名/无外呼/无时钟随机/dependencies={}、仅 evolve 写 projections、仅 store.ts 追加 facts、host/http.ts ≤50 行；生产目录清单硬编码 `["kernel","host","protocol","plugins","worker","cli"]`——**新增桥接目录必须同步加入该清单**，tests/purity.test.ts:52）。README.md:153 证实现状：DSH 仅以外部 CLI 方式接入（`dsh --profile headless {prompt}`），是任务书明令替换的路径。

**设计建议（B）**：见 §5 与 ADR 草案（另文）。要点：内核零改动实现最小闭环（桥按现有输入驱动）；新顶层目录承载执行桥/门面/交互，并纳入 purity 与 ci-scope 守卫；从 host/runtime.ts 抽参数化门面而非复制。

**待验证（C）**：
1. ~~DSH 插件分发格式、ctx.agents 签名、turn 事件持久化边界~~ → 已核实并落 docs/dsh-api-mapping.md（0.2.2-rc.1 安装实体 .d.ts + 已装插件实例对照）【A】
2. ~~node:sqlite 可用性~~ → 宿主 `@deepseek-ai/dsh@0.2.2-rc.1` 声明 `engines: node >=24.9.0`【A】（node:sqlite 自 Node 22.5+ 可用，风险解除；插件进程内实际可用性仍以阶段 1 骨架加载实测为准）
3. ~~tests/sim 行为规格清单~~ → 已回填 §7【A】
4. ~~完整 npm test 基线~~ → 已完成，见 §0【A】

## 7. tests/sim 行为规格清单【A，委托勘察】

### 7.1 保留判断总表

**必须保留（纯内核语义/内核+存储，与外壳无关）**：kernel（decide 不改输入/重放确定/重放与投影同事务/陈旧写入者 Conflict，kernel.test.ts:19-258）、events（去重+路由，events.test.ts:51-60）、runs（队列/合并/并发/回执/取消/unknown，502 行最大内核测试，runs.test.ts:44-489）、cards（状态机/回答人/ref/resolve 越界，cards.test.ts:48-335）、schedule（cron 补最近一次/later 生命周期，schedule.test.ts:33-159）、hops（hops.test.ts:13-44）、cron（DST，cron.test.ts:47-58）、rules（校验+热加载，rules.test.ts:44-171）、schema（schema.test.ts:9-70）、contract（指令数据分离/首行结局/回执解析，contract.test.ts:53-179）、projection（指纹复用与重建/高水位，projection.test.ts:12-60）、stream（why 时间线/重连/不泄密，stream.test.ts:26-136）、status-cost（口径部分）、purity（架构守卫）、simulation+全套 sim/、crash-smoke。

**测旧 standalone 外壳，迁移时退役或重写等价断言**：HTTP 门面（http、key-remove、conformance、benchmark、mcp）、CLI（join、version、try、loop、browser-handoff）、安装冒烟（install、uninstall）、插件加载（plugins、channels、desktop、example-plugins、webhook-templates、delivery-*）、worker 子进程类（worker、worker-path、worker-login-shell、acp、adapters——worker 语义随原生桥保留时重写为 fake-agent 桥接测试）、文档一致性（recipes、business-recipes、examples）。

### 7.2 行为→测试映射（节选，勘察报告含全部 file:line）

事件去重 events.test.ts:51-60；排队合并/执行期新事件进下批 runs.test.ts:132,167 + cards.test.ts:88,106；group/lane 并发 runs.test.ts:59,151 + invariants.ts:38-45 + 变异 mutate.ts:11-12；claim 幂等 runs.test.ts:112-129；规则版本（排队重定/已领取保留/重试当次版）runs.test.ts:79 + kernel.test.ts:52 + stream.test.ts:71；失败退避+三连失败通知 runs.test.ts:193,323 + mutate.ts:19；回执重放幂等/409 runs.test.ts:375-405 + kernel.test.ts:34,258；failed 轮控制失效 runs.test.ts:385-400；ask key 去重 cards.test.ts:48,317；回答一次/回答人/ref cards.test.ts:119-159 + mutate.ts:28-30；resolve 越界 cards.test.ts:162,208；later 同 key 改期取消 schedule.test.ts:126-157；cron 补最近一次/DST schedule.test.ts:53 + cron.test.ts:47-58；hops hops.test.ts:13-44；usage 缺省不当零/不重复计量 runs.test.ts:44 + status-cost.test.ts:60-84；worker 停止/强杀/结果不明 worker.test.ts:213-561 + runs.test.ts:408,432 + sim/crash.ts；回执修复不重做业务 worker.test.ts:426,492 + contract.test.ts:179；指纹重建 projection.test.ts:37-58 + kernel.test.ts:169；密钥撤销 key-remove.test.ts:22-33 + stream.test.ts:87,96。

### 7.3 sim/ 构件

random.ts（种子化 20 万步，每 128 步重建 World=模拟重启，12 类操作轮转，全内存）；enumerate.ts（8 个动作 8!=40320 全序，全内存）；crash.ts（**唯一真实 SQLite**：WAL+FULL，真进程 SIGKILL，核对 integrity_check/已 ack seq 在日志/投影==快照/openView==rebuild/重发 duplicate 不产新事实）；mutate.ts（23 条 kernel 变异，基线须过且 >50 测试，先语法检查再算检出，检出率 ≥95%）；invariants.ts（独立重放 oracle 八条不变量：快照==重放、seq 连续、无重复事件、同 (grp,lane) 至多一个 claimed、组内 ≤parallel、每个事件每条 routed 规则有 run_events 链接、已答卡有唤醒链接、已落盘事实/已答卡/终态 run 不被改）；world.ts（fixture 规则与 recover/alarm 驱动）。

### 7.4 目录结构硬编码风险（新桥接目录必须同步维护的 5+3 处显式路径表）

1. **tsconfig include 显式清单**（tsconfig.json:14-26）——新目录不加进去则 `tsc -p .` 静默跳过。
2. **purity.test.ts 两处**：kernel 文件清单 `readdirSync(root/kernel)` **非递归**（purity.test.ts:9-11，kernel 加子目录即漏扫）；生产目录清单 `["kernel","host","protocol","plugins","worker","cli"]`（:52）——新目录不在内则绕过「仅 evolve 写 projections/仅 store 追加 facts」守卫，必须扩清单。
3. **ci-scope.sh 未归类=full**（scripts/ci-scope.sh:21-28）——新目录会全量跑 CI（不漏但重）；按 AGENTS.md 要求同步此脚本。
4. **mutate.ts 复制清单**（mutate.ts:64,79-84）固定 7 个测试文件与 kernel/protocol/host/tests 沙箱——内核语义迁移后需同步，否则 95% 检出率门槛失去覆盖。
5. **测试 glob 只收顶层** `tests/*.test.ts`（package.json:19）——新子目录测试静默不跑；test:nightly 的 sim/*.test.ts 同理。

另有 3 处次要：③ 处已含；测试 helpers 的 import 顺序假设（AGENT_AUTOLOOP_HOME 必须在 import 生产模块前设置，helpers.ts:8-15）；SQLite DDL 在 kernel.test.ts:38-39 与 sim/crash.ts:17 手写重复；~13 个测试直接 import host/runtime、worker/contract、cli/* 外壳模块（改目录即断约）。

## 8. DSH API 映射

另见 docs/dsh-api-mapping.md（勘察中）。

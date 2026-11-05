# 最终交付报告（dsh-delivery）

状态：阶段 A–D 完成并验收；阶段 E 完成（安全/预算/打包/文档），真实模型 smoke 待活宿主安装安排（已授权、未执行——诚实标注）。
工作分支：`dsh-agent-autoloop`（自 main 基线 `3930f09770822678ab7b695dcb622939dc89f5f9` 创建）。**未推送、未发布、未创建 PR、未修改 DSH 核心、未启动独立中台、未调用外部 dsh CLI 冒充原生集成。**

## 1. 实际工作分支与基线

- 分支 `dsh-agent-autoloop`；基线 `3930f09`（2026-11-04）；宿主兼容锁定 `@deepseek-ai/dsh@0.2.2-rc.1`（engines.dsh `>=0.2.2-rc.1`，cordis 4.1.0，Node ≥24.9）。
- 隔离验证环境：临时 `DSH_HOME` 全新 profile（与活 web 完全隔离，验收后即删）。

## 2. 用户确认的设计（三轮 grill 对齐，docs/dsh-alignment.md §5.1）

路径 A 回执；预算硬限=hops≤8+单轮时长（轮数/费用软限制如实报告）；profile 级数据隔离+目录锁；桥层暂停（不写内核事实）+卸载 disposal 回收+数据保留；允许最小真实模型 smoke；阶段 1–4 独立测试 profile 验收；**完整 Dashboard 并入首版**（用户有意覆盖任务书「首版不做大型 Dashboard」默认，已留痕）；阶段重排 A骨架→B面板→C闭环→D完整Dashboard→E安全打包。

## 3. 复用 / 替换 / 保留（对照任务书 §十九）

- **复用（零语义改动）**：kernel/ 全部（decide/evolve/store/query/due/cron/rules/credentials/state/errors）+ protocol/{validate,rules,job,schema}+ worker/contract.ts（回执解析/修复）。可靠性语义——去重、排队合并、group/lane 并发、claim/token 幂等、规则版本、退避重试、hops、cron 补最近一次——全部原样。
- **抽取**：host/runtime.ts → 参数化 [host/hub.ts](host/hub.ts)（行为不变，307 项回归兜底）；`jobOf` 新增供重启恢复。
- **替换**：worker/worker.ts 的进程模型（claim/spawn/心跳/停止/结果账本）→ [dsh/src/bridge.ts](dsh/src/bridge.ts)（ctx.agents + durable `session/event`/`turn/end`）；HTTP 三口协议 → 进程内门面直调 + webServer 自建路由。
- **保留未加载**（standalone 兼容路径完整保留，原生路径零引用）：host/{server,http,up,service,config,channels,plugins}.ts、worker/{worker,agents}.ts、cli/、plugins/、install.sh。DSH 路径禁止 import host/runtime.ts（其模块加载即私开 ~/.agent-autoloop）。

## 4. 验收测试结果（退出码全 0）

| 套件 | 结果 |
|---|---|
| quick（修改后） | **310 tests / 308 pass / 0 fail / 2 skip** |
| 三件套（plugin+bridge+layout） | **17/17** |
| 完整 npm test | 见 §8 回填 |
| 安装冒烟（dsh/scripts/install-smoke.sh） | **PASS**（装→合成层→激活→卸载，全新临时 DSH_HOME） |
| 离线演示（dsh/scripts/demo.ts） | **PASS**（12 步全生命周期，见 §7） |
| 真宿主实时路径 | emit→claim→ctx.agents 会话→turn/error→failed→退避→合并；重启接管 attempt 2；暂停/恢复门；同源 403；空 body 容错 |

新增测试 17 项：桥接闭环 10（含看门狗/用量/暂停门）、插件骨架 7、安装布局集成 1；purity 新守卫 2（仅 dsh/ 可触宿主包、内核不导入桥）；purity 生产目录清单扩容（dsh/lib 与 dsh/kernel 构建副本按字节副本豁免）。

## 5. 状态、恢复、权限与预算说明

- **状态**：全部在内核事实库（profile 级 `<data>/hub/hub.db`，WAL+FULL + master.key 0600）。轮次状态机 queued→claimed→done/nothing/failed/cancelled（sweep 可置 unknown）不变。
- **恢复**：重启后 `takeOver()` 从事实取回 Job（jobOf），`ctx.agents.resume` 接续原会话投递续作指令；恢复不了→sweep→unknown→通知（既有内核路径）。真机已验证 attempt 2 接管。
- **权限**：桥不自动放宽任何权限。approval 保持宿主部署默认（`ask`，无人应答即 fail-closed）；config 可显式设 `approvalPolicy: "ask"|"never"`（never=审批一律拒绝，不是放行）。**业务批准（卡片回答）与工具审批（ctx.approval）是两条线，互不替代**——模型无法经卡片回答获得工具授权。
- **预算**：硬限 = hops≤8（内核）+ 单轮时长看门狗（默认 180 分钟，规则 `timeout` 可配；超时→agent.cancel→**failed**（非 cancelled）→内核退避）。软限 = 累计轮数与费用（usage 累积入事实、状态如实报告、缺省不当零），不宣传成强制上限。

## 6. 已知限制与后续事项

1. **真实模型 smoke 未执行**（已授权）：需将插件装入已登录的活 web profile（重启宿主、中断会话）——按 Q7 约定待用户明确安排。执行方式与核对清单已写在本文 §9。
2. session 日志物理格式（jsonl）未逐行核实——桥经 durable 事件流取回执（路径 A），不依赖物理格式；`ctx.sessionPersistence.read` 备用路径未启用。
3. `access` 三档到宿主 sandbox/preset 的细粒度映射未做（宿主沙箱模式枚举权威定义位置未定位——诚实缺口）；当前为「宿主默认 + 显式 approvalPolicy 杠杆」。
4. client 面板的会话事件订阅为进程内实现；`ctx.on` 清理签名按 cordis 常规语义推断（阶段 A–D 实测卸载无泄漏）。
5. 演示与冒烟均不触真实业务账号；真实飞书/GitHub 通道集成不在首版范围（任务书 §十五）。

## 7. 演示（离线，零真实账号）

`node dsh/scripts/demo.ts` 输出 12 步全生命周期：本地事件→派发→受控资料文件（1388 字提示词不含事件正文——数据分离实证）→ask 两方案→**等待期模型调用 1→1 零消耗**→重启→卡片不丢→回答→只执行剩余步骤（demo-result.md 落盘）→done 回执→why 时间线（rules→ingest→claim→started→finish→answer→…）。退出码 0。

## 8. 测试命令与结果（修改前基线 → 交付时）

| 命令 | 基线 | 交付 |
|---|---|---|
| `npx tsc -p .` | 0 | 0 |
| `npx prettier --check` | 0 | 0 |
| `npm run test:quick` | 296/294/0/2 | **312/310/0/2** |
| 三件套（plugin+bridge+layout） | — | **19/19** |
| `npm test`（完整） | 296/294/0/2 | **317/315/0/2** |
| `npm run test:nightly` | — | 未运行：本次未改动 kernel/、protocol/、sim/（门面抽取与桥均在外壳/桥接层），按仓库规则 nightly 触发条件未满足；如需可补跑 |
| 安装冒烟 `dsh/scripts/install-smoke.sh` | — | **PASS** |
| 离线演示 `dsh/scripts/demo.ts` | — | **PASS**（docs/dsh-demo-transcript.md 实录） |
| 真实模型 smoke | — | 已授权、待安排（见 §9） |

（基线计数来自测试输出 ℹ 统计行；初次采集时退出码捕获有小写拼写缺陷，已改用 `PIPESTATUS[0]` 并复验。）

## 9. 真实模型 smoke 执行清单（待安排）

1. 用户同意后：活 web profile 执行 `dsh plugin --profile web add <包>` → 重启宿主。
2. 配置 rules（local 来源 + demo 规则，cwd 指向临时目录）→ 面板提交 demo 事件。
3. 核对：会话真实建立；模型真实产出回执；ask 卡片呈现；面板回答后同会话续办；`autoloop-status`/`why` 时间线完整；用量非零且如实计入。
4. 核对无误后可保留或 `dsh plugin remove`（数据目录保留）。

## 10. 未完成内容与阻塞

无硬阻塞。唯一等待项：§9 真实模型 smoke 的活宿主安装安排（需用户明确同意重启活 web）。

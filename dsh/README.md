# @iasiv5/dsh-agent-autoloop（DSH 原生插件）

Agent Autoloop 的 DeepSeek Harness 原生编排插件（开发中，阶段 A 骨架）。设计、审计与宿主 API 证据见仓库根目录：

- [docs/dsh-migration-audit.md](../docs/dsh-migration-audit.md) — 仓库审计
- [docs/dsh-api-mapping.md](../docs/dsh-api-mapping.md) — 宿主 API 映射（0.2.2-rc.1）
- [docs/adr/0001-dsh-native-plugin.md](../docs/adr/0001-dsh-native-plugin.md) — 架构决策
- [docs/dsh-alignment.md](../docs/dsh-alignment.md) — 设计对齐记录（已确认基线）

## 本阶段（阶段 A）能力

- 作为 cordis 插件被宿主加载/卸载：入口 `name` / `inject` / `apply(ctx)`。
- 数据目录：按所属 profile 隔离（`<profile>/data/agent-autoloop`，可用 `AGENT_AUTOLOOP_DSH_DATA` 覆盖），权限 0700。
- 单实例锁：同数据目录第二个实例激活即失败；残留的死进程锁自动接管。
- 配置：`<数据目录>/config.json`，当前仅 `capacity`（1–16，默认 2）；未知字段拒绝。
- 不启动任何模型调用、不加载旧 standalone 外壳、不写 `~/.agent-autoloop`。

## 本阶段（阶段 B）能力

- 阶段 A 全部能力（安装/加载/数据目录/锁/配置）。
- 宿主半只读状态路由：`GET /api/agent-autoloop/status`（同源护栏：带 Origin 且不匹配 Host 即 403；非 GET 405）。
- 浏览器半：侧栏底部「Autoloop」入口钮 + `shell.overlay` 悬浮状态面板（15 秒轮询状态路由）。
- 构建产物：`lib/host.js`（宿主半）与 `lib/client.js`（浏览器半，esbuild cjs + `__ModuleLoader__.load` 包装，react external 用宿主副本）。

## 本阶段（阶段 C）能力

- 阶段 A/B 全部能力。
- **内核执行桥**：领取（`claimNext`）→ 持久化派发意图（`started`：session + turn 关联）→ `ctx.agents.create/resume` 执行 → 订阅 durable `session/event` 取 `turn/end` 证据 → 回执走路径 A（复用 worker/contract 的解析/校验/修复≤2 次）→ `finish` 提交。失败退避、排队合并、group/lane 并发、hops 全部由内核承担。
- 重启恢复：已领 run 从事实里取回 Job（`jobOf`），`ctx.agents.resume` 接续原会话并投递续作指令；恢复不了留给 sweep→unknown→通知 的既有路径。
- 用户命令：`autoloop-status`（总览/待决策/最近轮次）、`autoloop-emit`（手动事件，来源固定 `local`）、`autoloop-answer`（回答决策）。命令是人类入口，不进模型上下文。
- 定时：内核 due 表（cron/later/retry/delivery/offline/lease）经单一 `ctx.timeout` 武装，到期即 `tick`。
- 卸载安全：`turn/end` 为 disposed 的轮不产结果，交给 sweep→unknown→通知收敛。

## 配置（config.json，位于数据目录）

```json
{
  "capacity": 2,
  "worker": "dsh",
  "rules": {
    "timezone": "Asia/Shanghai",
    "sources": { "local": { "name": "本地" } },
    "agents": { "dsh": { "name": "DSH", "worker": "dsh", "use": "dsh", "access": "edit" } },
    "rules": [
      { "name": "演示", "when": { "source": "local", "types": ["demo.*"] }, "to": "dsh", "cwd": "/tmp", "prompt": "按资料处理。" }
    ]
  }
}
```

- `rules` 用与 standalone rules.json 完全相同的校验器（protocol/rules.ts），写错则插件激活失败并给出原因。
- 手动事件的来源名固定为 `local`：规则里 `when.source: "local"` 才会路由命令提交的事件。
- `access` 的宿主权限映射（approval/preset/sandbox）在阶段 E 固化；当前保持宿主默认（`ask`），不自动放宽。

## 安装 / 禁用 / 卸载（官方机制，已在隔离 profile 全流程验证）

```bash
# 安装（初始化 profile、写依赖与 bundle 层；也可用 npm 包名）
dsh plugin --profile <name> add /path/to/dsh-agent-autoloop/dsh
# 禁用：编辑 <profile>/cordis.patch.yml（用户层），加
#   - { id: agent-autoloop, disabled: true }
# 卸载（移除 bundle 层与依赖；数据目录保留）
dsh plugin --profile <name> remove @iasiv5/dsh-agent-autoloop
```

数据目录：`<profile>/data/agent-autoloop`（0700；可用 `AGENT_AUTOLOOP_DSH_DATA` 覆盖）。
卸载即移除依赖；本插件不删除数据目录（事实库一旦落地即永久保留，与旧 standalone 的卸载惯例一致）。

## 本阶段（阶段 D）能力

- 阶段 A–C 全部能力。
- **完整 Dashboard 多视图**：总览（计数/暂停恢复/提交本地事件）、待决策（ask 选项按钮、通知已处理）、轮次（列表+取消+跳时间线）、规则（编辑器：写 config.json + 同一校验器 + 事实生效）、时间线（单轮事实链）。
- 写路由（全部同源护栏 + 内核事实即审计账本）：`/answer` `/resolve` `/cancel` `/pause` `/resume` `/emit` `/rules`(GET/PUT) `/why/<run>`(GET)。
- 暂停 = 桥层门（暂停期间不领取新事项，已持有轮保租约；不写内核事实，宿主重启后默认恢复运行）。


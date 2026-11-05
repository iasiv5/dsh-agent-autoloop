# 离线演示实录（dsh-demo-transcript）

复跑方式：`node dsh/scripts/demo.ts`（零真实账号、零真实外呼；数据目录在临时区，演示后自动删除）。
实录为 2026-11-05 真实运行输出（tmp 路径每次不同属正常）。

---

== Agent Autoloop · DSH 原生插件离线演示 ==
（假模型脚本化了「读资料→提问→执行」，其余全部是真实内核与真实桥接代码）

【1】用户提交本地事项：demo.start
  事件 1 已入账，路由：资料整理

【2-3】桥领取事项 → 写受控资料文件 → DSH 会话执行；Agent 读资料后给出两个方案并发 ask
  轮 1 已派发（会话 agent-autoloop-r1a1）；资料文件已写入 /tmp/autoloop-demo-HaKjQo/runs/1-1/context.json
  提示词长度 1388 字——事件正文只在资料文件里，不在提示词里

【4】Agent 提交 ask 并结束本轮（第一行结论 + 回执，全部落进事实日志）
  轮 1 状态：done；待决策卡片 1「选哪个方案」已打开（选项：A 写文件／B 只报告）

【5】等待人工期间：模型调用次数 1（提问前也是 1）——等待零消耗
  此刻事实链：
  #1 rules
  #2 ingest
  #4 claimNext
  #5 started
  #7 finish

【6】关闭并重启宿主（同一数据目录：事实日志重放，投影复用）

【7】重启后查看同一事项与原决策（状态来自事实日志）
  卡片 1 仍开着：「选哪个方案」（未回答的 ask 不丢失）

【8】用户选择方案 A（写文件）
  回答生效：true（卡片 decided），桥派发后续轮次

【9-10】Agent 只执行剩余步骤：写本地结果文件作为证据
  结果文件存在：/tmp/autoloop-demo-HaKjQo/demo-result.md → # 演示结果
  模型调用累计 2 次；续轮提示词进入同一会话（prompts 2 条）——已完成的阅读没有重做

【11】提交完成回执
  轮 2：done — 方案 A 执行完毕，结果写在 demo-result.md。

【12】时间线解释全过程（why：续轮的每一条事实）
  #1 rules
  #7 finish
  #8 answer
  #10 claimNext
  #11 started
  #12 heartbeat
  #13 finish

== 演示结束：数据目录 /tmp/autoloop-demo-HaKjQo（演示后删除） ==

# dsh-memory-context-lab

面向 **DeepSeek Harness** 的会话级上下文管理插件（v3 单引擎）。它把会话历史持续摄入每会话隔离的影子库，在每一步按当前用户输入检索历史、把命中要点回注到上下文；已完成的回合或步骤可以被压缩成一条可恢复的回执，从而在不丢失原文的前提下控制上下文增长。

插件只改模型可见的**投影**，不改写 DSH 的 append-only 会话日志与命令审计。原始历史始终留在会话日志里，回执可按凭证恢复。

> 当前源码版本 0.14.0-beta.51（测试版）。

## 功能

- **全历史摄入**：每个 `agent/pre-step` 把新增的 user / assistant / tool call / tool result 归一化写入本会话隔离库（后台异步，不阻塞首字）。
- **按需回注**：以人类本回合输入为查询词检索历史，命中足够时生成有字符上界的回注包，追加到本步消息批次末尾；每回合只注入一次。
- **两种归档时机**：
  - **按轮归档**：回合结束后压缩已完成回合，适合长程多轮；
  - **按步归档**：同一回合内实时压缩已完成且不在工作集的旧步骤，适合长步数任务，受上下文占用闸门控制。
- **可恢复**：每次压缩生成带记录 ID / 原序号的回执；`/memory-lab restore [序号|all]` 按回执正文定位并恢复原文。
- **保护边界**：当前回合/步骤、未完成工具对、插件回执、pin 记录不会被压缩；读租约只保护当前工作集（按步归档），不拖住已完成的上一轮。
- **T1 / T2 双后端**：默认本地 Node store + 词法索引（T1）；检测到 `@furongjun1999/dsh-memory` 0.9.10 且 Python 可用时，按会话启动独立 `MDCG_ROOT` 的隔离 MCP（T2），检索融合本地与隔离灵枢；T2 不可用时如实回 T1。
- **图形入口**：composer 工具行 chip + 弹层控制本对话启用/回注/计划/模式/条数；全局参数在插件设置页。
- **可观测**：`/memory-lab status | t2 | history | working-set | file-status` 只读查看摄入、索引、归档、T2 与回注观测。

## 0.14.0-beta.51 更新（相比 beta.50）

一次性收完「审计 beta.50 后续」的全部 40 项确认缺陷（2 P1 + 10 P2 + 28 P3），要点：

- **脱敏更严**：JSON 引号键凭据（`"api_key": "…"`）不再绕过脱敏；`;/,` 分隔符后的凭据续脱敏；author/authMode 等非凭据字段不再过度脱敏；**导出重建时正文再过一次脱敏**（双保险）。
- **恢复正文上限可调**：新增设置项 `restoreMaxChars`（1000–200000，默认 16000）——单次恢复/单组归档的正文体积预算；超限失败关闭、**不做隐式截断**，并如实提示体积与调法。
- **存储更稳**：打开期对账、导入、凭证追加全量并入跨进程写锁；新增打开期检查点，大会话打开不再全量读记录；会话 runtime 空闲淘汰。
- **归档更顺**：归档时吸收紧邻上一张回执（活动面不再每轮多一张）；当前轮判定以日志为权威；`status` 的生效设置与 `config show` 同源。
- **命令面更诚实**：restore/verify/unpin 的错误码、空态与实际数量口径修正；`turnBasis` 非法值回落可见；help 补 `set gate`。
- **分享面**：导入整包预检；分享包默认 0600；导出只携带可解释的归档事实。

## 0.14.0-beta.50 更新（相比 beta.48）

- **按轮归档在 dsh 判定下恢复连续可用**（beta.49 + beta.50）：滞后 `currentTurn` 不再把整段历史误判为当前轮；系统提示 / 开发者消息作为结构边界不参与轮组，归档回执也不再把下一轮永久堵死。
- **空正文回合不再净增**：净收益门槛覆盖 0 字正文，这类回合保留在活动面。
- **脱敏补漏**：补前缀键、PEM 私钥、全角冒号与 URL 编码；导出对已遗忘 / 已清除凭证剥离回执正文，保留 `metaOnly` / `structure` 往返。
- **状态更诚实**：回执按「回合数 / 步骤数」写；判负原因对 `status` / `dry-run` 可见，`/memory-lab now` 可显式重试。
- 兼容性不变：v3 单引擎、命令与设置项不变，升级后重启 DSH 生效。

完整历史见 [CHANGELOG](./CHANGELOG.md)。

## 兼容性

| 项 | 要求 |
|---|---|
| DSH Desktop | 0.2.x（按 `app.asar` 内 `agent/pre-step` / `commands.register` / `session.append` 契约实现） |
| Node.js | ≥ 22.19 |
| T2（可选） | `@furongjun1999/dsh-memory` 0.9.10 + Python；未安装时自动走 T1 |
| 工具集 | 不增删任何模型可见工具；不改写 DSH 日志 |

## 安装

从 Releases 下载 `dsh-memory-context-lab-<版本>.tgz`，加入 DSH profile 的依赖并安装：

```text
cd "$DSH_HOME/profiles/<profile>"
pnpm add "file:/path/to/dsh-memory-context-lab-0.14.0-beta.51.tgz"
```

或把 tgz 路径写进 profile 的 `package.json` 后执行 `pnpm install`。安装后**重启 DSH**，服务端半才会加载新版本；客户端半在页面刷新后重新装配。

也可以从源码打包：

```text
npm pack
```

## 使用

唯一命令是 `/memory-lab`：

```text
/memory-lab status                 摄入位点/库健康/本对话/回注/T2
/memory-lab on|off                 本对话启用/停用
/memory-lab inject on|off          本对话自动回注
/memory-lab mode 按轮归档|按步归档|仅回注
/memory-lab set|unset limit <1-20> 本对话条数覆盖
/memory-lab set|unset gate <0-95>  本对话按步归档闸门
/memory-lab planfirst on|off|approve
/memory-lab now|compact|dry-run    归档/摘要/预览
/memory-lab history|working-set    列凭证/当前工作集
/memory-lab restore [序号|all]     恢复回执
/memory-lab pin|unpin <ID>、pins   保护/取消保护
/memory-lab forget preview|apply|undo|status <ID…>
/memory-lab export|adopt|adopt-from
/memory-lab file-status|verify <ID|all>
/memory-lab t2 [backfill [N]|backfill cancel|backfill status|cleanup]
/memory-lab recall <词> | read <ID>
/memory-lab help
```

## 设置

设置页在 **插件 → dsh-memory-context-lab**，包含 bundle 详情页与组件行配置两个槽位。字段：

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 新会话默认回注；本对话可单独关闭 |
| `fullHistory` | `true` | 新会话默认按轮归档；关闭后默认按步归档 |
| `turnBasis` | `human` | 按轮归档的轮次判定：`human` 真人消息（默认）；`dsh` 按界面「N 轮」，目标自动继续也算 |
| `planFirst` | `false` | 计划期间暂停归档与自动回注 |
| `autoRestore` | `true` | 停用/手动恢复时是否还原回执 |
| `limit` | `10` | 单次回注条数（1–20） |
| `packMinScore` | `0.5` | 装包阈值；0 表示不过滤 |
| `previewChars` | `160` | 每条命中首部字符数（40–4000） |
| `queryMaxChars` | `512` | 查询词只取用户消息前 N 个字符 |
| `coolingGate` | `20` | 按步归档的上下文占用闸门（0–95） |
| `restoreMaxChars` | `16000` | 恢复正文上限（1000–200000）；超限失败关闭、不隐式截断 |

## 工作原理

- **摄入**：`agent/pre-step` 后异步读取本步新增事件，批量写入会话隔离库；断点持久化，重放不双计。
- **归档**：选择连续的活动面 span → 生成回执 → 写 archive-intent → 宿主 `surfaceOp.replace` → 追加 voucher；失败不推进位点，崩溃按 intent 对账。
- **隔离**：数据根 `$DSH_HOME/.memory-context-lab/v3/sessions/<会话隔离键>/`；每会话一个写锁（15s 心跳 / 60s TTL / stale 接管）；T2 只写本会话 `t2-mdcg/`。
- **失败关闭**：读不到 / 损坏的状态文件按默认或失败处理，不用 0 冒充未知；写锁、索引与账本均有损坏可见的失败路径。

## 安全与隐私

- 工具结果与工具参数在摄入前做凭据形态脱敏（Authorization、api_key、token、password、AWS/GitHub/Slack/Google/Stripe/JWT 等）；脱敏是**本地副本与导出**的保护层，DSH 的 append-only 日志仍保留原文。
- `forget` 是逻辑遗忘：记录不再可按 ID 回读、不出现在索引/导出/T2 镜像中；正文仍保留在本地记录文件里以支持 undo，宿主日志也有原文。需要物理擦除请删除对应会话数据根。
- T2 使用独立 `MDCG_ROOT`、独立令牌与策略，不读写正式灵枢根。
- 插件不隐藏/屏蔽工具，不改写 DSH 日志；所有归档都可通过 voucher 恢复。

## 开发与测试

```text
npm test                 # 全量套件
npm run test:all         # 逐文件汇总，失败不中断
npm run probe:host -- --asar "<DSH>/resources/app.asar"
npm run t2:smoke         # 需要 dsh-memory；无环境时按设计 SKIP/退出
```

要求 Node.js ≥ 22.19。测试使用临时数据根，不写正式灵枢根。

## 许可

MIT。见 [LICENSE](./LICENSE)。

# dsh-memory-context-lab

按 **DSH 会话** 启用的上下文管理插件（**v3 单引擎**）：把会话事件摄入本会话的隔离影子库，在每一步按当前用户输入检索历史、把命中要点回注到本步上下文；同时提供只读观察命令与 composer 侧的 chip + 弹层面板；面板只保留**本对话控制**（启用/回注/计划/模式/条数），底层参数留在插件设置页。

> **当前源码版本 0.14.0-beta.44（M0–M7 + T2：模式/归档/恢复/保护/降温/核证/导入/fork/计划冻结/面板/默认关 + 覆盖率标注/回填 + 回注包不锁归档 + 步骤级压缩）**。唯一命令是 `/memory-lab`，子命令见下。开发决策见余项决策与完整实施方案，版本变化见[变更记录](./CHANGELOG.md)，缺陷与处置见缺陷排查记录。

## 0.14.0-beta.44 本版行为

- 归档选择器识别真实 `tool/result` 的 `data.message.toolCallId` / `data.message.source.callId`；按步归档跳过含用户锚点的前导整步。
- `off` 读当前全局 `autoRestore`；新增 `surface.lastArchiveAt`；status 预览与执行共用冷却闸门。
- `control.json` 损坏失败关闭；数字参数只认十进制；脱敏补 AWS/GitHub/Slack/Google/Stripe/JWT。
- 验证：96 套 / 439 用例 / 439 通过 / 0 失败。

## 它做什么、不做什么

**做**：

- **摄入**：每个 `agent/pre-step` 把本会话新增的 `user/message`、`assistant/message`、`tool/call`、`tool/result` 归一化后写入隔离影子库（后台异步、单飞行、可中断；钩子毫秒级返回，不阻塞首字）；
- **回注**：以**人类本回合输入**为查询词检索影子库，命中足够时把「命中 ID + 相关度 + 定长首部切片」组成有上界的回注包，追加到本步消息批次末尾（每回合同类只注入一次）；
- **观察**：`/memory-lab status | t2 | recall | read` 只读查看摄入位点、库健康、占用样本、T2 后端与回注观测；
- **composer 面板**：工具行左侧 chip + 向上弹层；只改**本对话**（启用/自动回注/条数），底层参数在插件设置页统一配置。

**不做**：

- 不增删模型可见的工具（工具集一变就作废整段前缀缓存）；
- 不改写 DSH 的 append-only 会话日志与命令审计；
- **T2 只写本会话隔离根**：不把实验文本写进正式灵枢根；T1 始终独立可用，T2 失败不阻塞摄入/回注；
- **不接管 composer**：全局设置走**插件页自带的配置块**；composer 只有本对话控制，不放装包阈/首部/查询上限这些底层参数。

## 已核验范围

| 项目 | 值 |
|---|---|
| DSH Desktop | `0.2.0-rc.2`（宿主契约按 `app.asar` 内 `dsh-commands` / `dsh-agent-loop` / `cordis` / `dsh-client-modules` / `dsh-settings` 源码核验） |
| 数据根 | `$DSH_HOME/.memory-context-lab/v3/sessions/<会话隔离键>/`（非常规会话 id 用 `hash-<sha256 前 16>`，原名存 `session-manifest.json`） |
| 检索后端 | 本地 Node store + 本地词法索引（T1）；检测到 `@furongjun1999/dsh-memory` 0.9.10（含 `md_cg/`）且 Python 可用时，按会话启动**独立 MDCG_ROOT 的隔离 MCP**（T2），搜索融合本地与隔离灵枢；探测/冒烟失败如实回 T1 |
| 依赖的宿主接口 | `agent/pre-step`、`commands.register`、`ctx.effect`、`dsh-settings`、`dsh-client-modules`、`dsh-session-projection`、`dsh-client-ui-conversation`、`ctx.remote.commands.execute`；写入经 `decision.messages`，由宿主 `session.append` 落面 |
| 消息来源标识 | 插件写入的消息 `source.kind = dsh-memory-context-lab`（与包名一致，摄入侧据此跳过自家生成物） |

## 使用

```text
/memory-lab status          位点/健康/本对话/回注/T2
/memory-lab t2 [backfill [N]|backfill cancel|backfill status|cleanup]
                            T2 诊断 / 覆盖率 / 显式回填（默认 200，上限 2000）
/memory-lab on|off          本对话启用/停用
/memory-lab inject on|off   本对话自动回注
/memory-lab set|unset limit <1-20> 本对话条数覆盖/清除
/memory-lab reset           本对话控制恢复默认
/memory-lab mode 按轮归档|按步归档|仅回注   本对话模式
/memory-lab planfirst on|off|approve  计划期间暂停归档/回注
/memory-lab now|compact|dry-run  归档/摘要/预览
/memory-lab history|working-set  列凭证/当前工作集
/memory-lab export|adopt|adopt-from  导出/导入/父复制
/memory-lab file-status|verify <ID|all>  文件核证
/memory-lab restore [序号|all]  恢复回执为原文
/memory-lab pin|unpin <ID>、pins  保护/取消保护记录
/memory-lab forget preview|apply|undo|status <ID…>  遗忘/撤销
/memory-lab recall <词>     检索影子库（最多 10 条）
/memory-lab read <ID>       精确回读（有上界）
/memory-lab help            本清单
```



## composer 面板（本对话控制）

composer 工具行左侧的「记忆上下文」chip（宿主 `conversation.input.left`）；点开是向上弹层。**只放每个对话可不同的控制**：

| 项 | 作用 | 默认 |
|---|---|---|
| 本对话启用 | 关掉后这个对话不再摄入/回注 | 开 |
| 自动回注 | 只关回注，摄入照常 | 开 |
| 计划先行 | 计划期间暂停归档/回注；开启后可批准 | 关 |
| 模式 | 按轮归档 / 按步归档 / 仅回注；切换前确认 | 跟随 state |
| 每次回注条数 | 本对话覆盖全局条数（1–20）；留空 = 跟随全局 | 留空 |

- **全局默认在插件设置页**：回注开关、模式、恢复默认、条数、装包阈、首部、查询上限。
- **数据**：投影 `memoryContextLabStatus`；state 只存 `{ sessionId, tick }`，计数在 `wire.view` 读 `statusOf()`。
- **写入**：`/memory-lab on|off|inject|planfirst|set limit|unset limit`；控制文件是每会话 `control.json`。
- **边界**：不接管 `conversation.composer`；弹层只放本对话开关与条数。

## 设置

**设置界面在插件页**。侧边栏「**插件**」→ `dsh-memory-context-lab`：

- **bundle 详情页**：说明与「包含的组件」之间就是本插件的设置块（宿主 `plugins.bundle.config` 槽位，按包名键控）；
- **组件行 →「配置」**：同一张表单的独立页（宿主 `plugins.row.config` 槽位，键为 `dsh-memory-context-lab#memory-context-lab`）。

宿主 `describe()` 只把 `Config` 投影成数据行；页面由 `ui-plugin-manager` 按本包注册的槽位渲染——没有槽位注册就没有界面。所以设置界面 = `Config` + 本包 `client.js`。

表单与 `Config` 同域（`v3-client-surface` 逐项钉住）；只有 `.volatile()` 字段进表单，改完即时生效。

| 字段 | 默认 | 作用 |
|---|---|---|
| `enabled` | `true` | 全局回注；新对话默认关闭，需本对话开启 |
| `fullHistory` | `true` | 新会话默认「按轮归档」；关闭后走「按步归档」（按步归档仍受占用闸门约束） |
| `planFirst` | `false` | 计划期间暂停归档与自动回注 |
| `autoRestore` | `true` | 停用/恢复时把回执还原为原文 |
| `limit` | `10` | 新会话默认条数；本对话可在面板覆盖（1–20） |
| `packMinScore` | `0.5` | 装包阈值：低于此分的命中不进回注包（0 表示不过滤） |
| `previewChars` | `160` | 每条命中在回注包里的首部字符数（40–4000） |
| `queryMaxChars` | `512` | 查询词只取用户消息前 N 个字符（整条长消息会把覆盖门槛抬到「必须命中整句」） |

「恢复默认」= 对该字段发 `unset`（撤掉用户层覆盖，回落到 schema 默认值）；越界值在本地拦下并就地提示，
不会发一次注定被宿主 schema 拒绝的写请求。当前生效值也会打印在 `/memory-lab status` 的「回注设置」一行——
设置页与命令面说的必须是同一件事。

## 回注的判据

- 查询词只取 `payload.messages` 里 `source.kind === 'user'` 的人类输入——**不看** `decision.messages`（那里已混入宿主的 `runtime-context` 与其它插件的追加物）；
- 每回合（`turn`）同类回注只放行一次；同一会话的闸门键有界（FIFO 64）；
- 回注包硬顶 4000 字符，超预算时按 `createdAt` 丢最旧、省略条数如实列出，尾行给可照抄的回读形态；
- 回注失败**不阻塞用户这一回合**，但必须可观测：失败计数与上次错误进 `/memory-lab status`，日志按会话限流输出。

## T2 隔离 MCP

装 dsh-memory **0.9.10** 且 Python 可用时，已启用会话在后台启动**独立 `MDCG_ROOT`** 的 MCP（`<会话>/t2-mdcg`，独立令牌与策略），四步冒烟通过才升 T2；失败如实回 T1。镜像按记录 ID 写入，检索与 T1 融合，`forget` 同步删除。`/memory-lab t2` 显示「可镜像 / 已镜像 / 覆盖率」（排除 `mcl-smoke` 冒烟节点）；T2 启用前的历史用 `/memory-lab t2 backfill [N]` 显式回填（默认 200、上限 2000、按磁盘节点幂等）。真实进程验收 `npm run t2:smoke` / `npm run t2:provider` / `npm run t2:backfill`。细节见设计文档。

## 安全边界

- 敏感字段（token/secret/password/credential/api-key/authorization/中文密钥类）与「凭据形态的值」在摄入前脱敏；脱敏函数的失败模式是**更严**（超深度整体 `[REDACTED:depth]`），不是放行原值；
- 自家生成物（回注包等）在装配层（`composition.handleDshEvent`）裁决为 `own-source`，不入库、不消耗回合计数；
- 写事务走每会话跨进程写锁（`.write-lock/`）；账本与派生索引的原子写用 `randomUUID` 临时名 + rename，崩溃残留可重建；
- 插件只清理 `$DSH_HOME/.memory-context-lab/` 自有数据，从不写正式灵枢根；T2 的令牌、镜像与冒烟节点都只落在本会话的 `t2-mdcg/`。

## 安装与卸载

插件以 bundle 形式装在 desktop profile（补丁见 `cordis.patch.yml`）。改宿主半需重启 DSH；改 `src/client.js` 后等下一次装配/HMR 重建，刷新页面即可。

```text
卸载：plugin_manager remove_bundle dsh-memory-context-lab
清数据：删除 $DSH_HOME/.memory-context-lab/v3/
```





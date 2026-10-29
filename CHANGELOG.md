# 变更记录

> 0.14.0-beta.7 ~ beta.10 未在本文件单独收录（当时以进展卡与转正方案为准）；beta.11 起恢复逐版记录。

## 0.14.0-beta.45（2026-10-29，测试版）

相比 0.14.0-beta.44：

### 修复

- **AUD-01 会话级闸门覆盖不可见（P1）**：状态投影的可覆盖键白名单原为 `['limit']`——会话级 `gate` 写进 `control.json` 并真实生效，投影却静默丢掉，composer 弹层永远显示「跟随全局」，用户也因此无从清空触发 `unset`。投影现直接复用 domain 的 `SESSION_OVERRIDE_KEYS`（单一真源），`viewSchema` 按「与真源逐键相等」校验（少键/多键/类型错都拒绝）；`STATUS_PROJECTION_VERSION` 1→2，旧检查点由宿主丢弃重折（state 只有 `{sessionId,tick}`，重折无成本）。
- **AUD-09 按轮归档被读租约钉住（P2）**：回注每次命中都把命中记录写成 5 分钟读租约，选择器又把租约当整组硬边界，而命中通常落在「上一轮」——于是上一轮被钉最长 5 分钟，新一轮开头占用不降、过几分钟突然掉一大截。租约现在只保护**工作集**：按轮归档只压已完成回合（当前回合本就被排除），不再把租约计入保护集；按步归档压的是当前回合内旧步骤，租约照旧生效；显式 `pin` 仍是永久硬边界。
- **AUD-04 状态行闸门恒显示 20%**：「生效回注设置」读合并后的字段 `gate`（回落 `coolingGate`），不再把会话覆盖显示成全局默认值。

### 改进

- **归档拒绝原因可观测**：两个选择器新增只读 `onReject` 回调，`no-candidate` 结果带 `reason`（当前回合 / 工作集保留 / pin / 无记录 / 未完成工具对 / 插件回执 / 不连续 / 无可恢复记录）与命中 seq、计数；`status` 的「下一次归档」、`now`、`dry-run` 直接把它翻成中文（例：「被 pin 保护；2 条；seq 19/77」），不再让用户只能从「占用没降」反推。

### 升级

- 替换 DSH profile 中的插件包并重启 DSH（宿主半与客户端半都要重新装配）。

### 发布

- tag `v0.14.0-beta.45`（commit `13055e2`）；GitHub Release（Pre-release）asset 78 files / 278,639 B / sha256 `2e5f479e1d0b51e57fe6c3014018374835ec3ef763b1a404f48c78735f829d3f`。
- profile 已装 beta.45（`src/` 与发布包一致），**未重启**。测试：98 套 / 450 用例 / 450 通过 / 0 失败 / 0 skip（安装 beta.45 后安装面全部真跑）。

## 0.14.0-beta.44（2026-10-28，测试版）

相比 0.14.0-beta.43：

### 修复

- **工具会话归档恢复**：真实宿主的 `tool/result` 把 callId 放在 `data.message.toolCallId` / `data.message.source.callId`；归档选择器统一按真实形状配对工具调用，修复按轮/按步归档在含工具调用的会话中不生效。
- **按步归档锚点**：真实 DSH 的 `user/message` 位于 step 1 内；遇到前导含用户消息的整步时跳过该步，不再阻断后续步骤，用户消息仍不会被压入 span。
- **停用恢复**：`autoRestore` 每次读取当前全局设置，不再使用建库时的 state 快照。
- **控制文件**：`control.json` 损坏或形状非法时按会话默认失败关闭；新对话默认关闭时不会因坏文件变为启用。
- **数字参数**：命令面与面板字段只接受十进制整数；`0x10`、`1e1`、小数与全角数字一律拒绝且不改写原值。
- **脱敏**：工具结果补充 AWS / GitHub / Slack / Google / Stripe / JWT 常见凭据格式。

### 改进

- 新增 `surface.lastArchiveAt`，按轮与按步归档都会推进；状态行、切模式确认与投影可感知按步归档，回合级 `lastArchiveEndSeq` 保持独立。
- `status` 的「下一次归档」与真实执行共用冷却闸门，闸门未开时如实返回 `cooling-closed`。
- `probe:host` 改为宿主契约源码探针；T2 环境解析支持 `$DSH_HOME/profiles/*`；源码树 `t2-smoke` 无需额外指定包根。

### 升级

- 替换 DSH profile 中的插件包并重启 DSH。测试：96 套 / 439 用例通过；`probe:host` 6/6；`t2-smoke` 通过。

## 0.14.0-beta.43（2026-10-28，测试版；切模式确认块收敛：没有归档就不问、按钮靠右、文案纠偏）

- **问题**：确认块「确认切换 / 取消」贴左边像普通字段；提示说「切换会改变模型可见的历史面」容易读成切换会撤销已归档内容；而且**没有任何已归档历史**（新会话 / 刚装 / 没压过）时照样要确认一次，是纯噪音。
- **判定**：`surface.lastArchiveEndSeq >= 0` 才弹确认——没有已归档内容时，切模式不撤销任何东西，直接写 `/memory-lab mode …`，失败仍回滚选择器。
- **布局**：动作行改 `.mcl-actions`（`justify-content:flex-end`），确认/取消靠右排列。
- **文案**：「切换只改变**之后**的归档时机，不会撤销已归档内容；需要还原旧回执时再用 /memory-lab restore all。」（中英同步）。
- **顺带确认**：`/memory-lab off` 本来就在 `autoRestore !== false`（默认开）时先恢复历史并回报「恢复 N/M；跳过 S」，不存在「关掉插件要手敲 restore all」。
- **守卫**：`v3-client-chip` 模式用例补 `surface.lastArchiveEndSeq: 120` 前置 + `mcl-actions` 断言；新增「没有已归档历史 → 不弹确认、直接发命令」用例。

## 0.14.0-beta.42（2026-10-28，测试版；按步归档闸门可配）

- **问题**：`按步归档` 的 20% 闸门是写死的，用户在模式里看不到、也改不了——不同机器上下文窗口不一样（1M vs 128k），20% 对应的绝对体量差一个数量级。
- **全局设置**：新增 `coolingGate`（`Config` 第 9 个字段，0–95，默认 20），设置页可改，`/memory-lab status` 的「生效回注设置」会显示「按步闸门 N%」。
- **本对话覆盖**：`/memory-lab set gate N` / `unset gate`（0–95 整数，越界失败关闭），写进 `control.json` 的 `overrides.gate`；composer 弹层**只在「按步归档」模式下**出现「按步归档闸门」输入行（别的模式里它不生效，显示就是噪音）。
- **状态可读**：`status` 在按步归档下多一行「按步归档闸门：20%（已开闸；上次占用 37%；0% = 每步都判断）」。
- **语义**：`0%` = 每步都判断（最省 token、最费前缀缓存）；`95%` = 几乎不开闸。非法值回落 20%。
- **守卫**：`SESSION_OVERRIDE_BOUNDS` 增 `gate`（与设置页字段同域，测试交叉核对）；新增命令断言 `set gate 10` 生效、`set gate 96` 拒绝、`unset gate` 清除；全量 **92 套全绿、0 跳过**。

## 0.14.0-beta.41（2026-10-28，测试版；模式改名：按轮归档 / 按步归档）

- **命名定稿**：两个模式都以「全历史可回读」为前提，区别只在**归档时机**，原名字（全历史 / 普通降温）会让人误以为差别是「存不存历史」。新名：`full-history` → **按轮归档**（回合结束后压），`cooling` → **按步归档**（同一回合内旧步骤实时压）。`recall-only`（仅回注）不归档，名字不变。
- **内部 id 不变**：`state.json`、命令、测试仍用 `full-history`/`cooling`/`recall-only`，中文名只做显示与命令别名，**既有会话无需迁移**。
- **命令别名**：`/memory-lab mode 按轮归档|按步归档|仅回注`，也接受 `按轮`/`按步`/`turn`/`step`；非法值回用法错误并同时列出中文名与 id。
- **状态输出**：`/memory-lab status` 的模式行改为「按轮归档（full-history）」这种「中文名（id）」形式，诊断时仍能直接看到 id。
- **界面**：composer 弹层的模式选择、状态行同步；`cooling-closed` 提示改为「按步归档未开闸」。
- **验证**：全量 **92 套全绿、0 跳过**；`check-docs` 0；安装副本逐字节一致。

## 0.14.0-beta.40（2026-10-28，测试版；普通降温改为步骤级实时压缩）

- **模式分工定稿**：`full-history` 仍是回合级、只压已完成回合（当前回合永不归档），适合长程多轮；`cooling` 改为**步骤级**，在当前回合内实时压掉已完成、且不在工作集里的步骤，适合长步数少轮（一个回合跑几十步）。
- **新选择器**：`domain/archive/steps.mjs`——步骤切分、工作集（最近 `retainOperations` 步不压）、不跨回合、整步硬边界（未完成 tool 对/插件回执/pin）、回注包透明、整步可恢复、密集连续、净收益门槛；一次最多 3 步（减少前缀抖动）。
- **实现要点**：`step/start`、`step/end` 是日志事件、不是活动面节点，span 只能由步骤内的**活动面节点**拼成——否则宿主 `range replace` 的密集覆盖判据必然失败（本版真实踩到并钉了守卫）。
- **e2e**：cooling 用 6 步夹具实测「保留最近 2 步、一次压 3 步」，闸门与凭证照常；`/memory-lab status` 的「下一次归档」预览在 cooling 下走同一个步骤选择器，不骗人。
- **守卫**：新增 `v3-step-cooling`（6 条）。全量 **92 套全绿、0 跳过**。
- **文档**：实时降温判定设计-beta.40（灵枢 role 分层/时间衰减/可回读/主动遗忘四条对照，及为何不引入概率模型）。

## 0.14.0-beta.39（2026-10-28，测试版；回注包不再锁死归档 + 下一次归档预览）

- **修复（P0）回注包把 full-history 归档永久锁死**：真实会话 `e43c4864` 实测——第一次归档把 seq 33–1507（786,047 字符）压成回执后，之后 840+ 个事件 **零归档**。根因：每个有命中的回合开头都追加一个回注包（`source.kind=dsh-memory-context-lab`、`form=recall`），而 `selectArchiveSpan` 把它同时当**插件硬边界**（`hasPlugin → break`）和**必须有记录的节点**（回注包按设计不入库，932 条记录里 0 条对应它）→ 含回注包的完成回合整组判死，`break` 又让后面的回合不再尝试。
- **修法**：回注包改为**透明节点**——不进 `hasPlugin`、不要求记录、被遮蔽时随 span 消失但**不进 `recordSeqs`**；整组扣掉回注包后若无记录则不归档（不做不可恢复的遮蔽）。回执/恢复节点仍是整组硬边界。
- **验证（真实日志）**：同一份导出日志复跑选择器，修前 `selectArchiveSpan` = null；修后返回 `seq 1533–1870`（86 条记录、回执 189 字符，原文 141,203 字符）。
- **新增**：`/memory-lab status` 增「下一次归档：…」行（只读 dry-run），直接回答「为什么没在压缩」——当前回合不归档、保护集、无记录、冷却未开闸都会照实说明。
- **守卫**：`v3-archive-protection` 新增 2 条（含回注包的回合必须能归档且 `recordSeqs` 不含它；只剩回注包无记录则不归档）。全量 **91 套全绿、0 跳过**。
- **说明**：`restore` 不偿还被遮蔽的回注包——它是一次性注入、原文仍在会话日志，需要时按查询重新生成。

## 0.14.0-beta.38（2026-10-28，测试版；覆盖率标注 + 显式 T2 回填 + 面板模式入口）

- **覆盖率标注（P0，不改行为）**：`/memory-lab status` 新增「已摄入 N · 可检索 M（其中仅元数据 K 条不进索引）」；N 取已提交记录数，M 取词法索引 `indexedCount`（复用 T1 索引解析缓存；索引缺失/损坏显示未知，不用 0 冒充）。实测本机大会话：已摄入 5431 · 可检索 4014 · 仅元数据 1417。
- **T2 覆盖率**：`/memory-lab t2` 显示「可镜像 Y / 已镜像 Z（p%）」；分母只算 `payload.text` 非空且未遗忘的记录，已镜像只数隔离根里的 `v3r-*` 节点，`mcl-smoke` 冒烟节点与 `rej_*` 拒绝节点单独计数、**不计入覆盖率**。实测 240/4014 = 6.0%（清理前 243 个 md 里有 1 个冒烟 + 2 个拒绝节点）。
- **显式回填（P1）**：`/memory-lab t2 backfill [limit]`（默认 200、上限 2000、非法参数回用法错误）。只回填非空正文、跳过 metadata-only/空正文/已遗忘；命令立即返回计划量，镜像走 provider 串行队列在后台执行，进度写每会话 `t2-backfill.json`，`/memory-lab t2` 可读；`backfill cancel` 批间中断。幂等判据是**隔离根里真实存在的节点 ID**（不是内存游标），重复执行不产生第二个节点。
- **失败语义**：T2 未启用时明确报错并说明原因，**不回退 T1 假装成功**；单条镜像失败只计数，不中断整批；收尾用磁盘节点对账。
- **面板模式入口（P1）**：composer 弹层「本对话控制」新增模式选择（full-history / cooling / recall-only）；切换前给出「会改变模型可见历史面，可 /memory-lab restore all」的确认块，写入仍走 `/memory-lab mode …`；命令失败回滚选择器并显示真实回执。旧 recall-only 会话因此有一键切回 full-history 的入口。
- **投影**：状态投影新增 `searchable`（null = 未知）；composer chip 改显示「可检索」数，弹出层同时给出已摄入/可检索/回注三个数。
- **冒烟节点**：新增 `/memory-lab t2 cleanup`（按契约 ID 遗忘 `mcl-smoke`），诊断里说明冒烟节点已排除。
- **守卫**：新增 `v3-t2-coverage`（8 条：分母/metaOnly/冒烟排除/未知≠0/幂等/中断/状态文件）与 `v3-t2-backfill`（2 条引擎级：计划量→后台完成→幂等重跑、T2 不可用与索引缺失/损坏）；`v3-t2-isolated-provider` 增 `indexStats`/`cleanupSmoke`；`v3-client-chip` 增模式切换/回滚/取消与 chip 覆盖数。全量 **91 套全绿、0 跳过**。
- **真实进程验收**：`npm run t2:backfill`（新增）在临时 DSH_HOME 里走真实命令面 + 真实隔离 MCP：65 条记录（60 可镜像 + 5 metadata-only）→ `t2 backfill 20` 两次得 40 个唯一节点 → 收口 60 条 → 重复执行计划 0、节点仍 60 → `/memory-lab t2` 报 60/60（100.0%）→ 独立 MCP 按查询命中回填节点。`npm run t2:smoke` / `npm run t2:provider` 仍通过。
- **安装**：beta.38 已 pack/install；安装副本 `src/` 逐字节一致，`install.test` 5/0。**重启 DSH 由用户执行**（客户端半需重新装配后才能看到模式控件与覆盖数）。

## 0.14.0-beta.37（2026-10-28，测试版；composer 弹层面板收敛）

- **计划先行开关**：弹层「本对话控制」新增 `计划先行` 开关，走 `/memory-lab planfirst on|off`；开启后同一行出现 `批准计划` 按钮，走 `/memory-lab planfirst approve`（批准要写冻结边界，不能只靠 toggle）。
- **分叉按钮风格**：`fork 到新会话` 原来只有 `mcl-btn` 类而没有对应 CSS，退回浏览器默认按钮；现在与侧栏/设置按钮同高、同边框、同圆角、同 hover 语义。
- **文案收敛**：移除「未填 = 跟随插件设置页的全局默认；只改本对话」与底部「全局默认在 设置 → 插件 → 记忆上下文」两行说明；保留输入框 `跟随全局` 占位与状态行。
- **守卫**：`v3-client-chip` 更新为三开关 + 四项字段；新增「开启 planFirst 时有批准按钮且走 approve」与「overrideHint 不再渲染」断言；全量 **89 套全绿、0 跳过**。
- **安装**：beta.37 已 pack/install；安装副本 `src/` 逐字节一致，`install.test` 5/0。**重启 DSH 由用户执行**（客户端半需重新装配）。

## 0.14.0-beta.36（2026-10-28，测试版；T2 在 profile 里找不到 dsh-memory 的修复）

- **真机现象**：重启后 `/memory-lab t2` 报「未找到 dsh-memory 环境（按 T1 运行）」，但 `MEMORY_LAB_T2_REPO` 一指就正常。
- **根因**：装到 profile 后本包真实路径在 `node_modules/.pnpm/dsh-memory-context-lab@file+.../node_modules/dsh-memory-context-lab`；`@furongjun1999/dsh-memory` 是 **profile 顶层依赖，不是本包依赖**，所以 `createRequire(import.meta.url).resolve()` 从本包真实路径向上永远看不到它。
- **修法**：`resolveT2Isolated()` 在 `require.resolve` 失败后，从模块目录逐级向上找 `node_modules/@furongjun1999/dsh-memory`（含 pnpm hoisted 目录），命中标准是 `md_cg/mcp_server.py` 真实存在；不存在的空目录不误报。
- **守卫**：新增 `v3-t2-environment`（3 条，模拟 pnpm 真实路径 + 无 main 的包，改回旧写法必红）；全量 **89 套全绿、0 跳过**。
- **验证**：从已安装路径直接调用 `resolveT2Isolated()` 返回 `repoRoot=...\profiles\desktop\node_modules\@furongjun1999\dsh-memory`、`version=0.9.10`、`source=profile`；`/memory-lab t2` 应显示 T2 而不是 T1。
- **安装**：beta.36 已 pack/install；安装副本 `src/` 逐字节一致，`install.test` 5/0。**重启 DSH 由用户执行**。

## 0.14.0-beta.35（2026-10-28，测试版；T2 隔离 MCP 真实后端）

- **T2 落地**：新增 `t2-mcp-client`（逐行 JSON-RPC、超时/退出/协议错误失败关闭）、`t2-token`（隔离根内独立令牌库，不读写 `~/.mdcg/_tokens.json`）、`t2-probe`（initialize / tools/list / 写 / 读回 / 删 四步冒烟）、`t2-isolated-provider`（T1 + 隔离灵枢融合、镜像、遗忘同步）。
- **接线**：`index.mjs` 解析 dsh-memory 包根与 Python，传给 `createV3Runtime`；composition 为每个已启用会话建 `<会话目录>/t2-mdcg` 隔离根，探测成功才升 T2；新对话默认关闭时**不启动任何 Python 子进程**。
- **搜索**：本地 BM25 结果按第一名归一化后与隔离灵枢结果融合；外部失败只损失外部，T1 分数与结果不变。回注包来源行如实显示「本地词法索引 + 隔离灵枢（T2）」。
- **镜像**：已提交记录在 composition 层入队（同记录 ID、CCG 六要素、会话归因）；串行后台写，失败只计数不回滚；`forget` 同步删镜像，`undo` 重新镜像。metadata-only / 空正文不镜像。
- **能力门**：`TESTED_DSH_MEMORY_VERSIONS = ['0.9.10']`（本机真实进程冒烟通过后登记）；隔离路线只要求 `cg`，但 `isolated` 必须显式为 true，**不允许全局 cg 冒充 T2**；探测抛错/版本未实测/工厂失败都回落 T1 并关闭已启动的子进程。
- **诊断**：`/memory-lab t2` 显示包根/版本/Python/隔离根/实际决策/镜像统计与最近错误；不返回令牌。
- **验证**：全量 **88 套全绿、0 跳过**（新增 client/provider/probe 三套）；真实进程 `npm run t2:smoke` 与 `npm run t2:provider` 通过（隔离根写→检索→遗忘→恢复镜像）。
- **边界**：T2 仍是**每会话一个**隔离 MCP 进程；首次建库会多一次 Python 启动/冒烟（后台，不阻塞首字）。正式灵枢根不被读写。

## 0.14.0-beta.34（2026-10-28，测试版；T2 诊断命令）

- **`/memory-lab t2`**：打印 dsh-memory 探测（包名/版本/工具面/缺的必需工具/冒烟状态）、当前实际 provider 与原因，并明确“cg 是全局正式根，不能直接当 T2”。
- **验证**：全量 **85 套全绿、0 跳过**；安装副本逐字节一致、`install.test` 5/0。
- **边界**：诊断不等于 T2 可用；隔离 cg-backed store 仍未实现。

## 0.14.0-beta.33（2026-10-28，测试版；新对话默认关闭）

- **产品口径**：新对话默认**不启用**记忆上下文（不建库、不摄入、不回注）；需要时 `/memory-lab on` 或面板“本对话启用”开关打开。已有显式 control 的会话保持原值。
- **实现**：`readSessionControl` 增 `defaultEnabled` 选项；`attachV3Engine` 透传 `defaultEnabled`；插件入口传 `false`。控制文件损坏时同样按默认关闭（失败关闭，不伪装成开启）。
- **注意**：全局设置页的 `enabled` 仍是“允许回注”的全局开关，不会自动打开新对话；新对话必须显式开启。
- **守卫**：`v3-archive-prestep` 新增“defaultEnabled=false → 不摄入，/on 后才摄入”用例；全量 **85 套全绿、0 跳过**。
- **安装**：beta.33 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。

## 0.14.0-beta.32（2026-10-28，测试版；M6 T2 能力门接线）

- **T2 能力门**：`createV3Runtime` 接回 `negotiateMemoryBackend`；入口在首次建库时探测 Host 工具面与 dsh-memory 版本，决策（tier/reason）写入 `state.provider`，`status`/面板显示实际生效后端与原因。
- **探测**：新增 `adapters/host/dsh-memory-probe.mjs`（只读工具表 + 包版本；不写配置、不回显凭据）。当前 dsh-memory 0.9.10 工具面是 `cg/stg`，缺 `memory_store/search/read`，按合同失败关闭回 T1，reason 如实为“缺必需工具”。
- **边界**：这是 T2 的**能力门**，不是 cg-backed store；T2 真正启用仍需新的 store/写路径适配。T1 始终独立可用。
- **守卫**：`v3-composition` 新增“cg/stg → T1”用例；全量 **85 套全绿、0 跳过**。
- **安装**：beta.32 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。

## 0.14.0-beta.31（2026-10-28，测试版；侧栏面板命令回执修复）

- **真机现象**：重启后面板按钮都闪一下“已更新”，没有显示命令结果。根因：`remote.commands.execute` 返回真实 `CommandExecution { commandId, result: { kind, text } }`，而 `runLine` 只读 `value.text`；`result.text` 被丢掉，面板回退到 `commandDone`。
- **修法**：`runLine` 识别 `value.result` 再取 `text/kind`；命令成功时显示宿主返回的真实文本（状态/历史/导出行），不再一律“已更新”。
- **回归**：`v3-client-chip` 的命令替身改为真实 `CommandExecution` 形状；旧实现必红。全量 **85 套全绿、0 跳过**。
- **安装**：beta.31 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **T2**：本轮只修 UI 回执；cg/mdcg 适配与 cg-backed store 仍未完成，见验收清单。

## 0.14.0-beta.30（2026-10-28，测试版；M5 plan-first 工件冻结）

- **计划冻结**：`state.planFloorSeq` 记录批准时的活动面最大 seq；`planfirst approve` 写入该边界，归档候选只允许 `startSeq > planFloorSeq`，计划工件**终生留在活动面**；批准前历史也不被回溯归档（保守）。
- **模式**：`planfirst on` 清空冻结边界（新计划）；`planfirst off` 保留已批准边界；`status` 显示「计划冻结至 seq N」。
- **守卫**：`v3-archive-prestep` 新增 approve 用例（批准前暂停、批准后只归档新回合、计划 seq 仍在面）；全量 **85 套全绿、0 跳过**。
- **安装**：beta.30 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：T2 真实后端、面板真机点击、真实模型 A/B。

## 0.14.0-beta.29（2026-10-28，测试版；M7 离线 A/B + 净收益门）

- **净收益门**：归档前比较「回执正文」与「原文正文字符数」；回执 ≥ 原文 → `not-worth`，不写 surface/凭证。离线 A/B 实测小回合归档会让占用变大，这是真实退化，不是优化。
- **A/B 脚本**：`npm run ab`（`scripts/v3-ab.mjs`）用真实 engine + 合成会话跑投影经济学 A/B：6×800 字 → 活动面 1876 / 完整 6444，**减少 70.9%**，restore 5/5，恢复正文约 100%；2/4 个小回合 → **0%**（不归档），不再出现负收益。
- **口径**：这是**投影经济学** A/B，不是真实模型质量 A/B；真实同任务开/关需要两个隔离 DSH 会话人工评分。
- **守卫**：归档夹具改为足够长的正文，覆盖净收益门；全量 **85 套全绿、0 跳过**。
- **安装**：beta.29 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：T2 真实后端（TESTED 清单为空、当前 Host 无 memory_* 工具）、M6 面板真机点击、M7 真实模型 A/B。

## 0.14.0-beta.28（2026-10-28，测试版；M6 UI 第一批：侧栏面板）

- **侧栏面板**：注册 `sidebar.panellist`（id `memory-context-lab`）与 `main`（key `memory-context-lab`）；面板用 `useSessions` 的 `ids/byId` 列会话，按钮走命令通道：状态/压缩摘要/历史/导出/fork。
- **边界**：这是 M6 的**UI 面**；T2 后端仍未接线（`negotiateMemoryBackend` 已有，composition 仍 T1），本版不宣称 M6 完成。
- **守卫**：`v3-client-chip` 的 inject/slot 断言更新为三个槽位；全量 **85 套全绿、0 跳过**。
- **安装**：beta.28 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：T2、面板真机点击验证、M7 A/B。

## 0.14.0-beta.27（2026-10-28，测试版；M5.4：原生 fork 记忆复制）

- **fork 按钮**：composer 弹层新增「fork 到新会话」；通过客户端 `uiWorkspace.forkSession(sessionId)` 创建真正的 DSH 子会话。子会话继承会话日志，v3 按日志重新摄入、重建记忆；**不再**在 fork 后跑 adopt-from（子会话 pre-step 后非空，按设计会拒绝）。
- **adopt-from**：宿主命令把父会话 v3 正文复制到当前**空会话**（手动场景/未继承日志的 child）；新 ID/新事务、导入后重建索引；非空拒绝、同会话拒绝、父未就绪如实失败。
- **客户端 inject**：补 `uiWorkspace`（与 `remote.commands` 同类的服务声明）；无该服务时 fork 按钮禁用，不抛错。
- **守卫**：`v3-import` 增 adoptFrom 用例；全量 **85 套全绿、0 跳过**。
- **安装**：beta.27 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：自动感知原生 fork（仍需用户点按钮）；LLM 摘要；M6 T2/完整面板；M7 A/B。

## 0.14.0-beta.26（2026-10-27，测试版；M5.3：导入到空会话 = 可用的 fork/share）

- **adopt**：`/memory-lab adopt <exports 文件名>` 把导出包导入**当前空会话**；已有记录时拒绝（不覆盖）。
- **隔离**：导入记录生成**新 ID/新事务**（`sourceEventId:null`、`sourceForm:'import'`），不保留源会话 ID/事务号；导入后重建索引使检索可见。
- **路径**：只接受 `v3Root/exports/` 下的**文件名**，不接受路径成分。
- **守卫**：新增 `v3-import`（导出→空会话导入→可再导出；非空会话拒绝）；全量 **85 套全绿、0 跳过**。
- **安装**：beta.26 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：自动感知 DSH 原生 fork（宿主无公开 fork 事件/API）；LLM 摘要；M6 T2/面板；M7 A/B。fork 目前 = 父会话 export → 子会话 adopt。

## 0.14.0-beta.25（2026-10-27，测试版；M5.2：压缩摘要 + 遗忘级联）

- **compact**：`/memory-lab compact` 显式归档一个完成操作，回执带确定性首部摘要（≤220 字，不调模型、不新增事实）；默认 `archive`/`now` 回执仍不含正文。
- **遗忘级联**：遗忘某回执涉及的记录时，把该回执在活动面替换为无正文标记；撤销遗忘时还原原回执。这样摘要不会在遗忘后泄漏正文。
- **恢复定位修正**：`restore`/redact 不再依赖 voucher 里可能过期的 `targetEventId`，改为按「表面正文逐字节相等」定位当前节点（单节点 replace 会生成新 seq）。
- **守卫**：新增 `v3-compact`（摘要进回执、遗忘清除、undo 还原、restore 全文）；全量 **84 套全绿、0 跳过**。
- **安装**：beta.25 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：fork、LLM 摘要、级联到派生记录之外的对象；M6 T2/面板；M7 A/B。

## 0.14.0-beta.24（2026-10-27，测试版；M5.1：本地脱敏分享导出）

- **范围**：M5 的**分享导出**先行；压缩/派生/级联/fork 仍未完成，本版不宣称 M5 完成。
- **export**：`/memory-lab export` 把本会话正文、凭证、state 写成 `v3Root/exports/<session>-<ts>.json`；**已遗忘正文不导出**，只保留 ID；正文沿用摄入时脱敏结果。
- **审计面**：导出包带 `schemaVersion/sessionKey/exportedAt/counts/records/forgotten/vouchers/state`；路径在命令回执中给出。
- **守卫**：新增 `v3-export`（遗忘正文不导出 + 真实入口写文件）；全量 **83 套全绿、0 跳过**。
- **安装**：beta.24 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：压缩/派生摘要/级联失效/fork；导入/合并；M6 T2/面板；M7 A/B。

## 0.14.0-beta.23（2026-10-27，测试版；M4：文件核证 + 读租约）

- **文件引用**：读文件类工具调用（`read` 等）在摄入后台采集工作区内路径的 sha256/大小/mtime；1 MiB 上限、工作区外/符号链接外/非文件/过大 → `unverifiable`；不读正文。
- **核证**：`/memory-lab file-status`、`/memory-lab verify <引用ID|记录ID|all>`；显式重读并更新 `verified/stale/missing/unverifiable`；不后台扫描。
- **stale 不回注**：`recall` 接受 `excludeRecordIds`，引擎把 `stale/missing/unverifiable` 的文件引用记录排除出自动回注；未核验的 `unverified` 不排除。
- **读租约**：`state.readLease`（TTL 5 分钟）记录最近读过的记录（`read` 命令与回注命中），归档按租约把对应 surface 作为软边界；过期自动失效，不是永久 pin。
- **守卫**：新增 `v3-file-references`（采集/越界/修改/删除/stale 排除）；全量 **82 套全绿、0 跳过**。
- **安装**：beta.23 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：M5 压缩/派生/级联/fork/share；M6 T2/面板；M7 A/B。文件核证只覆盖读文件工具调用，不覆盖写/编辑；扭曲/压缩文本不重建文件引用。

## 0.14.0-beta.22（2026-10-27，测试版；M3.1：普通降温闸门 + 工作集）

- **cooling 模式接线**：`archiveForStep` 在 cooling 下计算 `occupancy = 最近 input+cacheRead / contextWindow`，经 `evaluatePressureGate`（进入 0.2，动态退出）决定开闸；占用/窗口未知则失败关闭（不开闸）；开闸状态写 `state.cooling`；保留 `retainOperations` 个完成操作。
- **working-set**：`/memory-lab working-set` 列当前回合 surface 节点 → v3 记录（只读）。
- **pin/forget**：pin、未完成工具对、插件回执整组硬边界；`forget preview|apply|undo|status`；`forgotten.jsonl` 追加 `revoke`。
- **守卫**：`v3-archive-prestep` 增 cooling 开闸用例；全量 **81 套全绿、0 跳过**。
- **安装**：beta.22 已 pack/install；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：M4 文件核证/租约；M5 压缩/派生/级联/fork/share；M6 T2/面板；M7 A/B。

## 0.14.0-beta.21（2026-10-27，测试版；M3：保护集/pin/遗忘撤销/工作集）

- **范围**：M3 的**保护集与隐私面**；M4–M7 仍未完成。M3 的级联失效依赖派生记录（M5），本版只保证「当前没有派生记录时」的遗忘/撤销闭环。
- **保护集**：归档候选把 **pin**、**未完成 tool-call/result 对**、**插件回执**作为整组硬边界——不再把同一个操作切一半归档；当前回合继续永不归档。
- **pin**：`/memory-lab pin|unpin <记录ID>`、`pins`；pin 记录写入 `state.json`（≤200 条），归档时按 `seqToRecordId` 映射成 surface 边界。
- **遗忘/撤销**：`forgotten.jsonl` 追加 `action:'revoke'`；读路径按账本顺序 forget→revoke；`/memory-lab forget preview|apply|undo|status`；遗忘/撤销都整批预检 + 重建索引；已遗忘记录 `pin` 失败关闭，遗忘时自动移出 pins。
- **工作集**：`/memory-lab working-set` 列出当前回合（最后一个真人 user 起）的 surface 节点 → v3 记录；只读。
- **守卫**：新增 `v3-archive-protection`（pin/未完成对/插件回执/冷却保留）、`v3-forget-undo`（forget→EFORGOTTEN、revoke→可读且索引重建）；全量 **81 套全绿、0 跳过**。
- **安装**：beta.21 已 pack/install 到 desktop profile；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做**：M4 文件核证/租约；M5 压缩/派生/级联/fork/share；M6 T2/完整面板；M7 A/B；级联失效待派生记录落地后补。

## 0.14.0-beta.20（2026-10-27，测试版；M0–M2：会话模式/归档/恢复内核）

- **范围**：按已批准的《v3 全功能完整实现计划》先交付 M0（宿主 range 契约）/M1（会话模式与 state）/M2（归档/恢复内核）。**M3–M7 尚未完成**（遗忘撤销/级联、文件核证、压缩、fork/share、T2、完整面板、A/B），本版不宣称「全部功能完成」。
- **会话状态**：新增 `sessions/<key>/state.json`（原子写、损坏可见）：`mode`（full-history / cooling / recall-only）、mode snapshot、planFirst、autoRestore、surface 归档位点、cooling/provider 状态；旧会话首次建库迁移 `recall-only`，不静默改运行中会话。
- **默认与设置**：新会话默认 full-history（`Config.fullHistory` 默认开）；新增 `planFirst` / `autoRestore` 全局默认，分别被 pre-step 暂停与 `/memory-lab off` 的恢复动作消费。设置页 8 个字段全部有消费者。
- **归档动作**：扩展宿主 `surfaceOp` 支持 `startSeq/endSeq` 区间 replace + 完整 `sourceEventSeqs`；新增候选选择（当前回合/插件回执/无记录节点不归档）、回执（≤400 字）、voucher v2、`archive-intent.json` 崩溃对账；pre-step 每步最多归档一个完成操作，失败不推进 state、不丢记录。
- **恢复**：`/memory-lab restore [序号|all]` 先逐字节核对回执，再按记录恢复原文；超 16000 字失败关闭；`/memory-lab off` 按 `autoRestore` 先恢复再停用。
- **命令**：新增 `mode`、`planfirst`、`now`、`dry-run`、`history`、`restore`；`status` 增模式/归档位点/计划先行。
- **守卫**：新增 `v3-session-mode`、`v3-surface-range`、`v3-archive-e2e`、`v3-archive-prestep`；全量 **79 套全绿、0 跳过**。
- **安装**：beta.20 已 pack/install 到 desktop profile；安装副本逐字节一致、`install.test` 5/0。**重启 DSH 由用户执行**。
- **未做 / 下一阶段**：M3 全历史保护集/pin/forget-undo/级联；M4 history/working-set/文件核证/租约；M5 压缩/派生/fork/share；M6 T2/完整面板；M7 A/B/完整验收。当前只归档「有 v3 记录」的完成操作，恢复是单条内容消息（结构化 `read` 仍精确）。

## 0.14.0-beta.19（2026-10-27，测试版；H-103 根因修复：composer chip 弹层不再被 SlotErrorBoundary 摘除）

- **真机错误原文**（DevTools Console）：`slot entry crashed in 'conversation.input.left': Error: cannot get property "remote.commands" without inject`，调用栈落在 `MemoryPopover (client.js:630)`。不是注册被 dispose、不是 fiber 卸载、也不是 `@deepseek-ai/dsh-api-remotes` 图依赖。
- **根因**：客户端动态门面按插件**服务声明**（`client.js` 的 `inject` 数组）判权。beta.17 的弹层在 render 里读 `ctx.remote.commands.execute`，但 `inject` 只声明了 `slots` / `locale`；`ctx.get('remote')` 返回的是受保护代理，读取 `.commands` 时在代理 `get` 陷阱抛错。错误冒到 render，宿主 `SlotErrorBoundary` 记一条 `slot entry crashed`，对 list 槽位执行 `reportEntryError(..., { abdicate: true })`，条目被标成 inactive 并从读数里摘掉——所以 chip「出现一下又消失」，而设置页的 `plugins.bundle.config` 条目仍是 active。
- **修复**：
  - `src/client.js` 的 `inject` 补 `remote` / `remote.commands`（与宿主官方 `CommandUiRuntime` 同形声明）；`package.json` 的 `dsh.client.inject` **不**加 `@deepseek-ai/dsh-api-remotes`（图依赖不是本缺陷的解法，beta.18 的移除方向保留）。
  - `remoteOf(ctx)` 把「解析 remote + 触碰 `.commands.execute`」整体放进 try；未声明/未就绪/代理拒绝时回 `null`，弹层控件禁用并显示「命令通道不可用」，不再抛进 render。
- **守卫**：`test/v3-client-chip.test.mjs` 17 条；新增「受保护 remote 代理拒绝 commands 时不崩（H-103 回归）」，用 Proxy 复现宿主门面抛错；旧的 `assert.equal(module.inject.includes('remote.commands'), false)` 方向翻转为必须声明。全量 **75 套全绿、0 跳过**。
- **验证**：全量 75 套通过、`check-docs` 0 错误；安装 beta.19 到 desktop profile（`src/` 逐字节一致，`install.test` 5 条 0 跳过）。**重启 DSH 由用户执行**；重启后应看到 chip 常驻，点开向上弹层含两个开关 + 条数输入。

## 0.14.0-beta.18（2026-10-27，测试版；composer chip 真机不可见 → 移除可疑客户端图依赖，移交）

- **现象**：beta.16/17 的 composer chip 在真机（desktop profile）里没有出现在输入框工具行；beta.15 的 dock 状态条在装 beta.16 后消失。设置页是否仍在、浏览器控制台是否有报错尚未取证（H-103，未解决）。
- **本版唯一源码改动**：从 `dsh.client.inject` 移除 `@deepseek-ai/dsh-api-remotes`。`remote` 改为只在调用期 `ctx.get('remote')` 解析（无 remote 时控件禁用），不再让本包的客户端模块图依赖 api-remotes；移除理由是它是 beta.17 相对 beta.16 新增的唯一图依赖，且 `arriveDependency` 失败会跳过消费者 bundle。**是否恢复 chip 未验证**。
- **保留**：本对话控制（启用/自动回注/条数）、全局设置页五项、会话 `control.json`、命令面、投影 `control`、15+ 条守卫全部不变。
- **验证**：全量 75 套全绿、0 跳过；`check-docs` 0 错误；安装 beta.18（`src/` 逐字节一致，`install.test` 5 条 0 跳过）。
- **未做 / 待接**：重启 DSH 后肉眼确认 chip；浏览器 console / `__DSH_BOOT__` 图取证；H-103 的根因定位。交接提示词见最终回复。

## 0.14.0-beta.17（2026-10-27，测试版；composer 只留本对话控制，底层参数回设置页）

- **返工原因**：beta.16 把五项全局设置搬进 composer 弹层。用户反馈：全局/底层参数应在插件设置页，composer 只保留「本对话是否启用、功能开关、少量数值」，让每个对话能按情况调整。
- **本对话控制（弹层）**：本对话启用、自动回注、每次回注条数（留空 = 跟随全局）。只改本对话，不重复全局参数。
- **全局设置页（不变）**：`enabled`（默认回注开关）、`limit`、`packMinScore`、`previewChars`、`queryMaxChars`。所有底层参数只在设置页；命令能改的会话项都有全局对应（`enabled` / `limit`）或本身就是每对话独立开关（启用）。
- **会话控制存储**：每会话 `sessions/<key>/control.json`（与冷库同目录、`writeFileAtomic` 原子写、控制文件损坏可见）；`controlOf` 同步读、`setControl` 校验失败关闭；摄入钩子按总开关短路，回注按「全局 enabled + 会话 enabled + 会话 recall」合并，`limit` 按会话覆盖。
- **命令**：`/memory-lab on|off`、`inject on|off`、`set limit <1–20>`、`unset limit`、`reset`、`status`；不提供装包阈/首部/查询上限的会话命令。
- **守卫**：`test/v3-client-chip.test.mjs` 14 条（槽位/命令/开关/条数/无 remote/投影 control/控制文件/摄入门/命令面）；全量 **75 套全绿、0 跳过**。
- **安装**：npm pack + desktop profile 安装 beta.17；**未重启 DSH**。

## 0.14.0-beta.16（2026-10-27，测试版；composer 恢复 chip + 弹层）

- **返工原因**：beta.15 按方案 B 做成 composer 上方的一行常驻状态条，用户明确反馈「不是之前那样的界面」。既有界面是 v1/v2 的 **composer 工具行 chip + 向上弹层**（源码在 beta.10 前，槽位 `conversation.input.left`）。
- **形态**：恢复 chip（id `memory-context-lab`、order 20，与权限选择器同形），点开向上弹层；chip 在 hero 与 composer 两种变体都渲染（旧 `conversation.composer.dock` 在 hero 变体不渲染，新对话点不到）。
- **内容映射到 v3**：弹层显示本会话摄入/回注状态 + 五项回注设置（开关、条数、装包阈、首部、查询上限）。设置写入走现有 `configForms`（与设置页同一文档、同一 revision 并发保护），不新增命令、不直连 remote；`configForms` 缺席时 chip 仍显示，弹层只读。
- **不伪造旧功能**：v3 没有 v2 的降温/归档/清理/计划先行，弹层**不提供这些按钮**；数据仍来自 `memoryContextLabStatus` 投影（state 只存 `{sessionId,tick}`，计数在 `wire.view` 读同步 `statusOf`）。
- **守卫**：`test/v3-client-chip.test.mjs`（11 条）覆盖槽位/id/order、投影文案、弹层五项、开关写 enabled、数字合法/越界、无 configForms、只读部署，以及宿主投影/statusOf 会计。全量 **75 套全绿、0 跳过**。
- **安装**：npm pack + desktop profile 安装 beta.16（详见 AGENTS 口径）；**未重启 DSH**。

## 0.14.0-beta.15（2026-10-27，测试版；composer 常驻只读状态条 = 方案 B）

- **新增 composer 只读状态条**：`conversation.input.dock` 注册 `id=memory-context-lab-recall`（不撞 queue/todo/goal/claude-code-mods），一行显示「已摄入 N 条 · 回注 M 次（上次 injected）」；建库中 / 尚未摄入 / 建库失败 / 状态未知各有可判读文案。组件无 onClick、无 mutate、无命令调用，不接管 `conversation.composer`。
- **数据通路 = 宿主会话投影**（`app.asar` 源码核验，2026-10-27）：宿主半用 `ctx.inject(['sessionProjections'], …)` 注册 `memoryContextLabStatus`（stateVersion 1）；客户端用槽位标准属性 `useProjection` 读同一 key。宿主 `SessionControlController` 订阅 `sessionProjections.onChanged` 并原样广播，baseline 用 `snapshot(session)` 带出所有 wire key——推送式、不轮询、不写会话事件。
- **state 与 view 的分工**：state 只存 `{ sessionId, tick }`（会被 `session-projection-cache` 持久化，不能藏引擎计数）；`wire.view` 读引擎新增的**同步** `statusOf(sessionId)`（O(1) 内存读：records / lastSeq / ingesting / 每会话回注计数）。宿主 `imageLimits` 投影是同一形态的先例。
- **会计与失败可见**：引擎 `records` 在建库后台任务里由 `health().recordCount` 初始化、按真正 applied 的批增量累加（own-source / rejected 不计）；health 读不到时是 `null`（未知），不回 0；`statusOf` 对未知会话如实 `absent`，且不创建回注计数桶。
- **客户端依赖拆分**：configForms 从硬依赖改为 `ctx.inject` 可选——设置服务缺席时状态条仍渲染；`package.json` 的 `dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-conversation`（先例：`dsh-client-ui-goal` 同样声明并占用同一槽位）。
- **新增守卫 `test/v3-client-dock.test.mjs`（10 条）**：manifest 依赖成对、slots.inject ↔ id/order、缺数据渲染未知、只读静态扫描、投影 key/stateVersion/state 形状（多余字段拒绝）、view 抛错转 failed、入口可选注入、真实摄入后的 `statusOf` 会计、计数不可读回 null。每类各做一次「改回去必红」。全量 **75 套全绿、0 跳过**。
- **安装（2026-10-27）**：`npm pack` 生成 `dsh-memory-context-lab-0.14.0-beta.15.tgz`（48 文件 / 172.4 kB）并装进 desktop profile；安装副本 `src/` 38 个文件与源码逐字节一致，`install.test` 5 条全部执行、0 跳过。**未重启 DSH**（重启前运行实例仍是 beta.13 的宿主半，状态条不会出现）。

## 0.14.0-beta.14（2026-10-27，测试版；设置极值缺陷修复批）

- 三条「参数在 Schema 与设置页里都合法、下游用例另有隐含前提」的缺陷：H-97 装包阈 0 让回注 100% 失败（`RECALL_RESULT_MIN_SCORE` 成对派生）、H-98 热路径从后门重建索引（`allowRebuild=false` 一律不重建 + 首次摄入补建）、H-99 `previewChars` 取上界时回注退化成纯壳（两段式收敛）。守卫 `test/v3-settings-extremes.test.mjs`。详见 bug-hunt 第十二部分。

## 0.14.0-beta.13（2026-10-27，测试版；设置界面真正恢复——客户端半重建）

- **修复：beta.12 补了 `Config` 仍然没有设置界面。** 宿主源码核验（`app.asar` 内 `dsh-settings/lib/index.js` + `dsh-client-ui-plugin-manager/lib/client.js`）给出真相：`describe()` 只把入口 `Config` 投影成 `settings.describe` 的**数据行**（`ns/revision/schema/value/base/user`），**页面由 ui-plugin-manager 按槽位注册渲染**——`plugins.item`（官方插件）/ `plugins.bundle.config`（键 = 包名）/ `plugins.row.config`（键 = `<包名>#<行 id>`）。没有注册就没有界面，与 Config 是否存在无关。
- **修复：beta.11 的 P0-A 处置方向被推翻。** 那次真机故障是「`dsh.client` 声明在、`src/client.js` 不在 → 构造期抛 `ClientPackageCompositionError`」，正确修复是**补齐文件**，而不是删掉声明——删声明等于永久放弃设置界面。beta.11 起 `v3-surface-contract` 里「两者必须同时缺席」的断言方向已翻转。
- **新增 `src/client.js`（浏览器半）**：`window.__ModuleLoader__.load({id: 'dsh-memory-context-lab', factory})` 自注册；只 require 平台基线表里的 `react` 与 `@deepseek-ai/dsh-client-ui-primitives`（相对路径在宿主里解析不了）；同时注册 `plugins.bundle.config`（包名键）与 `plugins.row.config`（`dsh-memory-context-lab#memory-context-lab` 键），用 `configForms.whileServed(['memory-context-lab'], …)` 跟随命名空间——插件未装载时页面不留痕。
- **表单**：五个字段（开关用 `Switch`，四个数字用输入框）与 `Config` 的 schema 同域；本插件的浏览器半不复用宿主 `FormController` 的草稿机（那套 API 只在官方包里演化），只依赖 `ConfigFormController` 的三个公开方法 `getSnapshot()/subscribe()/mutate(ops, revision)`；行配置页用页面传入的 `form`，bundle 页自取 `configForms`。越界值本地拦下并就地提示；「恢复默认」发 `unset` 撤掉用户层覆盖；只读部署全部禁用并说明。
- **`package.json`**：补回 `exports["./client"]` 与 `dsh.client = {platform: "web", inject: [...]}`（`files` 已含 `src`，打包即含 `client.js`）。
- **新增守卫 `test/v3-client-surface.test.mjs`（12 条）**：声明↔文件成对；只 require 平台基线表；模块 id = 包名；注册键 = patch 行 id / 包名#行 id；字段与 `Config` 逐项同域（键/类型/上下界/步长/默认值）；用极简 React 替身浅渲染——改开关后保存只提交变化项并带上宿主 revision、越界不发写请求、行页写页面给的 form、只读禁用、命名空间缺席只留一句说明。改回旧写法（删声明 / 换键 / 放宽上下界 / 直写 configForms 而不看页面 form）必红。
- **验证**：源码树 **73 套全绿**（新增 1 套；安装面按版本闸 SKIP，待安装后真正执行）。

## 0.14.0-beta.12（2026-10-27，测试版；设置面数据行）

- **修复：设置页整块消失。** 宿主 `dsh-settings` 用 `entry.fiber.runtime.Config` 生成设置页（且只渲染 `meta.volatile` 字段）；v3 转正批删掉了 v2 设置面，入口却没有补 `Config`，于是页面没有可渲染的 schema。
- 入口导出 `Config`（`@deepseek-ai/schemastery`，宿主的同款实现，已发布到 npm，作为普通依赖安装）：`enabled` / `limit` / `packMinScore` / `previewChars` / `queryMaxChars`，**全部 volatile 且全部被消费**。
- volatile 字段解析出来是引用包装（`Symbol.for('cosmokit.volatile.write')` + `.get()`），`readSettings()` 每次调用解包，并在 pre-step 实时读取——改完即时生效，不需要重启或重挂。
- `/memory-lab status` 增「回注设置」一行；`queryMaxChars` 按码点截断查询词（整条长消息会把覆盖门槛抬到「必须命中整句」）。
- 新增守卫：`v3-surface-contract` 的设置面两条（字段全 volatile + 默认值 / 开关与截断实参）；并用宿主自己的 `volatileForm()` 对已安装副本验证出五个字段（反证：无 volatile → 无表单）。
- **注（beta.13 更正）**：本版「导出 Config 即恢复设置页」的结论只对了一半——Config 只让 `settings.describe` 多一行数据，页面还要客户端半的槽位注册。见 beta.13。

## 0.14.0-beta.11（2026-10-27，测试版；P0 事故修复 + 全面排查第二批）

**P0-A 界面消失**：`package.json` 残留 `dsh.client` 与 `exports["./client"]`，指向已随 v2 删除的 `src/client.js`。宿主 `ClientModuleRegistry` 在**构造期** `statSync` 该 bundle，ENOENT → `ClientPackageCompositionError` → `clientModules` 服务不成立 → `__DSH_BOOT__` 不注入 → 整个前端（含输入框）不渲染。删除两处声明，保留 `exports["."]`/`main`；守卫静态钉住「两者必须同时缺席」。**（beta.13 更正：故障判断正确、处置方向错误——正确修复是补齐 `src/client.js`；该守卫的方向已翻转，见 beta.13。）**

**P0-B 插件加载失败**：入口 `ctx.inject('commands', null)` 必抛（cordis 的 `inject` 是启动子插件，实现里直接读 `callback.name`）。改为 `ctx.commands.register({...})`；handler 统一返回 `{kind,text}`（裸字符串会被 `normalizeResult` 抛）；会话 id 改取 `invocation.agent.session.id`；子命令改取 `rawInput` 首 token。

**P0-C 回注 0 生效（两条断链）**：① `runtime.recall(String(query), opts)` 传参形状错（签名是 `{query, turn}`，turn 必填）→ 100% 抛错被 catch 成一条 warn；② 回注钩子（prepend 外层）在 `next()` 之后取数，摄入钩子（内层）先返回并同步置上 `inflight` → 每步都判 busy。修复：回注在 `next()` 前取数、后追加；`recallForInjection` 返回判别式 status 并按会话计数，`status` 直接打印。

其余（按层）：
- 摄入：`tool/result` 错误态改看 `message.isError`（宿主 `error` 字段可缺省）；工具结果正文补脱敏；`normalizeDshEvent` 读宿主真实字段 `time`。
- 回合：真实用户判据改 `source.kind === 'user'`（旧口径把 `runtime-context` 等注入算成人类回合）。
- 来源：`contracts/sources.mjs` 单一真源（= 包名，守卫钉住）；own-source 裁决上移 composition，且推进断点。
- 检索：覆盖门槛按**不同**词元计半数并设上限 3；OOV 去重 + 上界；索引按文件戳缓存、损坏即重建、热路径不重建；回注包超硬顶拒绝注入；首部切片按码点；尾行句柄改为真实命令 `/memory-lab read`。
- 存储：原子写补 fsync；账本损坏按账本拒绝追加；记录读写校验会话归属；跨句柄遗忘按文件戳刷新；写锁事务期间续约；重入帧继承上层目录；建库失败在 `status` 明确报出。
- 性能：`processTurn.many` 一批事件共用一笔事务，1500 条回填 **45.1s → 11.0s**；批量失败整批 failed 且回合号回滚。
- 清理：删除 3 个 v2 死脚本（`eval-policies` / `probe-lingshu` / `revert-probe`）与两个 npm 入口；`npm test` 改为自动发现（原 197 条路径里 127 条已不存在）。
- 验证：源码树 72 套全绿、0 跳过；安装面 5 条真正执行；真实 cordis 装载 `fiber=2`（beta.10 负对照 `fiber=0`）。

## 0.14.0-beta.6（2026-10-25，测试版；决策文档 P1 摄入修复批）

- **修复：按宿主真实事件形状重写正文提取**（dsh-agent-loop 0.2.1-rc.3 源码核验）：`assistant/message` 与 `tool/result` 的正文在 `data.message.content`（此前读 `data.content` 致 154 条 assistant、346 条 operation 全空正文）；`reasoning/thinking/图片` 等非文本块不进正文。
- **tool/call 结构化摄入**：工具名/callId/脱敏参数以确定性文本 + `structure` 字段入库；敏感字段（token/secret/password/credential/api-key/authorization）替换为 `[REDACTED]`，不静默保存凭据。
- **metadata-only 合同**：空正文/不可提取事件标 `metaOnly`+原因落库（可回读、计数可对账），不进全文检索索引。
- 新增守卫：`test/v3-p1-ingest.test.mjs`（真实形状 fixtures + 脱敏 + 端到端）。

## 0.14.0-beta.5（2026-10-25，测试版）

- **新增：v3 影子观察面（只读，不动 v2）**——`/memory-lab v3 status`（摄入位点/健康）、`v3 recall <查询词>`（查影子库，命中带可回读句柄）、`v3 read <记录ID>`（精确回读）。未摄入会话给指引；后台摄入中如实回 busy 不抢写锁；失败关闭带 code。
- 新增守卫：`test/v3-surface-observe.test.mjs`（三态 + 懒重建分寸 + OOV 如实）。
- 修正 plugin/README 版本行漂移（停在 0.13.2-beta.7）并补 v3 命令清单。

## 0.14.0-beta.4（2026-10-25，测试版）

- **修复：插件自有生成物（工作状态卡/回执）不再进入 v3 影子库**（检索冒烟实测同文本 31 份重复入库、以高频词霸占检索位）。摄入按 `source.kind = dsh-memory-context-lab` 跳过，seq 照常推进；已入库的存量卡待停机窗口重建影子库清除。
- **修复：检索新增查询覆盖门槛**——结果面要求至少命中半数查询词。绝对分数阈值对 BM25 量纲不设防（OOV 查询靠单个高频低质词也能攒十几分垃圾）；覆盖门槛按命中词数判相关，量纲无关。窄查询（单词/双词）不受误伤。
- 新增守卫：自家来源跳过（v3-entry）、覆盖门槛（v3-t1-recall）。

## 0.14.0-beta.3（2026-10-25，测试版）

- **修复：每步摄入后全量重建词法索引（11.5MB）卡宿主事件循环，首字显著变慢。** 现在只有回填（≥100 条批量）完成后重建一次；每步 1-3 条的小增量留 stale，检索时懒重建（v3-entry，事故第二轮修正）。
- **修复：设置面板「层级压缩」开关发送错误命令**（`/memory-lab compress on|off` 不在命令面，回执只有用法提示）——改为 `/memory-lab set compress on|off`。
- 新增用例：索引重建分寸（小增量不重建/回填重建）。

## 0.14.0-beta.2（2026-10-25，测试版，热修）

修复 beta.1 真机首发事故（既有大会话恢复后 **4 分钟无首字、中断无效**）：

- **根因（实测取证）**：历史回填在 pre-step waterfall 钩子里同步逐条执行，且每笔事务全量重建词法索引——2252 条事件实测写入 10 分钟（O(N²)：前 100 条 <30s、后期每条 >300ms）；循环不检查中断信号。
- **修复**：①摄入改**后台异步**（钩子毫秒级返回 decision，绝不阻塞首字；单飞行防重入）；②写事务**不再**每笔全量重建索引（P9 派生物——检索入口自动重建兜底，回填完成后显式重建一次）；③批量化（100 条/批）与批间中断检查（dispose 后停）。
- 数据无损：beta.1 事故期间已落库的 2252 条记录完整有效，beta.2 断点续传继续。

## 0.14.0-beta.1（2026-10-25，测试版）

v3 影子引擎线首个可安装测试版（开发计划 dev-0.14.0 全部里程碑 + 用户拍板项落地）。**v2 行为零改动**；v3 以影子模式挂载（只摄入落库，不动表面、不注册命令）。

- **v3 八层架构**（contracts / ports / domain / application / adapters / projection / composition / entry）：封闭集纪律、失败关闭、时间经端口注入；新增 31 个测试套件（全量 154 套）。
- **存储**：v3 独立数据根（`<DSH_HOME>/.memory-context-lab/v3/`）、原子事务、崩溃对账（尾部残留修复 / 中段损坏可见）、跨进程写锁（两阶段创建 + token 心跳 + stale 接管）、恢复凭证账本、可重建词法索引。
- **检索与回注**：BM25（CJK 单字+双字）、双面 min_score（pack ⊆ display）、确定性排序、注入上界（回注包 4000 字符硬顶、省略可见）、码点切片、别名解析（readByRef，失败关闭）。
- **用户拍板移植 5 项**：压力闸门 G1-G4（滞回 + 动态死区）、注入上界、租约 retainReads（活跃租约 soft→protected 晋升）、回执恒一行断言、别名解析。
- **宿主契约源码级核验**：session.log 事件面、session.id、seq 0 基、agent/pre-step 派发面（修复 3 个替身偏差缺陷）。
- 行为规格映射 152/152 定稿（24 项产品决策：移植 5 / 缓议 7 / 不移植 3 / 面待建搬入 6）；ADR-0001~0003；property/fuzz 层；三轮重复运行报告（中位 73.1s、失败样本 0）。

## 0.13.2-beta.9（2026-10-24，测试版，未发布）

本版是第 13 轮「根治与结构收口」批的**中间测试版**（P0 批大部分落地；P0-3 / P1 / P2 / P2.5 尚未实施）：

- **P0-1 遗忘传播**：forget 级联派生记录——`applyForget` 以生效显式目标为种子沿来源图做有界 BFS，受影响记录级派生物并入同一条 forget 条目（undo 一次还原全级联）；来源图缺席/损坏失败关闭，只忘显式目标并如实披露；forget preview 新增级联影响预告（与 apply 同源闭包）。
- **P0-2 推理段不回灌**：预览层过滤 `[推理]` 段（v2 适配器 + `displayPreview`），整段替换为「（推理段已省略，原文可按 id 回读）」；按 record id 的精确回读不过滤。
- **P0-4 部分清偿**：删除 22 个全仓零引用死导出；接线 `dependentsOf`（preview 级联）与 model-ledger 三钩子（模型摘要缓存/费用账首次真实落账）；删除 `decideNetBenefit`（闸门点无 token 估算可披露，接线属新产品设计）。
- **P0-5 契约接线守卫**：`test/contract-wiring.test.mjs` 两闸（导出必被消费 / 单点孤儿标识符），理由白名单只缩不涨；裸 throw 禁令由 G2 套件继续覆盖（src 实测 0 处）。
- 门禁：源码树 **123 套全绿**（前台）；revert-probe 新增 6 场景（forget-propagation / reasoning-not-in-preview / forget-preview-cascade / model-ledger-wiring / contract-wiring-dead-export / contract-wiring-undefined-ref），全部实测「还原必红」。
## 0.13.2-beta.8（2026-10-24）**测试版，release 仓已打本地 tag（未推送 GitHub）/ 未装到本机 profile**

**卡片治理（Q3）+ 未接线类目（Q4）。上一批（beta.7）刻意留下的两个产品决策项，
由用户拍板路线后实施（一进一出 / 双槽 / 合并硬段 / 可执行句柄 / 全部摘掉 / 不印标注）。
只做已拍板的治理与同族缺陷，不新增功能。**

源码树 **120 套全绿、0 套失败**（新增 v2-workingset-wiring、v2-card-replace）；
回归集探针 **73 项全 0 退出**（新增 p-wiring、p-card-budget-e2e）；
`revert-probe` **72 个场景 / 64 OK / 8 未覆盖**（本批新增 6 条，全部实测还原必红；
8 条未覆盖 = 6 条 beta.6 场景无测试文件 + 2 条真未覆盖，口径修正后如实计数）。
计划见修复计划-beta.8。

### Q3 卡片治理：折叠从未生效的根因收口（一进一出·双槽）

- **Q3-1/Q3-2 卡片无界累积**：折叠的「卡节点连续 ≥2」前提在真实注入序列里永不成立
  （实测 512 张卡 / 306,071 字符 = 上限 76.5 倍，0 张被折）。换成**注入即替换**：
  增量步 replace 面上最近一张增量卡，全量步 replace 最近一张全量卡、其余卡槽转一行
  占位回执；稳态 [全量][增量] 双槽，净增 0。replace 直连 `session.append`
  （decision.messages 通道不携带 surfaceOp）；宿主拒绝 → 降级 append + 计数。
- **Q3-3（Y-31）同一事实双渲染**：进度行只收「已曝光的完成态」，call-only 与未曝光行
  移交硬段；误导性 unknown 与「保守规则」「整条长任务 pin」两张常量行摘除。
- **Q3-4（Y-32）seq:N 死句柄**：渲染层消费 `readable`——可读句柄升级
  `memory_lab_recall(record_ids=["…"])` 可执行形态，不可读 seq:N 一律不印。
- 折叠管线保留为兜底；`CARD_NET_CHAR_CAP` 4000→8000（语义降级为双槽破坏的告警线）；
  `CARD_SEMANTIC_VERSION` 4→5；新计数键 `cardReplaceFallbacks` / `cardReplaceReceiptFailures`。

### Q4 未接线类目：类目必须先有生产方（全部摘掉）

- **十类零生产方入参整类摘除**（evidence / pins / inflightJobs / constraints / relations /
  projection / prefetch / redundantCards / nonEssentialHistory / rejectedOptions /
  openQuestions + step）：三个硬保护段与六个软保留类目在 beta.7 之前就从未渲染过任何内容
  （空段整段跳过，「恒空却印（无）」的前提不成立）。随行摘除死构造器、八个死 limits 键与
  七个死输出字段；保护类目 8→5、软保留 8→2；`WORKING_STATE_SCHEMA_VERSION` 3→4。
- **结构性守卫**：`test/v2-workingset-wiring.test.mjs` + 探针 p-wiring +
  revert-probe `dead-input-regression`——形参必须接线或在白名单附理由，「先渲染后接线」
  的死类目不可能静默回归。接线记产品需求 U-03。
- 同族清理：`working-state.mjs` 在途作业溢出行引用未定义变量 `jobCap`（被「没人传参」
  掩盖的潜伏 ReferenceError）、`foldWorkingCards` 死参数 `requireOverCap`，随摘除消失。

### 守卫体系

- revert-probe：测试文件不存在 → 如实记「未覆盖」，不再被 node 的非 0 退出误报成 OK；
  G1/G4 重指合并后的测试文件，G1 补空白账本用例（只加断言）。
- 端到端守卫（单测绿不算）：`v2-card-replace`（25 步交替序列双槽不变量）与探针
  `p-card-budget-e2e`（30 步真实交替序列 + 宿主拒绝注入点 + fallback 一步恢复）。

## 0.13.2-beta.6（2026-10-23）**测试版，未打 tag / 未装到本机 profile，未推送 GitHub**

**第 8 轮审计（`reports/第8轮结论.md`）的按根因修复批。只修缺陷、不改产品边界。**
本轮不按 18 条红探针逐条排期，而是先归并成 9 个根因组，一组一处抽象改动。

源码树 **117 套全绿、0 套失败**；回归集探针 **71/71 全绿**；
`revert-probe` 全矩阵 **66 个场景 / 62 OK / 4 遗留脱节**（本批新增 12 条，全部改回去必红）。
逐条处置见修复计划（beta.6）与
`测试/记忆上下文插件测试/reports/第9轮-修复结论.md`。

### G1 三份 append-only 账本各写一遍「尾部修复 + 建 header」（P0）

- **P0 disposition 缺 LF 拼行、hierarchy 0 字节无 header、provenance 并发双 header。**
  同一个协议被实现了三遍，第三次漏了锁、前两次漏了「0 字节补 header」。现在抽出
  `v2/appendable-ledger.mjs` 的 `createAppendableLedger()`，三份账本共用：
  header 补齐在写锁内、尾部半行修复只对解析失败的行生效、临时名用 `randomUUID`。
- 判据从「文件长度为零」放宽到「没有任何有效内容」（`text.trim().length === 0`）——
  单个 `\n` 的账本同样要补 header，否则首条目落在第 1 行，下次解析判整本 damaged。

### G2 对外错误没有统一类型

- 约 25 处裸 `new Error` / `TypeError`，`code` 恒 `undefined`。现在全仓对外错误都走
  `EngineV2Error` 家族（`InvalidArgumentError` / `DamagedError`），
  `V2SessionStateDamagedError` 也补了 code。新增静态守卫禁止 `src/` 下裸抛 `Error`。

### G3「未知量」没有三态

- `restoreGrowth` 在 contextWindow / assembledTokens 缺失时判 `overflow: false`（失败开放），
  而 `batchReleaseCeilingOf` 对同一个未知量明确失败关闭。现在统一成
  `TRI_STATE.UNKNOWN` + `windowGuardRefuses()` 单一判据：判不了就拒绝，不放行。
- 回执文案从三处硬编码字符串收口到 `describeWindowGuardRefusal()`，不再各写一份。

### G4 状态文件的字段清单有两份

- `isV2SessionState` 只校验 4 个字段，而 `runtime-render` / `runtime-settings` 裸取
  `archive` / `settings` → 缺字段时抛裸 `TypeError`。现在 `REQUIRED_STATE_FIELDS`
  是唯一真源，`stateWithDefaults()` 供消费者按同一张表取默认值。

### G5 命令结果不满足宿主契约

- 错误结果缺 `text` 时宿主抛 `TypeError`（`forget` 13 处、`compress` 6 处）。
  现在 `withHostContract()` 在**域工厂出口**统一补齐，而不是逐处补 `text`。

### G6 死代码 / 未接线

- `apply-engine` 的 `rememberRecall` 定义并导出但全仓无调用点（回注去重整条链失效）——
  已接回 `runtime-recall` 的写端。新增「导出即被使用」的静态守卫。

### G7 注释即规格，但没有守卫

- 约 8 处注释与实现相反（`archiveCleanup` 的窗口守卫、`inShadow` 的死逻辑、
  `catalog.json` 的「打开加速」、`applyUndo` 的「revision CAS」、
  `MAX_BUCKET_SIZE` 的「近似比较」、`agg-voucher` 的「丢最旧」、
  `apply-engine` 的「实际提交数」）。逐处让实现服从注释，并加断言锁住。

### G8 读账本并发写撞临时名

- `read-ledger` 的临时名 `tmp-<pid>-<Date.now()>` 在同进程同毫秒的两个写者上撞名，
  后写者截断先写者。改用 `randomUUID`，并让整段读改写进写锁。
  同族的 `retrieval.mjs` / `local-lexical-backend.mjs` 一并改掉。

### G9 句柄关闭后仍可写

- `store.close()` 之后 `disable` / `reenable` / `abandonTransaction` 仍能写盘
  （写锁已释放 → 无锁写者）。现在五个写入原语统一走 `#assertWritable()`；
  `retrieval-backend-provider.closeAll()` 一并清 `probeCache`，不再返回已关闭的后端。

### 已知未根治（诚实边界）

- G1 的 `parse` 侧仍三份各写（只收口了写侧）；`model-ledger` / `local-lexical` 的
  append 未进协议。
- G3 的 `/memory-lab restore` 主路径仍不过窗口守卫；测量失败时守卫被跳过
  （`lifecycle:502` 的 catch 只 warn）——两者都属产品口径，需另行裁定。
- G4 的 `apply-engine` 消费者仍裸取 `record.state.archive`。
- G5 只包「返回值」不包「抛出」。
- G9 的 `closeAll` 不扫 `openingDirectories`。

## 0.13.2-beta.5（2026-10-22）**测试版，未打 tag / 未装到本机 profile，未推送 GitHub**

**第 4 轮真机排查（`reports/第4轮结论.md`，Q-01 / P-01 / M-01 / N-12 / O-01）的修复批。
只修缺陷、不改产品边界。**

源码树 **115 套全绿、0 套失败**；回归集探针 **53/53 全绿**；
`revert-probe` 全矩阵 **57 个场景 / 53 OK / 4 遗留脱节**（脱节仍是历史维护债）。
逐条处置见进展卡（beta.5）。

### 恢复语义（P1）

- **Q-01 `set autorestore off` 是空开关，而且把窗口守卫一起关掉。** `disableRecord` 里
  `autoRestore` 只被用来决定「要不要算窗口守卫」，恢复本身不在判断内：关掉开关后 `off`
  照样把全部原文塞回活动面、回执还写「恢复 N/M 段」，而**窗口守卫被完全跳过**——
  本来会因「组装输入 + 待恢复原文 > 模型窗口」而拒绝恢复的那批数据现在无条件恢复，
  按回执指引操作反而更容易顶穿模型窗口。现在：开关只决定**要不要恢复**（关 = 只停用，
  回执写「按设置未恢复原文」并给两条出路），**窗口守卫不受开关影响**（它保护的是模型窗口，
  不是恢复策略），回执首行按「按设置未恢复 / 守卫拒绝 / 已恢复 N/M」三种结局分别写。

### 回读原语边界（P2）

- **P-01 `readback` 三原语在「会话从未启用」时抛 `TypeError`。** `V2SessionStore.open()`
  的契约是「从未初始化返回 null」，而 `finally` 里直接 `store.close()`，于是边界上抛的
  是一条内部 `TypeError`，**盖住**了本该走到的「没有库」分支。现在：`listRecordsPage` /
  `packWorkingSet` 返回 `null`（与 `withReadableStore` 同一种语义），`readRecordById`
  抛带 `code: 'ENOSTORE'` 的业务错误，`finally` 加 `&& store` 兜底。

### 设置面（P2）

- **M-01 设置页数字框仍在静默改值（N-10 只修了命令面）。** `NumberInput.commit` 用
  `Math.round(Number(text))`：清空输入框被当成 0 再夹到下界（「归档批量」变 1、
  「保留最近操作」变 0）、`2.5` 静默变 3、`0x10` 变 16、`2e1` 变 20。现在 `parseCount`
  与命令面的 `parseStrictInteger` 同一把尺子（只认 `/^\d+$/`），非法输入**回落原值、不提交**
  并在卡片上写明「只接受 N..M 的整数」；越界仍按既有设计夹到边界。
- **N-12 `archiveBatchSize` 的 schema 下界是 0，其它三个入口是 1。** 同一个「归档批量 = 0」
  在 schema 里合法、被 `normalizeSettings` 换成 10、被命令面拒绝、被设置页夹成 1——
  四个入口四种结论，用户看到的三个值没有一个是自己写的。现在 schema 的四个数字字段
  **一律从 `core.mjs` 的 `NUMERIC_SETTINGS` 派生 min/max**（单一真源），并由守卫锁住。

### 命令面（P2）

- **O-01 `/memory-lab history <N>` 的每页条数被静默夹到 2000。** 旧实现
  `Math.min(Math.max(Number(pageSize) || 200, 1), 2000)`，用法文案只写「正整数」、回执也不说
  请求被改过——与项目自己的规矩（`parseBudgetTokens`：「超过上限必须显式报错」）相反。
  现在新增 `resolvePageSize`（上下界都显式判，上界 `MAX_PAGE_SIZE`=2000），`history`
  超界即回用法错误并写出真实上限，页脚如实印「每页 N 条」。

## 0.13.2-beta.4（2026-10-22）**测试版，未打 tag / 未装到本机 profile，未推送 GitHub**

**第 3 轮真机排查（`reports/第3轮结论.md`，N-09 / N-10 / N-11 + R-01…R-03）的修复批。
只修缺陷、不改产品边界。**

源码树 **114 套全绿、0 套失败**；`install.test.mjs` 里 3 条**安装面**断言按设计 SKIP
（安装副本仍是 beta.3，版本不同就不拿新源码的期望去验旧副本），其余套件 0 跳过。
回归集探针 **48/48 全绿**
（第 3 轮的 3 条红全部转绿）；`revert-probe` 全矩阵 **49 个场景 / 45 OK / 4 遗留脱节**
（脱节仍是历史维护债，本轮新增的 6 条全部「改回去必红」）。逐条处置见进展卡（beta.4）。

### 数据可恢复性（P1，beta.3 自己引入的回归）

- **N-11 format 4 的旧 span 行会让整次恢复抛异常。** beta.3 把 `restoreLegacyReceipt` 里
  那段专门的早退分支换成了「有界候选集」，而候选集的 span 分支仍把
  `formatVersion === 4 && spanKind !== 'operation'` 算进去，并按 `[4, 7, 5]` 顺序调用
  `buildSpanReceipt`——后者只认 5/7，**第一个候选就抛**。`restoreReceipts` 没有兜底，
  于是一条旧行的格式问题把整批其它行一起打挂（0.10.1 时代的会话 `off` 时一条都恢复不了）。
  三处修：候选格式只放 `buildSpanReceipt` 接受的版本；format 4 的 span 行恢复**专属**的
  如实 skip 文案（不再落进通用的「回执正文已变化」——那正是 N-06 要消灭的误报）；
  `restoreReceipts` 对单行（含批摘要组）异常做兜底，一条抛错只让这一行落 `skipped`，
  保住「restored + skipped + forgotten == 输入行数」这条会计不变量。

### 设置面（P1）

- **N-09 设置页保存抹掉 schema 里有、设置页没显示的字段。** `client.js` 的
  `settingsValueOf` 是**白名单构造**（只列 10 个字段），而 schema 声明了 12 个；
  宿主用这份对象**整体替换** `defaults`，于是用户只要动任何一项并保存，
  `protectBudgetTokens`（软保护预算，`refreshProtections` 每轮都读）与
  `retrievalBackend`（检索后端选择）就被静默重置成默认值，而设置页根本不显示它们。
  现在改成**以 `inner` 为底、只覆盖认识的字段**：未知/未来字段原样透传，schema 再加
  字段也不会被设置页吃掉。
- **N-10 `/memory-lab set` 的数字参数用 `parseInt` 静默截断。** `12.7`→12、`1e6`→1
  （软保护预算写成 1，几乎全部丢失）、`10abc`→10，回执还照抄原文。数字键统一改走
  `parseStrictInteger`（只认 `/^\d+$/`，与 `budget.mjs` 的「不静默换值」同规矩）；
  `retain` 的下界改成 0（与 schema `natural().max(200)` 及设置页 `clampInt(…, 0, 200, 5)`
  同域——0 = 不保留最近操作，全量立即进归档）；回执照抄**落盘值**。

### 改进（非缺陷）

- **R-01** 删掉 `runtime-recall.mjs` 里的 `if (budgetPlan.clamped)` 死分支
  （`parseBudgetTokens` 超上限返回 `ok:false`，从不产出 `clamped:true`，`requested` 也不存在）。
- **R-02** `history` 的页码与 `set` 同一把尺子：严格整数，非法即用法错误（不再 `3.7`→3）。
- **R-03** `status` 行补印 `autoRestore`：三个开关都在面板上，只印两个时
  「`off` 到底会不会恢复原文」只能靠猜。

### 顺带修掉的环境面缺陷

- **dsh-memory 0.9.10 被判为「未核验」而静默关闭抑制。** 本机 profile 装的已是 0.9.10，
  而已核验清单停在 `0.8.1 / 0.9.8`，于是每次加载都失败关闭（隔离抑制不可用，
  `on` 回执与 `status` 只会说「未启用」）。核验 0.9.10 的五个钩子方法签名与
  `lib/hooks.js` 的调用形态后加入清单；`install.test.mjs` 改为直接引用同一份常量
  （不再另抄一份版本列表）。
## 0.13.2-beta.3（2026-10-22）**测试版，已打 tag / 已装到本机 profile，未推送 GitHub**

**第 2 轮真机排查（真实会话 `session-868c3915`，2256 事件）的 8 条缺陷（N-01…N-08）修复批。
不新增功能，不改产品边界。**

本版仍是**测试版**：源码树与 `release/` 均 **113 套全绿 / 0 跳过**，回归集探针 **43/43 全绿**，
`release/` 已提交并打 tag `v0.13.2-beta.3`、已 `npm pack` 并装到本机 profile。
**未推送 GitHub**（推送按 发布流程另行执行）。
逐条处置见进展卡（beta.3）。

**产物**：`dist/dsh-memory-context-lab-0.13.2-beta.3.tgz`（72 文件）；同一份包已复制到
`测试/记忆上下文插件测试/packages/`（该目录只留当前版本）。**字节数与 sha256 记在**
`docs/dev-0.13.2/进展卡-beta.3.md`——不写进本文件，否则「把哈希写进包」会改变包内容、
让哈希再次变化（自指）。

### 数据可恢复性（P0）

- **N-06a span 候选记错回执格式。** `v2/history.mjs` 给普通历史段候选记
  `receiptFormat = RECEIPT_FORMAT_SPAN`（5），而生产渲染器 `v2/runtime.mjs` 用的是
  `RECEIPT_FORMAT_SPAN_V2`（7）。恢复侧按行内版本重建，永远差「投影 / 可回读 / 命令面」
  三行 → 这类行 100% `restore-skipped`，理由还误报成「回执正文已变化，拒绝覆盖」。
  现在候选记 7，且 runtime 的 `receiptOf` 以**候选自己携带的格式**为唯一真源（两处不再各写一份常量）。
  真实会话 60 段归档里 **58 段**因此不可恢复。
- **N-06b 归档行没落 `spanLabel`。** 恢复侧只能回落成「历史片段」，而表面写的是
  「片段：用户消息」。现在随行落盘。
- **N-06c 归档行没落 `batchThreshold / batchMembers / releaseCapped`。**
  `commitSurfaceRun` 算出来了却没进 outcome。批次头因此只能回落成
  「8 个相邻操作已合并替换」，与表面的「本批 10/10 个操作」逐字节不同。
- **N-06 旧行迁移（不删数据、不放宽校验）。** 已归档的旧行改代码后仍缺字段，恢复走
  **有界候选集**：先用行内值严格重建；缺字段时按行内可反推的信息兜底（span 标签由
  `spanKind` 反推、批次口径由**表面回执自己**的「本批 N/M」反推），只有与表面
  **逐字节相等**的候选被采用，采用的差异写回归档行（`migratedAt`）。下次恢复不必再迁移。
  实测旧会话 58/60 段由此恢复，数据从未丢失（冷库载荷完好）。

### 设置面（P1）

- **N-08a 设置页读的是硬编码兜底值。** 宿主把 `.volatile()` 字段以**引用对象**交出
  （只有 `get()`），`client.js` 的 `settingsValueOf` 直接读属性 → 每个字段都是
  `undefined` → 全部回落到兜底常量。于是「改了的那一项」看起来自己跳回，而保存写回的
  也是这份兜底值，会**静默抹掉**用户改过的其它项。现在读之前先解引用。
- **N-08b `defaultFullHistory` 从未注入。** `v2/runtime.mjs` 声明了它、
  `runtime-lifecycle.mjs` 用它给新账本播种，但 `index.mjs` 构造时没传 → 恒走缺省
  `() => false`，「全历史记忆上下文」对**新会话**完全无效。现在注入。
- **N-08c `fullHistory` / `retainOperations` 补进 schema。** 两者一直是**未声明字段**，
  靠 schemastery 对未知键的宽容才活下来；宿主一旦收紧校验或走 `simplify()` 回写，
  用户勾选的开关会直接消失。

### 互斥（P2）

- **N-05 残留清扫「粗时钟比细时钟」。** `beforeMs = Date.now()`（整数毫秒）与
  `stat().mtimeMs`（带小数）直接比较，同一毫秒内产生的建锁残留会漏清——W-03 的守卫
  `audit/a` 因此变成**随机红绿灯**（实测 10 次红 3 次）。现在两侧统一到同一毫秒刻度
  （`Math.floor`）。判据仍是「早于本次获取开始时刻」，没有放宽成年龄宽限。

### 卡片与回注（P2）

- **N-01 全量卡同类目标题重复 N 次。** `softSectionsOf` 每个 retentionItem 造一段、
  标题只由类目决定 → 同类目 N 项 = N 个同标题段（真实卡里重复 11 次，白付 440 字符/步）。
  装包与丢弃仍按**每项一段**，只在渲染时合并（`mergeSoftSections`）：一个标题 + 全部内容行。
- **N-02 增量卡把新增的段标题当变化行再印一次。** 相邻两行完全相同且中间没有内容行。
  现在 `title === line` 不重复补标题，并剔除「后面没有任何内容行」的标题（截断后也剔一次）。
- **N-03 自动回注只有指针、没有正文。** 判据 `hasInformativeStructure` 只认范围/工具/
  spanKind，而归档操作**必然**三者齐备 → 纯壳照样注入。`recall` 为判定插件来源本来就把
  正文读进内存，现在把这段正文的**确定性首部切片**（160 字符）作为 `preview` 带进命中项，
  兑现回注包首行的「摘要预览，非原文全文」；结构事实（范围/工具/记录 ID）照旧保留。
- **N-04 全量卡写「类目兜底次序见全量卡」而它自己就是全量卡。** 该次序从未被渲染过。
  全量卡段头去掉自指，并把 `DROP_ORDER` 真印一行；增量卡保留「见本会话最近一张全量卡」（成立）。

### 回执可自查（P2）

- **N-07 `off` 回执写「原因见上」，而上面没有任何原因。** `disableRecord` 只取了计数，
  把 `runRestore` 的逐行报告整段丢掉。现在 `runRestore` 返回「原因 × 段数」聚合，
  `off` 与 `set fullhistory off` 的回执都写清原因（如「58 段：回执正文已变化」）。

### 验证

- 源码树与 `release/` 均 **113 套全绿 / 0 跳过**（2026-10-22，Node v26.12.1）；`v2-fix-p0` 的 span 断言
  改为生产口径（旧断言写死 5，与 runtime 渲染的 7 不一致——夹具替被测代码做了决定）。
- 回归集探针：**43 条全绿**（本轮 8 条新探针 N-01…N-08 全部由红转绿；`audit/a-lock-stage-orphan`
  由随机红变为稳定绿）。
- `scripts/revert-probe.mjs`：**39 OK / 4 遗留脱节**（新增 9 条 beta.3 场景全部「还原后测试失败」）。
- 新增守卫 `test/v2-beta3-regressions.test.mjs`（12 条，N-01…N-08 各至少一条 + 一条走真实入口的 e2e）。
- 夹具加固：`doc-command-surface` 读上层文档时归一 CRLF——发布仓以 `core.autocrlf=true` 检出，
  README 是 CRLF，不归一会让「文档没问题」也判红（在 `release/` 自测里实测）。


## 0.13.2-beta.2（2026-10-21）**测试版，未发布**

**缺陷排查批的收口：修掉 beta.1 遗留的 4 条必修项（W-01…W-04）、3 条 PR #8 审计剩余项，
外加实施时静态发现的两处同族缺口。不新增功能，不改产品边界。**

本版仍是**测试版**：源码树已改、测试全绿，但**未**打 tag、**未**推送 GitHub、**未**重出 tgz、
profile 依赖仍指向 `#v0.13.1`。发布动作见 发布流程。

### 互斥（P0）

- **W-01 同进程 `withWriteLock` 不互斥（issue #9 没修的那一半）。** beta.1 加的
  `acquiringLocks` 排的是「**获取**」不是「**持有**」：后来者在前一个回调执行期间就拿到
  重入句柄，两个 async 分支同时在临界区。实测 8 路并发 × 25 轮「读 → 写回 +1」只落
  25 条（丢 87.5%），层级账本写出两条 `entrySeq: 1` 并都报 `revision: 1`——
  `expectedRevision` 的 CAS 保护同时失效。
  现在 `withWriteLock` 按目录**串行**：后来者等前一个回调执行完才进入临界区；
  同调用栈的嵌套调用（`applyForgetUnlocked` → `loadDisposition` → `repairLedgerTail`
  这类真实形态）靠 `AsyncLocalStorage` 识别后直接执行，不会自锁。
  **跨进程那一半逐字未动**（198/198 无丢更新、ELOCKIO=0）。
- **W-01b 层级账本读路径仍在「读一次就删完整条目」。** `parseLedgerText` 是 D-01
  修复前的口径：文件末尾缺 `\n` 即判半行，完整合法条目被 `loadHierarchy` 在**读取动作里**
  物理删除（层级卡丢失、revision 回退、entrySeq 重号），且截断发生在写锁之外。
  现在与 disposition 同口径：先试解析再判半行，截断移进写锁、只对解析失败的尾巴生效。
- **W-01c 聚合凭证计划的读-改-写在锁外。** `saveVoucherPlan` / `dropVoucherPlan` /
  `dropVoucherPlansForRecords` 只给最后的整文件替换加锁，两个并发调用都基于同一份旧
  `plans` 计算，后写者整文件覆盖先写者（丢计划 = 那批凭证再也展开不回来）。现在整段进锁。

### 可用性（P1）

- **W-02 接管持续失败时无界自旋。** D-10 把 `takeOver` 的瞬态失败从「抛 ELOCKIO」改成
  「静默 return」，但外层 `continue` 之前既没有 sleep 也没有重查 deadline：只要目录
  rename 持续失败（Windows 上打开的句柄 / 杀软 / 另一进程 readdir），`acquireWriteLock`
  就是纯微任务空转——不返回、不抛错、CPU 打满，连 `AbortSignal` 都插不进去。
  这是修复引入的回归（旧行为难看但**会返回**）。现在 `takeOver` 如实返回 boolean，
  两个接管分支统一「查 deadline → 退避 50ms」，用尽抛 `ELOCKED`
  （`details.reason = 'takeover-failed'`），**不回落 ELOCKIO**。

### 资源与上界（P2）

- **W-03 两阶段建锁的中间物永久泄漏。** 进程在 `mkdir(stage)` 与 `rename` 之间崩溃，
  会话根下就永久留下 `.write-lock.<uuid>.tmp/owner.json`；接管用的 `.stale.*` 墓碑同理。
  现在拿到锁之后清扫一次：删「**早于本次获取开始时刻**」的 stage / 墓碑（按年龄会漏掉
  同刻出现的残留，按「早于我开始」则不会误删正在建锁的竞争者——它 rename 只会得
  ENOENT 瞬态 → 重试）。尽力而为，失败不影响加锁。
- **W-04 增量卡的字符上限被尾行突破。** `boundDeltaLines` 的尾行「另有 N 行变化未在本卡
  列出…」是无条件 push 的，长度不计入预算：24 行 × 80 字符填充实测 1644 字符 >
  `CARD_DELTA_MAX_CHARS`(1600)。现在尾行宽度按最坏 `rest` 预留、装完再兜底回退，
  `text.length <= maxChars` **严格**成立。增量卡是每步固定税，上界名不副实就等于没有上界。

### 诚实标注（PR #8 审计剩余三项）

- **`readRange` 内部 clamp**：`offset` 归一为非负整数、`maxBytes` 非法直接 `EINVAL`。
  `readRecord` 入口校验不变，这是给将来新调用方的兜底（`maxBytes=0` 会抛 RangeError、
  `offset=1.5` 会抛 ERR_OUT_OF_RANGE，两者都会被上层 catch 归成「数据损坏」）。
- **删掉死代码 `store.readJson`**：会折叠三态（`null`/`undefined`/抛错）的旧实现，
  全仓无调用点；在用的全是 `readJsonStrict`。
- **`integrity` 不再把「没校验」报成 `'ok'`**：全文读通、尺寸一致但 `verifyHash: false`
  时返回 `'unverified'`（`verified` 仍是独立一维）。消费者已按两维读取
  （`assertIntegrityAcceptable` 在 `!verifyHash` 时提前返回、fork 走 `verifyHash: true`），
  **无行为回归**。
- **拿不到记录 kind 时标 `'unknown'`**，不再冒充 `'tool-output'`——否则「读不到」与
  「确实是工具输出」在卡片上完全同形。

### 验证

**112 套 / 全绿、0 跳过**（Node v24.19.0）。新增 6 个守卫，全部接进 `npm test`：
`v2-write-lock-same-process`（8 路并发不丢更新 / 嵌套重入不死锁 / 跨目录不阻塞）、
`v2-write-lock-takeover`（接管持续失败必须在 deadline 内抛 ELOCKED）、
`v2-lock-stage-sweep`（崩溃残留被清、竞争者目录保留）、
`v2-hierarchy-concurrency`（并发 entrySeq 不撞号 + 完整条目无尾 LF 不被删）、
`v2-card-delta-cap`（尾行计入预算）、`v2-store-integrity-label`（没校验报 `unverified`）。
6 条都做过「改回旧实现 → 用例变红 → 复原 → 绿」（`scripts/revert-probe.mjs` 新增 6 个场景，6/6 全红）。
全矩阵读数为 **30 OK / 4 夹具脱节**——脱节的 4 条在本批之前就已失效（已用 `git show HEAD:` 核对，
本批未触碰那 4 处源码），脚本对脱节显式报错、不静默算通过。

### 诚实边界

- **W-01 的修复要小心重入**：改错会从「不互斥」变成「自锁」。同调用栈靠 ALS 帧区分，
  锁帧带 `active` 标志（锁结束后迟到的游离任务回到正常排队）；但**锁内 `void asyncFn()`
  起、且在外层锁仍持有时运行**的后台任务会被当作重入并发执行——不引入任务跟踪就无法区分，
  这是明确边界，不是待修缺陷。
- **跨目录锁序**：当前无任何代码路径同时持有两把锁；将来出现时仍需人工保证加锁顺序一致。
- **W-02 的触发条件是「目录 rename 持续失败」**：Windows 上是真实形态，Linux 上少见。
- **sweep 的竞态**：极端情况下删掉别的进程正在建的 stage → 它的 rename 得 ENOENT（瞬态）
  → 重试。安全性由「竞争失败走重试」保证，不引入新的失败模式。
- **`head + tail` 单独超限**是唯一例外（配置荒谬时），此时如实返回并保留 `truncated: true`。
- **未做**：GitHub 侧动作（合并 PR #7/#8、issue #5/#9 回帖、tag/push/Release）需另行授权；
  真实 985 段会话上的回注质量验证仍未做（改进文档 §7.4）。

## 0.13.2-beta.1（2026-10-21）**测试版，未发布**

**缺陷排查批：26 项真实缺陷的修复 + 8 条能跑红的守卫。不新增功能，不改产品边界。**

本版是**测试版**：源码树已改、测试全绿，但**未**打 tag、**未**推送 GitHub、**未**重出 tgz、
profile 依赖仍指向 `#v0.13.1`。发布动作见 发布流程。

### 数据与隐私（P0）

- **D-01 读一次账本就删掉完整合法的遗忘条目。** 旧实现把「文件末尾缺 `\n`」当成「崩溃残留
  的半行」，于是任何不走 `appendFile('…\n')` 的写入路径留下的完整条目，都被
  `loadDisposition` 在**读取动作里**物理删除：遗忘失效（此前遗忘的全部记录重新可见）、
  revision 回退、操作号从 `f000001` 重发。现在先试解析再判半行，且截断修复移进写锁、
  只对解析失败的尾巴生效。
- **D-02 `clean confirm delete-session` 重启后绕过「引擎仍启用」守卫。** 守卫只查进程内
  `records`；重启后它为空，而磁盘上 `state.json` 仍 `enabled:true`、`engine.json` 仍 active、
  日志里的 v2 回执仍指向这批记录。现在三源合一（任一成立或**无法判定**即拒绝），
  并在删除前把 `state.json`/`engine.json` 备份到 `v2/quarantine/deleted-session-*`。
- **D-03 commit 与在途 stage 交错会把已提交事务回写成「未提交」。** commit 不参与 stage 的
  串行队列，少 await 一个 stage 就会在 commit 之后把 `committedAt` 覆盖成 null，重启对账把
  整事务移进隔离区（commit 却返回成功）。现在 commit/abandon 先排空队列并标记句柄 closed，
  stage 在 push 前复查（失败关闭）。**诚实边界：现有两个调用点都是顺序 await，今天不自发触发。**
- **D-04 抑制静默关闭，`on` 回执照样宣称「已抑制」。** 版本闸门失败 → 协调器为 null →
  抑制根本没装上，而回执写死「已抑制」，`status` 里也没有那一行。现在 record 上记
  `suppression: { available, reason }`，回执按实况分支，`status` 增一行「真实灵枢抑制」。

### 互斥与门禁（P1）

- **D-05 写锁创建窗口被当场接管。** `readOwner` 在 `ENOENT` 时返回 `null`，而
  `isWriteLockStale(null)` 恒为 true。改为**两阶段创建**（临时目录写好凭证再 rename），
  「目录在而凭证不在」这个状态从根上不存在；旧版本残留的空目录按目录年龄（1.5s 宽限）
  才接管。
- **D-06 被接管者的心跳覆盖新持有者凭证**，导致新持有者 `release()` 静默失效、锁目录残留。
  心跳先读回校验 token，不符即停表并标 `lost`；`release()` 如实返回 false。
- **D-10 Windows 瞬态 `EPERM/EBUSY/ENOENT` 被打成 `ELOCKIO`。** 目录 rename 在「有打开句柄 /
  杀软扫描」下必然瞬态失败，旧实现把它变成「数据损坏」信号。现在按竞争/瞬态分流重试，
  用尽只抛 `ELOCKED`（可重试语义）。
- **D-07 后台 job 硬保护在真实形态下从未建立。** 正则把引号写在冒号之后，认不出
  `{"job_id":"h_x"}`（工具参数的正常形态）；终态判定又只要「正文含 id + 一个终态词」就解除。
  现在先 `JSON.parse` 递归取 `job_id/jobId`、正则只兜底非 JSON 文本；终态证据必须**同工具族**
  （`hive_spawn` 提交、`hive_poll` 报告终态），工具身份按 callId 反查，拿不到时只认结构化
  终态字段。
- **D-08 增量卡去重闸门让模型永久保留已撤回状态。** 键命中历史只说明「注入过这张卡」，
  不说明「模型手上就是它」。现在基线不是这张卡时落到增量分支，把差异说清。
- **D-09 guard 日志专用清单漏 3 个宿主真实事件**（`job/registered`、`job/settled`、
  `working-directory/change`）→ 含它们的操作区间永久 `unknown-event-type`、永不退热。
  已补齐，并新增与宿主清单做差集的守卫。

### 口径与边界（P2）

- **D-11** claim 配额 0 反而输出全部（`slice(-0) === slice(0)`）→ 现在配额 0 真的一条不给。
- **D-12** 预算 `null`/`''`/`[]` 被 `Number()` 归一成 0 → 与 `budget.mjs` 同源，未提供走默认值。
- **D-13** 在途调用与有效约束超配额时丢最新留最旧 → 改 `newestTake`，溢出计数改用同一把尺子。
- **D-14** grep 键 `<tool>|<pattern>|<path>` 无转义 → 键改成 JSON 数组，账本 version 升 2
  （v1 账本按 schema 不符失败关闭）。
- **D-15/D-16** `maxBytes` 非法值静默读全文、`offsetBytes` 非整数被伪装成 `payload-unreadable`
  → 入口校验直接 `EINVAL`，`#readPayload` 只映射 `ENOENT/EACCES/EPERM/EISDIR`，其余重新抛出。
- **D-17** 隐式事务号无上界 → 9 位文件名不被识别 → 该会话写路径永久不可用。现在显式/隐式
  共用上界校验，`recordId` 越界抛带 code 的 `EngineV2Error`（不再是裸 `RangeError`）。
- **D-18** abandon / 空提交 `rm` 掉意图文件后事务号跨重启复用 → 改为 rename 进隔离区，
  号继续占用（对账本来就把隔离文件名里的号算进 `maxSeenTxn`）。
- **D-19** 浮点配额把 `另有 1.2999999999999998 条` 印进模型可见卡片 → 与正文同一把尺子并取整。
- **D-20** 按 UTF-16 单元截断切在代理对中间 → 孤立代理、落盘成 U+FFFD。改为按码点切。
- **D-21** `ambiguousCalls` 检查排在「空范围」分支之后（`allowPlainText=true` 时**放行在途调用**）；
  活动面无助手消息时栅栏整段不判 → 前者上移，后者 `fenceAll: true`。

### 工程面

- **E-01（发布面，**本版未执行**）**：`release/` 工作树里 0.9.8 支持的 3 个改动仍未提交，
  tgz/tag 的版本闸门只认 0.8.1。**本版只改源码线**；提交/tag/pack/推送按发布流程另行执行。
- **E-02** 发布包的 `test`/`probe:host` 指向未随包分发的 `test/`：新增 `pretest` /
  `preprobe:host` 前置检查，在安装目录里给出「测试属于仓库、不属于包」的明确结论，
  而不是 `Cannot find module`。
- **E-03** 日志前缀残留 `memory-context-lab2:` 1 处已改，并新增静态守卫（此前**无任何测试**
  覆盖前缀，release notes 那句「已统一」没人验证过）。
- **E-04** `disposeAutoCooling()` 连续调用两次已删一处。
- **E-05** 死代码：`storage.mjs` 两个未使用 import 已删；`parseLedgerText` 三元两支相同已修。

### 验证

- **105 套件全绿、0 跳过**（2026-10-21，Node v24.19.0；源码树 `node scripts/test-all.mjs`）。
  0.13.1 是 97 套；本版新增 8 个守卫：
  `v2-disposition-integrity`（D-01）· `v2-clean-guard`（D-02）· `v2-store-guard`（D-03/15/16/17/18）·
  `v2-suppression-receipt`（D-04）· `v2-write-lock-guard`（D-05/06/10）· `v2-card-guards`（D-08/11/12/13/19/20）·
  `v2-key-and-order-guards`（D-07/14/21）· `guard-event-coverage`（D-09）· `log-prefix`（E-03）。
- **8 条做过「临时改回旧实现 → 用例变红 → 复原 → 绿」**（D-01、D-05、D-07、D-08、D-11、D-12、
  D-21a、D-21b）；其余守卫的判据是「参数非法必须 `EINVAL`」「差集必须为空」这类直接断言。
- **未做**：真实 A/B（同任务开/关插件）与收益量化；0.13.2 的发布动作。

## 0.13.1（2026-10-19）

**单引擎重构：彻底移除 v1，修复实测缺陷，收敛指令面。**

### 不兼容（升级前必读）

- **`/memory-lab2` 已删除。** 唯一命令是 `/memory-lab`，全部子命令都是顶层的
  （`card` / `cost` / `verify` / `forget` / `compress` …）。
- **v1 引擎已移除。** 旧会话目录 `sessions/<key>/state.json` **不再被读取**，也不会被删除或迁移。
  已归档的原文仍留在磁盘上，但插件不再提供恢复入口；确认不需要后可手动删除
  `$DSH_HOME/.memory-context-lab/sessions/`。
- **0.13.0 及更早的批次回执仍可恢复**（format 3 渲染路径冻结），但**新写入的回执使用 format 8**，
  其文案与 format 3 不同。降级到 0.13.0 会读不懂 format 8 的行——本版不承诺向后兼容。

### 新增

- **`help` 重排为分组帮助**：生命周期 / 回读与检索 / 证据与失效 / 主动遗忘 / 层级压缩 /
  会话迁移 / 设置与诊断。此前是一张 40 行平铺清单，且混着已删除的 `import-v1`。
- **回注的两个补充触发点**（F5）：同一回合内「重读同一文件」时触发一次；每 15 步兜底一次。
  此前自动回注只认新的人类提示——实测会话 1 回合 120 步，回注 0 次。
- **单步内合并多批**（F6）：同一次自动降温内继续提交，直到没有候选或达单步上限（4 批）。
  此前一步只提交一批，实测出现相隔 5 秒的两批，等于刚失效完又失效一次。
- **`status` 显示单批释放上限**：过去是隐藏常量，用户只看到「没按 10 个归档」。

### 变更

- **单批释放上限改为窗口比例**（默认 6.25%）。1M 窗口下等于原值 65,536，行为不变；
  小窗口下不再让一批吃掉三分之一上下文。
- **批次回执口径拆开写**（F2/F3）：`本批 N/阈值 M 个操作`（阈值与本批成员）与
  `本条回执覆盖其中相邻的 K 个`（段长）分开；被上限截断时明写
  「单批释放上限截断，其余留待下批」。此前只有一个「N 个相邻操作」，
  事后审计读不出阈值是否生效。
- **回执回读指路修正**（F4）：`可回读：memory_lab_recall(record_ids=[…])` 在前，
  `命令面：/memory-lab read` 在后。此前指路已删除的 `/memory-lab2`。
- **删除 `engines.json` 台账**：所有权只由 `engine.json` 表达。两份真源必然漂移——
  实测会话 c1787f24 里 v1 归档借道 v2 存储时写入 engine.json，把从未启用 v2 的会话
  判成「v2 持有」，重启后 `/memory-lab on` 被 EV2ACTIVE 拒绝。
- **删除预设（presets）**：全历史模式下「保留最近操作」失效，预设行没有可切换的内容。
- **`index.mjs` 1897 → 594 行**，`storage.mjs` 378 → 171 行；纯渲染器迁至 `v2/runtime-render.mjs`。

### 修复

- **F1** 引擎归属误判：见上「删除 engines.json 台账」。
- **F2/F3** 批次口径混用与短批无解释：见上「批次回执口径拆开写」。
- **F4** 回执指路失效：见上「回执回读指路修正」。
- **F5** 单回合长任务永不回注：见上「回注的两个补充触发点」。
- **F6** 同一步内多批替换放大前缀失效：见上「单步内合并多批」。
- **format 8 的恢复路径**：分组条件原先只认 format 3，新格式的行会被当成单条回执，
  永远对不上摘要正文（实现过程中发现并修复）。

### 验证

- **97 套件全绿**（2026-10-19，Node v24.19.0），**0 跳过**。`install.test.mjs` 11 项全部真正执行
  （profile 已升级到 0.13.1；此前那 3 项 SKIP 是路径编码缺陷造成的假绿，见「安装面断言长期 SKIP」）。
- **新增 12 个守卫**：`v1-residue`（基线式残留扫描）· `engine-ownership`（F1）·
  `batch-accounting`（F2/F3）· `receipt-affordance`（F4）· `v2-recall-trigger`（F5）·
  `runtime-module-budget`（单文件 ≤800 行 + 已知债务必须写明理由）·
  `runtime-domain-wiring`（域内「用了没声明」与域间「声明了没传」）·
  `panel-command-coverage`（面板/帮助/输入提示不得指向不存在的子命令或设置键）·
  `client-dead-entry`（删功能后不留死入口：Config 数据面 / i18n 死键 / 重复键 / zh-en 键集相等）·
  `settings-key-coverage`（折叠认得的键必须可写、每个键必须有分支、数字区间与 core 一致）·
  `doc-command-surface`（帮助/README 键位表与 `SETTING_KEYS` 集合相等、README 子命令都有 case）·
  `v2-store-hardening` / `v2-workingset-hardening` / `v2-compress-hardening`（见「缺陷总排查」）。
- **改回去必红**：`batch-accounting`、`runtime-module-budget`、`runtime-domain-wiring`、
  `panel-command-coverage`、`client-dead-entry`、`settings-key-coverage`、`doc-command-surface`
  与三个 hardening 套件各做过一次「临时改坏 → 用例红 → 复原 → 绿」。
- **测试面如实记账**：`session.test.mjs` 37 → 5、`reliability.test.mjs` 29 → 24、
  `v2-import.test.mjs` 删除（功能已移除）。这些是「不兼容老版本」的直接代价。

### P4 模块拆分

- **`runtime.mjs` 3588 → 617 行**，十个域模块各 ≤700 行：render 110 / fork 110 /
  compress 173 / settings 197 / cooling 293 / card 413 / forget 440 / read 521 /
  lifecycle 558 / recall 682。
- 函数体**逐字搬移**、语义零改动。拆分本身暴露并修掉 **5 个真实 bug**：`setSetting` 的
  未定义 `BT`、`auditInheritedArchive` 缺 `factoryFor`/`receiptTextOf`、`retrievalStatusLines`
  缺 `semanticBackendStatus`/`semanticBackendFailure`、`indexCommand` 缺三个 semanticBackend*、
  `recallTriggerOf` 缺 `latestReadPathOf`。其中 4 个在 89 套件全绿时也不会暴露。
- 装配顺序 forget → lifecycle → card → read → recall → compress → cooling；两处后置绑定
  （`compressDepsOf` / `invalidateLedgerForRestore`）用惰性取值避免 TDZ。

### 修复（面板与命令面对齐）

- **`/memory-lab clean confirm delete-session` 之前不存在**：面板「清理」按钮发的是
  `/memory-lab clean`，而命令面没有 `clean` 分支——点下去只得到帮助文本，冷库原封不动。
  更糟的是 `off` 与 `set fullhistory off` 在窗口守卫拒绝恢复时，**失败提示里写的就是这条
  命令**，等于把用户指向一条死路。现已实现：须两道确认词、引擎仍启用时拒绝、只删本会话
  隔离根（不碰会话日志与命令审计）。
- **`set autorestore` 键缺失**：面板「停用时恢复原文」开关一直发这个键，而 `setSetting` 的
  键位闭集里没有它，点了只回「未知设置键」。已补上（引擎侧 `disable` 路径确实读该字段）。
- **预设残留两处死入口**：预设功能已删（命令面无 `preset`，Config schema 无 `presets`），但
  ① 会话面板仍渲染预设下拉框（选一次只得帮助文本）；② 设置页仍有「新增预设」编辑器，
  点保存会把 `path: ['presets']` 写进 Config——schema 里没有该字段，保存必然失败。两处均已
  移除；旧日志里的 preset 命令仍会被投影折叠，视图字段保留。
- **i18n 清理**：删掉 13 个随功能删除而失去引用的键，修掉 2 组重复键
  （`field.compressModel` / `field.compressModelHint` 各重复一次，后者静默覆盖前者），
  并把 `client.js` 里 12 处裸 CR 换行统一为 CRLF。
- **日志前缀统一**：`apply-engine.mjs` 与 `runtime-settings.mjs` 各有一处 `memory-lab2:` 前缀，
  与其余 40 处 `memory-context-lab:` 不一致，已统一。

### 修复（缺陷总排查：15 处，2026-10-19）

P4 拆分完成后按要求做了一轮完整缺陷排查：三个只读复审并行通读高债模块
（`working-state` 2183 行 / `store` 1092 行 / `hierarchy-coordinator` +
`disposition` + `evidence-atoms` 2291 行），各自用临时目录探针实测，再逐条写**必红用例**
→ 修 → 复原验证。

**存储层（`store.mjs`）**

- **带正文却不声明载荷 → TypeError 且烧号**：`stageRecord` 在 `payload` 为 undefined 时
  解引用 `.hash`，抛的是 TypeError（不是 `EngineV2Error`，调用方按 code 分支全部落空），
  事务号与 WAL 意图文件一起残留。改为结构化 `ESCHEMA` 拒绝，事务仍可继续用。
- **只校验 hash、不校验 size → 记录永久不可读**：把 size 按**字符数**算（中文 8 字符 /
  24 字节）能提交成功，此后每次 `readRecord` 都判 `size-mismatch`、正文恒 null，
  记录仍在 catalog 里；fork 还会因 `integrity !== 'ok'` 直接 `EFORKINTEGRITY`。
  现在写入前就比对字节数。
- **并发阶段化拿到同一个稳定 ID**：ID 取自 `handle.records.length`，而载荷落盘是 await 点，
  一步里多个并行工具结果同时落库就会双双读到同一长度；后写覆盖先写，catalog 少一条而提交
  报告按两条算。改为同一句柄上的**串行队列**。
- **对账窗口里 `peekOpen` 能拿到半成品句柄**：`open()` 先登记再对账，于是 fork 的
  `acquireShared` 可能拿到 `#manifest` 未赋值的对象（`warnings` 抛 TypeError、
  `recordCount` 恒 0）。落在「manifest 已写、catalog 未建完」的窗口时，fork 把父闭包
  当空集合迁移 → **子库 0 条而命令报成功**（静默丢历史）。改为**对账完成后**才登记。
- **`offsetBytes` 在「全文不大于 maxBytes」时被静默忽略**：分块读拿到的是从头开始的内容。
  分块判据改为 `fullBytes > start + maxBytes`，起点越界返回空段。
- **WAL 写失败时事务号残留**：该号永久留在 `#openTransactions`（`hasOpenTransactions`
  恒 true、同号重试永远 `EINVAL`），本进程内无法自愈。失败时撤销登记。

**工作状态卡（`working-state.mjs`）**

- **否定/撤回被 positive 挤掉**：claim 配额按列表顺序截断，而生产路径按 seq 升序（最旧在前），
  于是最新的更正永远落选——与「否定/更正可见」的注释承诺相反，模型会按已撤回的结论行动。
  改为**否定/撤回优先**再补 positive。
- **`required: true` 从不生效**：`softSectionsOf` 没把 `required` 传到段上，预算装包
  又只按分值丢弃。现在随段传递，且预算不足时**必选**、退让链也只退非必选段。
- **`tokens: null` 印成「取回 ≈0 token」**：`Number(null) === 0`，把未知代价印成免费。
- **增量卡截断后变化行永不出现**：确认注入会把基线推进到本步全量卡，被省略的行此后不会
  出现在任何增量卡里（要等 ≤20 次注入后的周期性全量卡）。现在**截断即改发全量卡**，
  并把「完整内容以最近一张全量卡为准」这句不成立的文案改成「未在本卡列出」。
- **非有限上限把进度夹成 0**：`newestTake` 与 `take()` 对同一输入的行为相反
  （0 vs 全量），`limits.maxProgressItems: undefined` 时进度整段消失、连「另有 N 条」也不印。
  统一为「没设上限 = 不截断」。
- **未曝光结果保留最旧 6 条**：与进度列表（P2-5(d)）同一类「丢反了」，最新的未曝光结果
  只报数量并掉出最小依赖集。改用 `newestTake`。

**层级压缩（`hierarchy-coordinator.mjs` / `runtime-compress.mjs`）**

- **冷节点 id 被当成记录 ID**：回执正文只印 `mcl2-…`，而 `store.readRecord` 只认
  `tXXXXXXXX-rYYYY`，传进去直接 `EINVAL`——**层级压缩在真实库上从未跑通过**
  （「读不到就退化用回执文本」那条兜底也走不到，`body ?? receiptText` 兜不住 throw）。
  现在用与 read/forget 同一套只读身份索引做别名展开。
- **run 审计汇总行 `phaseKey: null`**：账本写入校验要求非空字符串，整批审计条目被
  `EINVAL` 拒绝，`compressRun` 又 `.catch(() => {})` 吞掉——一批里既有已应用又有被拒/
  失败时，被拒与失败行一起消失。
- **`compress status` 读不存在的 `ledger.repairNotes`**：`loadHierarchy` 只给
  `damageDetail`，账本一旦带损坏修复记录，status 直接 TypeError。

**设置面**

- **`set protect` 缺失**：`core.mjs` 的折叠认这个键、`apply-engine` 每轮读
  `settings.protectBudgetTokens`，但 v2 命令面没有分支——面板/日志显示「预算已改」，
  命令只回「未知设置项」，运行时保护预算永远是配置默认值。已补上（0..2,000,000）。
- **「未知设置项」提示是手写字符串**：删 v1 命令面时漏了 `autorestore`，用户按提示逐个试
  都试不出来。现在由 `SETTING_KEYS` 派生。
- **`set batch/retain` 只挡下界**：`set batch 100000` 回「已设置（重启后仍生效）」，
  而 `normalizeSettings` 对越界值是**回落默认**（不是夹取）——账本里存的是 10。
  现在按 `NUMERIC_SETTINGS` 的上界显式拒绝。

**文档面**

- `plugin/README.md` 命令块漏了 `recall` 与 `clean`（面板「清理」与 `off` 的失败提示
  都指向 `/memory-lab clean confirm delete-session`，唯一能救回死路的命令没写进安装文档），
  `set` 键位表停在 8 个键（实际 13 个）。
- 项目入口与 `docs/README.md` 仍写「合并版 0.12.0、双引擎、`/memory-lab2`」，已改为单引擎口径；
  `docs/降温模式.md` 加版本口径横幅（历史小节保留当时的命令名）。
- 删掉 `src/v2/_wiring.txt`（P4 拆分时的临时切片产物，会随包发出去）。

**新增 5 个守卫**（各做过「改回去必红」）：`v2-store-hardening`（6 条）·
`v2-workingset-hardening`（6 条）· `v2-compress-hardening`（3 条）·
`settings-key-coverage`（折叠认得的键必须可写、每个键必须有分支、数字区间与 core 一致）·
`doc-command-surface`（帮助/README 键位表与 `SETTING_KEYS` 集合相等、README 子命令都有
case、现行文档不得再教 `/memory-lab2`）。


**安装面断言长期 SKIP（第 17 处，收尾时发现）**

`test/install.test.mjs` 的三条安装面断言自 0.13.0 起一直 SKIP，理由写着「profile 安装的
版本与本仓源码不同（升级前）」。真实原因与版本无关：判断同版的探针用
`new URL(import.meta.url).pathname` 拼路径——那是**百分号编码**的，本仓路径含空格
（`deepseek Harness`）与中文（`Harness插件` / `记忆上下文`），`readFile` 必然
`ENOENT` → 探针恒判「不同版本」→ 三条断言**永远不执行**。

把路径换成 `fileURLToPath` 之后它们立刻真正执行，并立刻暴露出**两条过期断言**：
0.13.0 删 v1 后 `agent/pre-step` 监听器从 6 个变 4 个、prepend 回注从 2 条变 1 条，
而断言里写的是旧数字。也就是说：**这两条断言在 0.13.0 之后一直是假绿**。

修法：探针改用 `fileURLToPath` + 换行归一（profile 副本是 git checkout 的 CRLF，源码是 LF，
直接比字节同样会误判）；断言更新为单引擎口径（4 个监听器 / 1 条 prepend）；并新增两条守卫——
「探针必须真的读到两个文件」与「test/ 与 src/ 不得用 `URL.pathname` 拼文件路径」。
改回去验证：把 `fileURLToPath` 换回 `pathname` → 立刻回到 3 SKIP（假绿）；复原 → 11 项全过、0 跳过。

### 未完成

- 真实 A/B（同任务开/关插件）与收益量化不在本批。
- 未推送 GitHub、未安装到 profile、未重启 DSH。

# 更新记录

本文件记录 `dsh-memory-context-lab` 面向用户的版本变化。格式按「版本 + 日期 + 分类条目」组织，只写行为与契约层面的变化，不复制内部调研。

## 0.13.0 — 2026-10-18

这一版先修**数据不可恢复**，再修**降温净亏**：前者是「原文一定回得来」这条产品承诺的直接违背，
后者是「低占用时降温省下的是最便宜的缓存读、付出的是最贵的未命中输入」。同一版里做面板瘦身。

### 恢复闭环（P0，修复前 230 条归档里 221 条不可恢复）

- **归档回执退出折叠**：`isCardNode()` 曾把以 `[已归档操作·v2]` 开头的**归档回执**也判成工作卡。折叠把整组回执换成一条只留 `seq:` 的折叠回执，而 `restoreReceipts()` 按 `replacementSeq` 找节点——找不到就逐条 `skipped: 回执节点已不在活动面`。回执是 restore 的**唯一句柄**，折掉它等于删掉「原文可恢复」的承诺。现在折叠只治理工作状态卡；归档回执与回注包同为**断组边界**。
- **第二通道（冷库重建）**：回执节点已不在活动面时不再直接判不可恢复——按 `nodeId` 读冷库、核对 `archiveMac(body) === row.hash`，通过则在活动面重建原文（`rebuilt: true`）。hash 不符仍然失败关闭，绝不把来历不明的正文塞回上下文。
- **恢复对账不变量**：`restored + skipped + forgotten` 必须等于输入行数，不等即告警。这是 221/230 事件**静默发生**的直接原因——没有对账，少恢复的那些既没回来、也没被报出来。

### 压力闸门（P0，替代「无压力也降温」）

- **新判据 `src/v2/pressure.mjs`**：占用率（`assembledTokens / contextWindow`）达到阈值才自动降温；0 = 无压力也降温（旧行为，保留为显式选择）。实测会话占用 8.3%–13.5%，默认 20% 下它一次都不会归档——这正是修复。
- **滞回 + 动态死区**（智能论 3.4 §2.7.2）：进入 `enter`，退出 `enter − max(5%, 3σ)`，σ 取最近 30 次占用率的标准差、上限 20。防的是一次降温后在阈值附近反复抖动。
- **失败关闭**：占用率或窗口不可判定时**不归档**，`status` 写明 `pressure-unknown`。
- **观测面**：`status` 新增「压力闸门：占用低于进入阈值 / 已回落到退出阈值以下 / 占用率不可判定 / 闸门已关闭」四种如实理由；成本账本新增 `belowGateCount`。修复前这些只能从 `state.lastMeasurement` 里翻出来。
- **离线回放**：以真实会话 246 步占用序列为夹具，断言闸门 20% 下归档 0 次。

### 面板瘦身

- **删除四个开关**：「保留最近操作」（全历史模式下恒为 0，已是死开关）、「全历史记忆上下文」（唯一模式，不再需要开关）、「自动降温」（由压力闸门取代）、「自动回注」（恒开——它是取回闭环的一部分，不是应被关掉的选项）。
- **新增「压力闸门」一行**：开关 + 阈值（1–95）。开关关闭 = 写 0 = 无压力也降温。
- **状态行改写**：`降温状态 · 压力闸门（≥N% / 关）· 已归档 · 计划中`。

### 取回通道（P0）

- **`memory_lab_recall` 在 PTC 形态下可读**：`run_code` 里拿到的是原始 value，而 `ids`/`query` 模式此前不填顶层 `text`（只有 `working-set` 填），于是模型 `r.text?.slice(...)` 得到 `undefined`，判定回读失败并放弃——实测 246 步里**唯一一次回读**就是这样失败的（冷库其实返回了 779 token）。现在顶层 `text` 在**所有模式**下都是可判定的摘要 + 指针（不复制正文，一次回读只付一遍 token），工具描述同步写明这条读法。

### 插件消息不再冒充人类（P1）

- **`source.kind` 改为 `dsh-memory-context-lab`**：此前一律写 `'user'`，宿主侧所有按 `kind === 'user'` 取人类输入的功能都被污染。已取证的消费点：`dsh-session-title`（实测标题请求的 `messageSeqs` 是 `[31, 155, 157, 159]`，后三条全是归档回执）、`dsh-session-turn-outline`（用回执填「本轮提问」）、`dsh-session-reference`、`dsh-web-deepseek-api`；聊天 UI 对非 `'user'` 的 kind 走 `role:'inject'` 分支，比冒充用户气泡诚实。`dsh-session` 的 `user/message` 不变量对 `source.kind` 无约束（已核对 `lib/types/invariant.js`），日志不会因此打不开。旧日志仍是 `kind:'user'` + `form`，读取端按 `form` 识别，不依赖 kind。

### 折叠回执（P1）

- **标签如实**：归档回执曾被一律标成「回注包」——两者是完全不同的东西（回执是 restore 句柄，回注包是当轮检索证据）。现在按形态显式列出，未知形态写「未知形态」而不是猜。
- **区间有序**：成员按活动面顺序排列，`seq` 可能比左侧更早的节点小，于是出现过 `seq 243–189` / `802–770` 这种倒置区间（实测 4 处）。现在端点取 min/max。
- **最新全量卡永不被折**：增量卡的语义是「相对最近一张全量卡的变化」，全量卡是它的基准。实测最新全量卡（seq 2565）被折掉后，后续 5 张增量卡仍在引用一张模型看不见的卡。

### 验证

- **83 套件全绿**（2026-10-18，Node v24.19.0）；新增 6 套：恢复完整性、孤儿重建、压力闸门纯函数、压力闸门接线、PTC 回读、source.kind 契约、全量卡保护。
- **改回去必红**：恢复闭环与压力闸门各做一次「临时回退修复 → 用例失败 → 恢复修复 → 用例通过」。
- **离线回放夹具**：`test/fixtures/replay-c5af11b4.jsonl`（1,249 行 / 246 步，只留结构、工具名、字符数，不含工作区正文）。
- **未完成**：回执文案里的「相关提问会自动回注要点」未删——`buildBatchReceipt` 同时用于渲染与 restore 的**逐字节比对**，改文案必须配合回执格式号升级，纳入下一批；架构分层（kernel/store/host）与 v1 拆除、ReFold 去重/折叠算子、情节日志尚未开工。
### 0.13.0 补丁重打（2026-10-19）

首发的 0.13.0 在真机上暴露四处界面缺陷（排查报告 v1）。四处都是**读路径**问题：命令能写进去，界面读不回来。

- **面板「压力闸门」点不动（A2，核心）**：`viewOf()` 从未输出 `pressureGate`，而面板用 `view.pressureGate` 推 `pressureOn`——视图读到 `undefined` → 开关永远画成「关」、阈值框永远 disabled、状态行永远「未启用」，而命令其实已经写进会话设置，用户感知就是「点了没反应」。现在视图按 `0..95` 收敛后如实输出，越界或非整数回落 `DEFAULT_SETTINGS.pressureGate`（`0` 是合法值，不得回落）。
- **设置页常驻「配置加载中…」（B，核心）**：宿主用**同一个组件**渲染两个座位——描述行传 `{ view: 'summary' }` 且**刻意不传 `form`**，设置区传 `{ view: 'page', form }`。原实现在 `!snapshot` 早退分支里把「没有 form」当成「命名空间未服务」，于是详情页常驻一句把视图差异说成宿主故障的文案，而下方设置卡其实工作正常。现在 summary 分支提到快照判断之前，兜底文案改为「设置尚未就绪：宿主未提供本插件的设置表单」。
- **设置页配不到闸门阈值（C）**：`buildConfigSchema()` 的 `defaults` 块补 `pressureGate`（范围 `0..95`，与 `NUMERIC_SETTINGS.pressure` 同域，**不进 settingFields**——它是阈值不是档位）；设置卡的「全局默认设置」补一个数字输入行。**连带必改**：`settingsValueOf()` 是白名单构造，漏字段会让用户保存其他设置时把闸门整块抹掉，已同步。
- **v1 会话点闸门必然失败（D）**：该行硬编码 `/memory-lab2`，但闸门是 v1/v2 **共用**的引擎判据（`apply-engine` 的 `runAutoCooling`），v1 也接受 `/memory-lab set pressure N`。现在命令前缀按会话引擎分流。
- **权威状态记录补 `pressureGate`（P2）**：该机制的意义是「命令被拒绝时面板不得显示已生效」，闸门同样受此约束——否则被拒绝的 `set pressure` 仍会停在面板上。越界值丢弃（失败关闭），不写进记录。

**为什么 83 套没挡住**：`client.test.mjs` 手造了含 `pressureGate: 20` 的 view，只测「开关 → 命令」映射，从未测「投影 → 视图」这段契约；summary 用例只断言「文本非空」，而误报文案恰好非空。本批新增 `test/v2-pressure-view.test.mjs`（投影 → 视图契约 4 条），并把 summary 断言改成「**必须**命中摘要行 + **不得**出现任何未就绪兜底」——第一次只写了后半句，把分支关掉后用例仍然绿，是假绿。

**验证**：84 套全绿（2026-10-19，Node v24.19.0）；四处修复各做一次「改回去必红 → 复原必绿」（投影缺字段 4 红、summary 分支关闭 1 红、schema 默认值漂移 1 红、前缀硬编码 1 红）。
## 0.12.0 — 2026-10-18

把「归档—重读」自激循环修掉，并把**投影经济学**补齐：按灵枢统一架构 v1.2 **P5-3（率与失真必须同时声明）**，
让每条回执/工作卡都说清「释放了多少、失真等级、怎么取回、取回多少钱」，并让**最便宜的取回动作成为默认动作**。
事实前提：`memory_lab_recall` 在真实会话 303 步里被调用 **0 次**（`read` 182 / `pwsh` 109 / `grep` 80），而同键重读 55 次。
**已发布到 GitHub：tag `v0.12.0`（提交 `d0329d5`）与 Release 附件 `dsh-memory-context-lab-0.12.0.tgz`（139 文件 / 784.2 kB / sha256 `b74a1b23…1b23`，远端 digest 一致）已按补丁后的包重打覆盖**（见下「面板开关同步」）。安装状态以 DSH 为准，本包不代为安装或重启。

### 折叠语义（P0-6，硬前置）

- **回注包不再被卡片折叠吞掉**：`card-fold.mjs` 曾把 `recall` 算作卡形态，同一步的回注包（prepend）与工作卡（append）两条相邻 `user/message` 正好满足 `minRun=2`，下一次归档就被折成一条回执——**刚读回的证据从投影消失**，模型只能再读一次。现在 `recall` 移出 `CARD_FOLD_FORMS` 并登记为 `CARD_FOLD_EXCLUDED_FORMS`，是**断组边界**；人类/assistant/tool-result 仍是硬边界。
- **折叠计划改用活动面顺序**（不再按 seq 排序）：replace 事件拿到的 seq 比它左边仍在面上的节点大，按 seq 排序会把折叠回执挪到被保留的卡后面，于是下一轮把断组边界读成卡、把卡读成边界（每轮注 2 张卡时卡数不收敛）。

### 投影头与回读可用性（P0-5 / P0-1）

- **投影头**：每条回执/卡片加一行 `投影：A 类（可完整重建）｜释放 ≈N token / M 字｜取回 ≈K token`。失真只有 A 类（原文在冷库、可逐字节重建）；构造 B 类直接抛错。投影头 ≤1 行 / ≤120 字符，超限先丢取回段再丢字数列。取回代价取冷库载荷既有 token 估算，不新增计算。
- **新格式占新号**：操作回执 `format 6`、片段回执 `format 7`；旧格式 1/2/4/5 的渲染**逐字节不变**（恢复依赖逐字节相等，这是 format 4 引入时的教训）。
- **可回读动作行**：`记录 ID：按 … 别名回读` → `可回读：memory_lab_recall(record_ids=["mcl2-…"])｜A 类可完整重建`，命令面降到第二行 `命令面：/memory-lab2 read …`。新格式不再重复那句「相关提问会自动回注要点」（真实会话里一次都没兑现）。
- **工作卡「本步可回读」**：最多 3 条，每条 = 记录 ID + 工具/范围/对象 + 取回代价；**只描述结构、不复述正文**（复述正文等于撤销归档）；单行 ≤80 字符，超出的只报计数。
- **成本账本拆三路**：`toolRecallReads` / `commandRecallReads` / `fileReReads`（+ `fileReReadChars`），互不覆盖；修复前只有一个 `evidenceReReads`，把「按 ID 回读」与「重读文件」混在一起，于是插件以为自己「回读 0 次」。

### 读取账本与读取租约（P0-2 / P0-3）

- **`read-ledger.json`**：会话隔离根新增账本，键 `<path>|<offset>`，记 `seq/coldRecordId/hash/chars/firstSeenAt/reads/unchangedReads/lastReadStep`。归档含读取类结果的操作时登记；**不拦截、不改写工具行为**；`restore` 后失效、重启不清零、单会话上限 4,000 条按 `lastReadStep` 淘汰。
- **失败关闭**：账本不可读、不是合法 JSON、schema 不符，**或部分条目不可解析**，一律 `ok:false` 且不写盘——不静默重建为空。
- **`status` 重复读取两行**：口径 A（重读字符/全部内容字符）与口径 B（内容完全未变的重读）分开报，标「本账本口径」，不把看不见的历史算成 0。
- **`retainReads`（默认 3，TTL=2N）**：全历史模式下 `retainOperations` 仍为 0（设计不变），最近 N 个含读取结果的操作强制保留，M 步后租约到期并标 `readLeaseExpired`（转「需复核」）。这是**降权轴，不是保护集扩张**——v1.2 §8.3 的受保护集无界增长是未解问题。`retainReads: 0` 完全退回旧行为；写类操作不受影响。

### 卡片净占用上界与降噪（P0-4 / P1-6）

- **`CARD_NET_CHAR_CAP = 4000`（字符，不是条数）**：`MIN_OPERATION_CHARS = 1200` 对 span 同样生效，短卡永远进不了候选，所以按字符算。超上限时折叠**同一段连续卡组**（哪怕只有 2 张），不放宽 `minRun`（放宽会跨非卡节点吞掉助手消息）。
- **最新一张工作卡永远保护**：它是模型当前能看到的状态面；折叠回执保留**全部成员 `seq:`**（替换不是删除）；上界到了却折不动时如实告警并计 `cardCapUnreached`。
- **降噪**：丢弃页脚只报「类别 × 段/行数」，删掉逐条重要度打分算式；软段头不再重复整条类目次序；增量卡硬上限 24 行 / 1600 字符，超出只留「变化摘要 + 记录 ID」。

### 其它修复

- **`onEnabled` 失败语义（P1-1）**：`index.mjs` 注入的是**同步**对象，旧写法 `onEnabled?.(agent)?.catch(...)` 在同步返回值上访问 `.catch` 是 `undefined` → TypeError，且发生在 `enable()` 尾部、状态已落盘之后且不在 try 内：**命令显示失败，引擎其实已启用**。现在同步/异步都接，抛错（含异步 rejection）一律降级为提示「计划先行未生效」。
- **任务锚（P1-2）**：`isReceiptMessage` 改由单一常量表 `SURFACE_INJECTION_MARKERS` 判定（v1/v2 回执、折叠回执、聚合凭证）；无 `source.form` 的旧折叠回执不再被当成人类请求。
- **回注信息量门槛（P1-3）**：命中项必须有结构事实（范围/工具/片段种类）才注入；纯壳不注入，也不产生空块。
- **卡片角色一致性（P1-4）**：硬保护项带 `role`/`kind`；同一 seq 出现在两类硬保护时降级「角色未确认」并告警。不引入 `req:/evt:` 双命名空间（同号在本会话未复现）。
- **回执 status（P1-5）**：工具结果回执加 `status=ok|fail|partial`，失败附首错行（≤200 字符，不改写原文）；非工具结果标 `kind=message`。
- **检索口径文案（P1-7）**：工具描述与告警不再说「不含正文词」，如实写「覆盖记录 ID/kind/工具名/callId/范围，以及每条记录 ≤8 KiB 的正文词元（含中文二元组）」；描述与 `INDEX_TEXT_MAX_BYTES` 引用同一常量。

### 面板开关同步（0.12.0 补丁，2026-10-18 重打）

首发 0.12.0 漏了两处未提交的修复，真实新会话里表现为「开关闪一下又关掉、之后点不动」：

- **权威状态记录读错账本**：`recordAuthoritativeState` 只读 v1 的 `records`，v2 会话永远读到空账本，于是每条状态类命令后写出的 `plugin:dsh-memory-context-lab/state` 都是空账本默认值。现在按引擎归属取对应账本（v2 读 `v2.records`）。
- **缺席的开关位被按默认 false 补齐**：v2 账本没有 `planFirst`、v1 账本没有 `fullHistory`，旧实现一律补 `false`，于是每写一条权威记录就把刚折叠出来的开关压回关。现在**账本没有的位不表态**（投影保留日志折叠值），而**v2 专属位在 v2 不持有时写 false**——否则面板会停在「降温已停用、全历史仍显示开」，再点只得到「v2 引擎未启用」，看起来就是关不掉。
- **`shareL2Content` 补进权威字段表**（原实现折叠时被静默丢弃）。
- **`/memory-lab set planfirst` 支持 v2 会话**：旧实现只看 v1 账本，v2 会话里既不落账、还误报「本会话尚未启用降温」。
- **回归**：新增 `test/v2-authoritative-ledger.test.mjs`（4 项，走插件真实入口 apply → 命令 → 投影重放），覆盖「开 → 关 → 再点启用降温不回退」完整往返。

### 测试与验证

- **76 套 / 790 项断言全绿**（Node v24.19.0），新增 14 套；`entry-coverage` 保证入口 == 磁盘。
- **6 个 P0 各做一次变异必红**（改回去 → 对应新套件红 → 复原 → 绿）：P0-6a / P0-5a / P0-1a / P0-2a / P0-3b / P0-4c。
- **蜂巢**：确定性全量（job `…_0006`、回修后 `…_0007`）与只读独立复审（job `…_0003`，verdict REJECT → 2 条 finding 已回修并加回归）。
- **探针**：`probe:revert` 28/28、`probe:lingshu` exit 0、`probe:host` SKIP（未提供 `--asar`）。
- **面板开关补丁**（同日重打）：`v2-authoritative-ledger` 4 项全绿；源码线 `test:all` 与 `release/` 镜像各自 76 套 / 790 项全绿。

### 兼容性

- **不新增/不删除模型可见工具**（工具集逐字节不变，前缀缓存纪律）。
- **旧格式回执与旧日志**：format 1/2/4/5 渲染不变，旧折叠回执按标记识别；`read-ledger.json` 缺失时按空账本处理。
- **不阻止重读、不自动回注正文、不恢复 v1 保留数、不扩保护集、不做 B 类有损投影、不放宽折叠阈值、不改 `MIN_OPERATION_CHARS`**。
## 0.11.0 — 2026-10-18

收口 0.11.0 开发线：修掉三个 P0 缺陷（两个「写坏会话日志」的、一个「命令被拒绝但面板照样翻开关」的），
完成计划里剩下的 T1（卡片默认脱敏 + `shareL2Content`）、T2（压缩成员级排除）、T3（弱候选置信度统一）。
**不改变 v1 命令面；已发布到 GitHub（tag `v0.11.0`，Release 含 `dsh-memory-context-lab-0.11.0.tgz`，124 文件 / 734.6 kB / sha256 `4036a271…706a`）。未安装、未重启 DSH。**

### 会话日志完整性（P0）

- **替换节点缺 `data.source`（持久性损坏）**：`session.append(type, data, opts)` 的 `opts` 只认 `surfaceOp`/`sourceEventSeqs`，其余键静默丢弃；插件把 `source` 写进 `opts`，落盘的 `user/message` 就没有 `source`，宿主投影无保护地读 `event.data.source.kind` 抛 `TypeError`，整条历史从此打不开（`SESSION_QUERY_CORRUPT_SESSION`）。已复发两次。现在折叠回执与凭证的 `source` 一律写在 `data` 里，并补 `id`/`role`；`test/v2-surface-source.test.mjs` 静态守卫 + 动态断言防回归（把 `source` 挪回 `opts` 必红）。
- **`compaction/prune.shadowedSeqs` 与活动面不符**：提交点用 `run.flatMap(unit => unit.shadowedSeqs)` 拼名单，区间里若夹着插件自己的回执（seq 数值比区间末尾大、位置却在区间内），它不会进名单 → prune 落盘即非法 → 下次冷加载报 `SessionFormatError`，紧随的 replace 也被宿主拒（`sourceEventSeqs must include every shadowed surface node; missing <seq>`），该区间**永远归档不掉**。现在提交点按**活动面位置切片**取名单（`resolveCommitSpan`：两端必须在面上、顺序正确、逐项相等，否则失败关闭不写 prune），`shadowedTokenCount` 与名单同源，对账差额归零（不放宽容差）。

### 面板状态与真实状态一致（P0）

- **命令被拒绝时面板不再假装已生效**：宿主把每次斜杠命令都记成 `command/run`，投影只能按命令行折叠，看不出这次调用成没成——「关闭降温」被维护窗口拒绝（返回红字、持久状态一个字节没动）时面板照样翻成已关闭。现在每条状态类命令结束后（**成功或失败都写**）追加一条权威状态记录（`plugin:dsh-memory-context-lab/state`），值取自当时的真实记录/引擎状态；投影折叠到它时直接覆盖开关位，重放（resume/fork）同样生效。宿主拿不到 `appendPluginRecord` 时如实降级并在命令回执里说明，绝不假装写过。

### 隐私与披露（T1 / F-03）

- **L1 证据卡 / L2 阶段卡默认不复制正文**：摘录、跨度摘录、结论行这类自由文本原子的值默认渲染成固定标记 `（正文摘录未共享）`，只保留 entity、属性标签、极性/关系标签、来源 ID 与展开入口；结构化属性（`exit 1`、`465 项全绿`、版本号、错误签名）照常保留。新增插件级开关 `shareL2Content`（默认 `false`，失败关闭），显式开启才在卡里放正文摘录。
- **开关覆盖全链路**：程序卡渲染、L1/L2 卡、模型相位的输入行（建块时就脱敏，保证模型消息、预算计量、`blocksHash` 与最终卡同源）、崩溃重放的 L1 占位都受同一开关约束；两种模式各自逐字节稳定（前缀缓存不受无谓扰动），卡里带一行恒定模式说明。
- 命令面：`/memory-lab2 set sharel2content on|off`；设置页「全局默认」增对应复选项；面板在 `engine === 'v2' && compressOn` 时显示开关。

### 压缩成员级排除（T2 / F-15）

- **一条遗忘不再废掉整组**：此前任一成员被遗忘即整组 `member-forgotten` blocked，同组其余成员永远压不掉。现在只把被遗忘成员**排除出参与集**：不读其正文、不进 L1/L2/`sourceRecordIds`/`leafIds`，其余成员照常蒸馏；全部成员被排除时仍整组失败关闭（没有安全子集）。
- **计划 schema 2**：`recordIds` 语义收紧为「参与蒸馏的子集」，新增 `excludedRecordIds`/`excludedMembers`（`{recordId, seq, reason}`）/`memberDigest`（sha256 前 12 位）；`memberSeqs`/`memberTexts` 仍是表面全集，区间身份与 `voucherId` 因此不变。v1 计划（无 `planSchema`）保持整条作废语义。
- **披露有边界**：凭证文本与 L2 卡头只在真的排除了成员时追加一行（「M 段成员因遗忘未参与聚合」）；无排除时输出与 0.10.x **逐字节一致**，既有断言不被被动。
- 设计定稿：0.11.0-压缩成员级排除设计-20261018.md。

### 检索置信度（T3 / F-09）

- **统一 exact 后验**：抽成纯函数 `exactPostfilterHit` + 共用驱动 `applyExactPostfilter`，检索通道与弱候选诊断走同一份判定（此前各写一份，口径会漂移）。
- **弱指针带可机读置信度**：`weakPointer: true`、`isHit: false`、`confidence: { kind: 'weak', score, coverage, exactVerified }`；不通过 exact 后验的弱候选如实丢弃（「弱」不是免责条款）。回注文案改为「弱指针（不是命中），只给 ID，不计入回读计数」。
- **真实灵枢端到端**：本机 `@furongjun1999/dsh-memory@0.8.1` 的 `md_cg/writepipe.py` 导入 `node_write_lock`，而 `md_cg/fsutil.py` 没有该符号，导致开发树灵枢写入全坏；已在 lingshu 检出补回（commit `601c8ebf`，跨进程排它锁复用既有 `FileLock`）。`npm run probe:lingshu` exit 0，`test/v2-lingshu-integration.test.mjs` **3/3 真实通过**（不再 skip）。

### 测试与文档

- 测试套件 **62 套全绿**（新增 `v2-surface-source`、`v2-share-l2-content`、`v2-weak-pointer`）；`entry-coverage` 保证入口 == 磁盘。
- 文档：`docs/降温模式.md`（脱敏边界与权威状态记录）、`docs/验证与评估.md`（套数/断言数/灵枢版本）、`docs/演进路线.md`、`docs/README.md`、`plugin/README.md`、`AGENTS.md`。
## 0.10.1 — 2026-10-17

本版在 0.10.1 开发线内完成外部取证复核后的 16 项缺陷修复。**版本号保持 0.10.1**，不另开补丁号；0.10.1 功能面（回读闭环、检索契约、卡治理、助手结论盘点）见 `docs/降温模式.md` 同日修订与 `docs/演进路线.md`。

### 修复 — 安全红线

- **普通历史段归档可恢复（BUG-001）**：v2 的非工具操作跨度归档行改用专用回执格式 5 并记录 `spanLabel`；恢复侧按行内 `receiptFormat` 显式 dispatch，用 `buildSpanReceipt` 逐字节重建。0.10.1 旧 format 4 span 行没有可重建标签时如实 skip 并指路 `/memory-lab2 read <nodeId>`，绝不猜测覆写。
- **人类消息硬保护覆盖两种记录形态（BUG-002）**：`forget` 宽条件同时拦截 verbatim `turn.user` 记录与 `projection.span`（spanKind=turn.user）；显式点名仍允许但带警告。修复前 `kind=turn.user` 宽条件可软遗忘全部人类消息。
- **停用路径不再崩溃（BUG-003）**：measure 抛错时 `off` 与 `set fullhistory off` 不再因未定义 `ctx` 抛 ReferenceError；恢复照常尝试、停用状态照常落盘，测量失败留告警。

### 修复 — 功能

- **层级压缩自动收尾真实生效（BUG-004）**：补上 `maybeStageCompress` 导入；钩子可注入用于观测，失败日志保留错误类型。
- **未启用会话的 forget 命令（BUG-005）**：`forget preview/apply` 返回 `ENOTENABLED` 结构化错误；`forget undo` 仍可完成账本级撤销，没有活动面时如实说明而不是 TypeError。
- **expand 分页原文对齐（BUG-006）**：第 2 页起按全量成员数组偏移取原文，遗忘占位不再错位到其他成员。
- **L1 证据卡有内容（BUG-007）**：按成员自己的事实原子（entity/attribute/value）渲染，不再用不带来源的渲染块反查导致空卡。
- **compressModelDefault 读对层级（BUG-008）**：经 `defaults` 解包读取；设置页开关能真正播种新 v2 账本。
- **投影折叠解包 getter context（BUG-009）**：每次折叠调用 `getPresets()/getDefaults()` 取新值，resume/fork 重放与命令执行一致。
- **批摘要残余成员恢复（BUG-010）**：批组成员被逐条剔除后不再用 `buildReceipt(formatVersion=3)` 抛错中止整次 restore；完整重建对不上时，只在表面仍是该组摘要且逐条列出剩余成员冷记录与 hash、或表面已被 forget 换成该组墓碑（按「来源：seq <旧替换 seq>」认领）时，部分恢复可见成员原文；已遗忘成员绝不复活，其余情况仍 fail-closed。

### 修复 — 如实性

- **测试摘要同行 passed+failed（BUG-011）**：先收集整行全部通过/失败数字再聚合；`failed>0` 必报失败，未说明项不再判「全绿」。
- **未验载荷不冒充已验证（BUG-012）**：`readRecord` 增加 `verified` 维度；工作集头部扫描路径把 `verifyHash:false` 的载荷标为 `ok(unverified)` 且 `verified:false`，`integrity:'ok'` 不再被读成「完整校验通过」。
- **损坏账本状态（BUG-013）**：`hierarchy.jsonl` 与 `disposition.jsonl` 首行损坏优先报 `damaged`，不再先命中 `absent`；空文件/ENOENT 仍为 `absent`。
- **旁证损坏冻结重采（BUG-014）**：验证旁证损坏重建时写入 `frozenBefore`；早于该时点的记录拒绝补采指纹，已改动文件只能判 `unverified`，不会被当前哈希洗成 `valid`。`mark-stale` 仍可继续写人工标记。
- **recall 别名预算与游标（BUG-015）**：别名展开的预算判定不再双扣已用 token；中断时回滚本别名已装下的部分并把游标指向「未处理」前缀，续读不漏读也不重复。装得下的别名正文不再被误报「预算不足」。
- **T2 幂等重写核对字段（BUG-016）**：`committed:false` 回读核对 `content`（真实 `normalizeNodeRead` 契约），内容一致的重写走重试成功分支，不再误报冲突。

### 测试

- 新增 `test/v2-fix-p0.test.mjs`、`test/v2-fix-p1.test.mjs`、`test/v2-fix-p2.test.mjs`，逐条覆盖上述 16 项修复；回退对应修复时测试变红。
- 既有 `v2-lingshu-backend.test.mjs` 的冲突/幂等用例改用真实回读形状 `{ ok, content }`（不是 `text`）；`v2-agg-voucher.test.mjs` 的分页用例改为传入全量 `receiptTexts`（与真实 `expandVoucher` 调用一致）。
- 全量 `npm test`：57 套 664 项 0 失败（2026-10-17，Node v24.19.0）。`npm run probe:revert`：20 个回退场景全部「还原后测试失败」；同步修复探针在 Windows CRLF 下多行还原点失配的问题，并统一加 `--test-force-exit`。

## 0.9.1 — 2026-10-15

**紧急修复版**：0.9.0 正式版有一处读取错误会让整个插件加载失败（插件页显示「异常」），本版修正并补上回归防线。行为与 0.9.0 宣称的能力完全一致，无新增特性。

### 修复

- **插件加载失败（0.9.0 正式版引入）**：装配期读取检索后端配置时写成了 `ctx.config?.defaults`。`config` 是 `apply(ctx, config)` 的第二参数，**不是** context 属性；宿主 cordis 的 context 代理对未注入属性是**抛错**而非返回 `undefined`（`cannot get property "config" without inject`），`?.` 拦不住抛错。该行一执行即抛出并冒泡出 `apply`，插件加载被回滚——两个命令、投影与只读召回工具全部消失。已改为读取 `config?.defaults`，与同文件 `resolveDefaultsSettings` 等既有读取口径一致。
  - 影响面：0.9.0 正式版（`82e751b` 引入，PR #4 整合）。0.9.0-rc.6 及更早版本不含该行，不受影响。
  - 触发条件：必然触发，与配置内容、是否装 `dsh-memory` 无关。

### 测试

- `test/install.test.mjs` 新增回归防线：替身把 `config` 建模为「读取即抛」（与既有 `tools` 替身同形），并新增一条静态+动态断言（源码不得出现 `ctx.config` 读取，且 `apply` 在抛错替身下必须成功）。该防线对 0.9.0 的坏副本会如实报错（实测指向 `src/index.mjs:418`），修复后通过。
- 0.9.1 全量 `npm test`：32 个测试文件全绿，0 失败 / 0 跳过（2026-10-15，Node v24.19.0，`exit=0`）。计数口径：node 标准汇总 31 套 418 项（与 0.9.0 的 417 项同口径，+1 为本版新增的 `ctx.config` 守卫），另有 `v2-store.test.mjs` 走自带汇总 15/15——合计 433 项。0.9.0 条目里的 417 项即不含 v2-store 的自定义汇总，两版可直接相减。

## 0.9.0 — 2026-10-15

首个正式版。本版合入社区 PR #4（灵枢作者提交的《四端口接口设计》《独立架构方案》两份设计文档，已按 0.9.0 现状核对并加状态注记），并实现设计中除归并固化、主动遗忘外的全部能力缺口（两项按用户决定列为 0.10.0 候选）。

### 新增

- **验证跟踪**（`v2/verification.mjs`，PR #4 设计）：v2 归档事务提交后，对 `operation.call` 记录按白名单字段（`file_path`/`path`/`workdir`，仅绝对路径）采集文件 sha256 指纹，写入会话目录旁证文件 `verification.json`（原子写、幂等差集）。新命令 `/memory-lab2 verify <记录ID...>`（三态核对：valid / stale / unverified，只读）与 `/memory-lab2 mark-stale <记录ID> <原因>`（人工失效标记，只写旁证，不改不可变记录）。口径如实声明：指纹回答「文件现在与归档时是否一致」，不承诺「与工具当初读取时一致」；无指纹或文件不可读报 unverified，不猜测；旁证文件损坏时失败关闭（全部 unverified + 告警，绝不伪造 valid）；v1 引擎不接（如实标注）。
- **检索后端显式指定**（配置 `retrievalBackend`，PR #4 端口二）：`auto`（默认，行为零变化）/ `local-lexical-v1`（不尝试 T2）/ `lingshu-mdcg-receipt`（强制灵枢）。显式指定灵枢而不可用时**失败关闭**：启用预检失败拒启用（`EBACKENDUNAVAILABLE`）、握手失败不降级（`EBACKENDPINGFAIL`）——不静默降级到本地后端。
- 错误码 `EBACKENDUNAVAILABLE` / `EBACKENDPINGFAIL` / `EVERIFICATIONSTALE` 随上述行为落地（`EVERIFICATIONSTALE` 标注 verify 的 stale 分支结果，stale 是合法答案不是异常）。
- `read`/`recall` 命令与 `memory_lab_recall` 工具回读已人工标记失效的记录时附失效注记（工具 input schema 不变，工具集恒定红线不破）。

### 变更

- `v2/lingshu-backend.mjs` 改为装配期动态 `import`（PR #4 依赖图约定）：主装配路径与 T2 实现解耦；加载失败走既有 `startupError` 失败关闭路径（auto 模式如实降级本地后端并留痕）。实际收益是装配解耦，该模块本就只依赖 node 内置，不宣称性能收益。
- 发布包 `files` 增加 `docs`（PR #4 两份设计文档随包分发）与 `CHANGELOG.md`。

### 修复（文档）

- PR #4 两份文档三处过时表述以状态注记修正（不重写原文）：`getNode`「需补一个方法」实际已具备；「解绑灵枢」第一步实际 rc.6 已完成；`working-state.mjs` 行数快照漂移（1961 → 2025）。

### 文档

- `release/docs/` 新增 `interface-design.md`（四端口接口契约、验证跟踪、错误码）与 `architecture-design.md`（独立架构方案、实施计划与 0.10.0 候选注记），头部附 0.9.0 状态注记（2026-10-15 核验）。
- 工作文档 `docs/演进路线.md` 登记 0.10.0 候选：**归并固化（层级压缩）**与**主动遗忘（精确遗忘）**——摘要主体、墓碑机制、不可变不变量的让位范围均需先出设计再动工。

### 测试

- 新增 `test/v2-verification.test.mjs`（5 项：白名单字段提取与绝对路径过滤宁少勿错；capture→check 三态往返；markStale 只写旁证不改本体；旁证损坏失败关闭；syncVerification 差集防「事后改动洗白」）。扩展 `test/v2-retrieval-provider.test.mjs`（预检失败关闭、握手失败不降级、强制 local 不试 T2、auto 语义不变防回归）与 `test/config-contract.test.mjs`（retrievalBackend 枚举校验）。
- 0.9.0 全量：31 套、417 项断言（417 通过 / 0 失败 / 0 跳过，2026-10-15，Node v24.19.0；rc.6 基线为 29 套 407 项、5 项环境性跳过）。

## 0.9.0-rc.6 — 2026-10-15

本版合入社区 PR #3（独立运行——本地冷库客户端与本地词法检索后端），并补上合并复核发现的两处缺口（D1/D2）。

### 新增

- **独立模式**：不再要求安装 `dsh-memory`。冷库、冷写、字面检索由本地实现承担，新增**本地词法检索后端**（纯 Node：CJK 二元组 + ASCII 词元倒排，无外部进程；词条上限 20 万、超限如实标注覆盖边界）。装了 `dsh-memory` 时灵枢后端（T2）照常优先，且要求 mcp_server 完成握手才启用。
- **启用注记对齐实际能力**：未装 `dsh-memory` 时启用文案改为「以独立模式运行」，不再宣称「归档与回注会失败关闭」（本地冷库可用后那是假话）。

### 修复（合并复核）

- **状态面虚报生效检索后端**（D1）：复合检索后端的 `describe` 此前按「灵枢 root 在场」即报灵枢为生效后端，但灵枢未为任何会话启动时实际生效的是本地词法后端。现在顶层 name/capabilities 按「灵枢已启动会话 > 0」取值，未启动期如实报本地后端（`defaultBackend` 字段恒报本地后端名）。
- **旧 v1 冷库升级后静默读不回**（D2）：升级前经灵枢子进程归档的 v1 冷库（`sessions/<键>/mdcg/`，灵枢 contextual 节点格式）无法由本地冷库客户端读取；若该会话仍有待恢复或已跳过的回执，`on`/`status`/`restore` 现在会附注「旧回执原文已读不回、数据仍在磁盘不会被删除、回收磁盘走 `clean confirm delete-session`」，不再让用户在不知情下以为旧回执仍可恢复。

### 变更

- `@furongjun1999/dsh-memory` 从必需 peer 降为**可选** peer，并加显式版本上界。
- `off` 文案自洽：冷节点缺失导致未能恢复的回执，随冷库回收时改述为「已随冷库一并清除」，不再与「仍依赖冷库」同段出现。
- ⚠️ **升级注意（v1 会话）**：升级前若已有经灵枢子进程归档的 v1 冷库，其原文载荷在灵枢格式内。升级后建议先 `/memory-lab off` 恢复原文，或保持 `dsh-memory` 安装（T2 路径照常可读）。

### 文档

- 据实测会话取证补两条说明：README 解释回执「批次归档：N 个相邻操作」的 N 为何可小于批量阈值（受保护/不够格/冷写失败的单元把连续段切断，非漏归档）；用户观察到的「长时间不动」经日志取证为供应商 API 空响应/流空闲超时（300 s）重试所致，非插件卡死，未作代码变更。

### 测试

- 新增 `test/v2-local-lexical.test.mjs`（本地词法后端：词条化、AND 语义、持久化、增量幂等、词条上限如实报、崩溃重建）与 `test/v2-local-client.test.mjs`（本地冷库客户端）。
- D1/D2 各补守卫断言：未启动灵枢时复合 `describe` 报本地后端（`test/v2-retrieval-provider.test.mjs`，含 backendFor 兜底与 close 语义）；旧 mdcg 冷库在场时 `status`/`on`/`restore` 附注升级出路（`test/session.test.mjs`）。
- 0.9.0-rc.6 全量：29 套、407 项断言（402 通过 / 5 环境性跳过——lingshu 可选化后的真实集成项，受限会话如实 SKIP），失败 0（2026-10-15，Node v24.19.0）。

## 0.9.0-rc.5 — 2026-10-15

本版修复 5 条用户上报的缺陷（C1–C5），全部集中在**关闭链路**：计划先行的退出、面板布局、以及 v2 会话里「关不掉 / 恢复卡死」的三处引擎失同步。

### 修复

- **关「新会话计划先行」后计划模式不退出**（C1，用户上报）：`set planfirst on` 会进入宿主计划模式，`off` 只翻开关位、从不退出。现在 off 时若本会话计划模式处于 active/pending，经 `planMode.set(agent, false)` 联动退出（服务缺失时回退 `plan/mode {active:false}` 会话日志落账，与进入路径对称；读不到状态时如实降级不联动）；输出如实报告退出结果。`/memory-lab` 与 `/memory-lab2` 两命令面行为一致。
- **面板开关后的状态文字把标签挤成竖排**（C2，用户上报）：「已启用 · v2 引擎 · 自动 · 归档 N · 计划模式」等不收缩的长状态把行 min-content 撑破弹层内容宽，标签被压到 1 字宽竖排。现在开关后**不再渲染任何状态文字**；这些信息（降温状态 / 全历史 / 计划先行）移入底部原「暂无输出」框——状态摘要恒显，最近一次命令输出追加其下。布局同步硬化：标签永不换行（溢出省略号）、行不横向溢出。
- **v2 会话关「启用降温」引擎照常运行（「关不掉」）**（C3，用户上报，会话 c250b0cf 取证）：面板「启用降温」off 发的是 v1 `/memory-lab off`，在 v2 会话返回「未启用」却把面板折叠成已关，v2 引擎继续每步归档。现在 `/memory-lab off` 在 v2 持有投影（engine.json active）时**转交 v2 停用路径**（先恢复原文、再停用、释放引擎声明），输出注明转交；面板零改动即收敛——现存失同步会话敲一次 off 即恢复一致。这是 `/memory-lab off` 的公开语义变更。
- **先关「全历史」再关「启用降温」后，恢复原文永久卡死**（C4，用户上报）：`set fullhistory off` 只翻开关位不恢复，归档原文仍以回执形态留在投影里。现在关全历史**先恢复原文（带窗口守卫）再翻开关位**：恢复会让组装输入超出模型窗口时如实拒绝并给出路（原文留在冷库、开关照翻）；恢复失败不阻断关闭、逐条如实报告。v2 停用路径（含转交）同步补上与 v1 `normalizeAndStop` 同口径的窗口守卫。
- **`onPlanFirstToggle` 回调同步返回时 v2 `set planfirst` 崩溃**（C5，本轮守卫自证发现）：`?.catch` 假定回调必返 Promise，同步对象直接 TypeError。调用点统一经 `Promise.resolve` 兜底。

### 测试

- 新增守卫用例：`plan-first.test.mjs` exitIfActive 五分支（active/pending/inactive/服务缺失回退落账/全缺如实降级）；`v2-runtime.test.mjs` 关闭语义端到端（on→batch 1→fullhistory on→now 真实归档→fullhistory off 先恢复 N/N 再翻位；planfirst off 联动退出；v2 持有投影时 `/memory-lab off` 转交）；`client.test.mjs` 面板无 `mcl-status` 节点、状态摘要落底部框、`.mcl-label` nowrap 静态断言；`session.test.mjs` off 转交 v1 命令面。每条修复做回退自证（还原→红→恢复→绿），C5 由真实流程用例直接抓出。
- 全套 28 个测试文件、393 项通过（跳过 7 项为既有的集成 skip），plugin 与 release 副本一致绿。

## 0.9.0-rc.4 — 2026-10-15

本版修复 5 条用户上报的遗留缺陷（B1–B5，含 GitHub issue #2 的删除安全问题），并落地**灵枢重要度驱动的软保留装包**（F1）：软保留从「按类目一刀切丢弃」改为「按确定性重要度分值排序丢弃（低分先丢）」，分量逐项可解释。收益口径是「丢得准」，不宣称提升容量节省。

### 修复

- **「全历史记忆上下文」开关关不掉**（B1，用户上报）：开启后再拨回关无反应。根因是面板 off 路径按 `enabled && engine === 'v2'` 分流，而投影折叠会停在 v2 停用后的残留态（`fullHistory` 仍为 true、`enabled` 为 false），一条命令都发不出。现在关闭**无条件**发出 `set fullhistory off`（v2 未启用时返回「未启用」，属可接受空操作），且 `memory-lab2 off` 的投影折叠同时清掉 `fullHistory` 残留位。
- **面板「恢复原文」对 v2 会话误报「未启用」**（B2，会话 c896f803 取证）：面板动作硬编码 v1 命令，v2 会话（账本 1845 段完好）点「恢复原文」却报「请先使用 /memory-lab on」。现在「恢复原文」「立即降温」「预演」按当前引擎分流；v2 新增 `restore` 子命令（恢复全部可恢复回执，**不停用引擎**）；v1 的 `restore`/`now`/`dry-run` 在 v2 持有投影时指路 v2 入口。
- **`/memory-lab off` 的删除条件不安全**（B3，issue #2，P0）：`restore` 失败的行被改写为 `restore-skipped` 后脱离待恢复计数，但原文**仍只在冷库**；此时 `remaining === 0` 会让 `off` 连同 `clean` 直接删掉冷库，原文唯一副本永久丢失，且回复文案同时出现「仍依赖冷库」与「已清除」的矛盾。现在删除判定（`off` 的 purge、遗留目录回收、`clean` 确认门禁）统一把 `restore-skipped` 行计入冷依赖；两段文案按口径分工理顺，`clean confirm delete-session` 的指路不再被 `removed` 抢走。
- **三条测试依赖「peer 恰好不在场」**（B4，issue #2）：按 README 装好 `@furongjun1999/dsh-memory@0.8.1` 的环境下 4 处断言必红。现在测试内显式屏蔽 peer 解析或按在场/不在场分别断言，两种环境全套均绿（以 stub 包模拟在场环境验证）。
- **peer 在场时测试进程不退出**（B5，issue #2）：成因定位为真实冷库 Python 子进程句柄（测试内触点已随 B4 消除），`npm test` 每条另加 `--test-force-exit` 兜底。

### 新功能

- **软保留按灵枢重要度分值装包**（F1，卡片语义版本 v4）：软保留候选在装包前经确定性白箱评分器（纯函数、零第三方依赖、不调模型、不读写冷库）打分——`分值 = 0.5·相关性 + 0.3·来源 + 0.1·证据 + 0.1·回读`（权重出处：灵枢 `forgetting.py` / `weights.py` / `consolidate.py`，注释随码）。**相关性是「与当前人类请求的 bigram 覆盖率」**：与当前任务高度重合的历史**不**会被当作冗余评低分（与灵枢「越新越好」原语的关键差异，专门回归测试锁住）。装包从「每类目一段、按固定顺序一刀切」改为**每项一段、按分值降序装包（低分先丢）**，同分维持类目次序兜底；每段带分量描述，丢弃报告如实写「因重要度分值 X（分量…）被丢弃」，机器可读序随卡片结果输出。硬保护（人类请求/未闭合调用/未曝光结果/计划工件）**不参与打分、不被低分丢弃**；不动守卫层的结构安全判定；分值只决定丢弃顺序，不是置信度或事实验证。
- 已知边界：`hits`（回读次数）分量接口就位，但当前检索索引尚无每记录回读计数，暂如实按 0 计；数据源就绪后接入，评分接口不变。

### 测试

- 新增 `test/v2-importance.test.mjs`（9 项，覆盖 novelty 反向校准回归、来源档位、证据状态、回读提级、硬保护不参与、确定性、纯函数无副作用）并入 `npm test` 链；`entry-coverage` 守卫的入口解析同步接受 node 标志。
- B1–B4 共新增 11 条用例（面板 off 兜底、投影残留清理、v2 restore 端到端、v1 指路、restore-skipped 删除门禁与 clean 拒绝、peer 双环境分轨）；B2/B3 各做一次回退自证（临时还原修复 → 用例红 → 恢复绿）。
- 全套 27 个测试文件、379 项断言通过（跳过 2 项为既有的集成 skip），peer 在场/不在场两种环境均正常退出。
## 0.9.0-rc.3 — 2026-10-15

本版合入社区 PR 的 13 处数据可靠性与声明修复，并补齐合并审查发现的遗留缺口：`verify-failed`（替换已提交、原文已被遮蔽、仅提交后校验未通过）此前在恢复、保护、导入与展示路径上仍被当作「未归档」，一段只剩冷库副本的原文可能因此永久丢失。

### 修复

- **原子写入后落盘**：`writeJsonAtomic` 在 rename 前对临时文件 `fsync`，POSIX 上再同步父目录项。此前 rename 之后崩溃可能留下空文件或半写文件，而它替换掉的旧状态已经不存在了。
- **根标记损坏不再被当成「从未初始化」**：`ensureLabRoot` 此前用宽松读取器，损坏与缺失都返回 null，于是损坏的标记会被静默覆盖。现在标记读取走严格路径，损坏即抛 `EDAMAGED` 并原样保留文件；外来标记同样拒绝收养。
- **损坏会话不再从列表中消失**：`listSessionStates` 此前静默跳过读不出的会话，用户只会少一行、无从得知有会话需要处理。返回值改为 `{ rows, damaged }`，损坏会话连同原因列出。
- **越界数值设置不再被接受**：`normalizeSettings` 此前只检查下界，`retainOperations: 1e9` 能原样通过。现在上下界都校验，越界按既有契约回落默认值。
- **预览截断不再切裂代理对**：`displayPreview`/`clipLocator` 改用码点计数截断，emoji 等辅助平面字符不再留下孤立高位代理（渲染成替换字符，且写进消息后是永久损坏的序列）。
- **冷库握手失败不再泄漏子进程**：`TemporaryLingshuClient.create` 此前只有「缺少工具」分支会停桥，tools/list 超时、信号中止或管道断裂都会把 `python -m md_cg.mcp_server` 及其管道留在宿主进程生命周期里。
- **抑制器不再半装**：`install` 此前边检查边打补丁，后面的方法缺失时前面的已被替换而 `installed` 仍为 false，`restore` 再也不会执行，全局钩子就此半挂到进程结束。现在先全量预检、再统一打补丁；`restore` 对继承方法改用 `delete` 撤销遮蔽。
- **抑制计数不再永久累积**：`release` 在会话计数归零时删除条目，`dispose` 清空全部计数。此前每个会话的两枚整数会随宿主生命周期无限增长。
- **校验失败的提交不再丢失原文**：活动面替换已追加、原文已被遮蔽，仅提交后校验未通过时，归档行现在照实落盘（`status: outcome.state`）并计入待恢复集；此前该行既不落盘也不可恢复，被遮蔽的原文再无回读句柄。同时 `failed`/`failureRows` 明确排除该状态，避免其冷节点被当作孤儿清理掉——那会销毁原文的唯一副本。
- **占用率不再记陈旧值**：批量归档后重新测量一次。此前记下的是归档前那次测量，状态卡报告的 assembled token 与用户实际所见不符。
- **回注守卫不再重复计数**：新增 `restoreGrowth`，以「原文 − 回执」计算真实增量（回执 token 本就在已测量装配内）。此前加全量原文会拒绝本可放下的恢复，反而把用户推向删除会话。
- **`@deepseek-ai/cosmokit` 列入声明**：`index.mjs` 一直按可选依赖加载它，但 `package.json` 未声明。现补入 `peerDependencies` + `peerDependenciesMeta.optional` 与 devDependency。
- **`config-contract` 套件不再以缺包失败**：两个可选 peer 缺失时显式说明缺哪个包并跳过，不再以 `ERR_MODULE_NOT_FOUND` 报成插件缺陷。

### 合并审查补齐

- **verify-failed 的回执重建元数据随行落盘**：`commitSurfaceRun` 此前只在 `applied` 分支携带 `chunkCount`/`chunkIds`/`shadowedTokenCount`/`surfaceGeneration`/`hostVersion` 与批次 `receiptFormat`/`batchSize`，校验未通过的行恢复时会按另一形态重建回执正文而被「回执正文已变化」拒绝。现在这些字段描述的是已提交的替换，与校验结果无关、无条件随行；只有 `state` 与 `reason` 分叉。
- **遗留目录回收与删除确认统一走 `pendingReceipts`**：`off` 的遗留回收与 `clean` 的待恢复计数此前各自数 `status === 'applied'`，verify-failed 行既挡不住误删，又会被当成「无依赖」清掉隔离目录（销毁原文唯一副本）。两处统一改用恢复路径的同一判定。
- **冷库依赖保护计入 verify-failed**：清理守卫此前只认 `applied`，verify-failed 引用的冷分块会被当作普通冷节点释放掉唯一副本。
- **v1→v2 导入接受 verify-failed**：拒收它等于让一段只能从冷库恢复的原文无法导入 v2；其余字段（含 `chunkCount`）的严格校验不变。
- **账本分列 verify-failed**：v2 账本与 v1 `status` 把它并进「已归档」会虚报成功段数；现在单列并提示原文只在冷库、可 restore 取回。
- **停用拒绝文案不再重复计回执**：恢复超窗的拒绝理由此前把已在装配内的回执 token 当增量重算了一遍，把拒绝理由说得比实际更吓人。
- **`listSessionStates` 容忍并发删除**：目录在扫描中途被删（清理命令、另一会话、用户手动）不再掀掉整次状态视图；目录类型优先取 `readdir` 的 dirent 快照，仅在文件系统不返回类型时回落 `lstat` 并容忍 ENOENT。
- **批次计数契约显式化**：`releasedTokens`/`applied`/`recordsWritten` 只认 `applied`、归档行只认 `applied + verify-failed`、`failed` 两者都不进——四处判定以注释钉住，防回归。
- **重复 JSDoc 清理**：`core.mjs`/`apply-engine.mjs`/`storage.mjs` 中与实现分离或互相重复的文档注释合并归位。

### 测试

- 新增 `test/reliability.test.mjs`（22 项断言）并入 `npm test` 链；`pendingReceipts` 提升为 `apply-engine.mjs` 的模块级导出以便直接断言，`restoreGrowth` 抽到 `core.mjs` 作为纯函数。
- 合并审查补齐 7 项回归：`writeJsonAtomic` 的 fsync 次序与无残留覆写、并发删除终态不入损坏桶、verify-failed 批次/单单元的字段完整性与恢复成功、批次提交后复测与活动面对齐、冷库创建失败只记一次不逐边界重试。总计 29 项。

### 经核验不成立

- 「投影在 `receiptSeqs` 过滤前提前返回会丢失计数」：过滤作用在局部变量上，`state` 未被修改，提前返回不丢任何状态；唯一代价是归档计数滞后一个事件。未做改动。

## 0.9.0-rc.2 — 2026-10-14

本版从 0.6.0 直接跨到 0.9.0-rc.2：v1 修复与保护层并入共享源码，v2 引擎（全历史按需记忆化）与计划先行合入本仓，并修复两轮真实会话实测暴露的自激循环缺陷。双引擎互斥：同一会话同一时刻只能由 `/memory-lab`（v1）或 `/memory-lab2`（v2）之一持有模型可见投影。

### 新增

- **全历史记忆上下文（v2）**：`/memory-lab2 set fullhistory on` 后，除 system 头、全部人类用户消息、退热凭证与计划工件外，其余历史全部退热入会话隔离 ArchiveStore；按需按稳定 ID 回读（`read`/`recall`），有界工作状态卡常驻。v2 带独立隔离目录、回执标记与只读模型工具 `memory_lab_recall`，不新增可写工具。
- **计划先行（planfirst）**：全新对话自动进入计划模式，用户批准计划的瞬间自动启用降温；计划全文（`exit_plan_mode` 调用与结果）终生保留、不可退热。插件级 `planFirst` 配置或 `/memory-lab set planfirst`。
- **活跃证据保护层（v1/v2 共享）**：候选在进批量门槛前先过可解释的保护判定（未闭合调用、未曝光结果、在途作业、当前必要证据、有效 pin、未知协议位），硬保护不因预算丢弃；软保留按固定丢弃顺序装包并如实报告。
- **隔离灵枢检索后端（可选）**：全历史模式自动启动隔离灵枢子进程并随批增量同步索引；后端不可用时如实降级为字面匹配，绝不回退读正式灵枢根。
- **成本账本**：`/memory-lab2 cost` 输出注入/重读/批次数与 token（宿主 meter 口径，与归档侧同一把尺子）、批前后 usage 差额观测（只观测不宣称因果）。

### 修复

- **状态卡增量注入**：此前每步注入一张 ≈1.8k token 的全量状态卡、95% 为固定协议文案（实测 911 次注入 0 次丢弃）。现在全量卡只在会话首张与每 20 张再锚定时注入，其余步只注入相对上一张全量卡的变化行（60 步重放注入量降至约 12%）；去重键改整卡语义哈希，软保留区的进度更新不再被去重吞掉。
- **插件自产消息不再自激归档**：归档候选拆分为「计门槛」与「搭车」两堆——插件自己注入的状态卡/回注包/回执不计够批门槛，只在真实操作攒够批时搭车替换。修复前实测 181 个批次里 484 条候选全是插件卡片、真实用户消息 0 条被归档。
- **批次摘要回执**：一批内活动面相邻的单元合并为一次替换、共用一条摘要回执（成员行带冷记录与 hash，整组一次恢复）；单单元回执格式不变，旧账完全兼容。修复前逐条模板回执每会话重复注入约 185k token。
- **回注查询词只认人类消息**：环境快照不再能触发回注——实测 15 次回注里 12 次查询词是环境快照、命中无关旧记录；拿不到人类消息就不回注。
- **插件来源记录不进检索索引、不被回注**：插件卡片/回注包/回执在索引同步与命中两侧都按作者过滤，span 标签按作者区分，不再把插件工作资料渲染成「用户消息」。
- **`set batch` 不再静默失效**：v2 持有投影时 v1 的 `set` 明确报错并指路 `/memory-lab2 set`；全局默认批量阈值 5→10（新增 3/10/16 档预设）。
- **并行工具调用共享宿主 seq 时卡片行不再重复**：进度/在途行按出现次序或按 callId 精确对位区分。
- **注入与归档 token 同一把尺子**：注入侧此前用 4 字节≈1 token 内部口径，与归档侧差 2.01 倍；统一到宿主 meter，meter 不可用如实记「未计量」。

### 变更

- 插件卡片的注入形态与批次摘要回执为新的对外文本形态；v1 引擎的逐条回执格式与行为保持不变。
- v1 自 0.6.2 起的四缺陷修复（失败重试换号、保护位被占、token 口径、版本统一）并入本包源码。

## 0.6.0 — 2026-10-11

本版包含两批工作：**全局默认与预设**（设置页可维护、可改名），以及随后的**维护版本**——修复现行「保留最近 N 个完整操作节点」机制的可靠性缺陷，补齐召回与装包协议，并按实测收紧文档口径。产品边界不变——仍是每会话隔离、保留最近 N 个操作、窗口外攒批降温；不扩展到普通对话全历史归档，不新增模型可见工具，不改变默认参数。

### 全局默认与预设

- 新增宿主 Config：`defaults` 五字段（`retainOperations`／`archiveBatchSize`／`auto`／`autoRecall`／`autoRestore`）与 `presets` 数组，作为未选预设会话的起点。
- 设置页新增「记忆上下文」卡片（挂插件列表的 keyed 座位），预设可新增、**改名**、调值、删除，保存立即生效；已启用降温的会话不受影响。
- 弹层顶部新增预设切换，默认「全局预设」；手动微调后标注「已调整」。
- 随插件附带两个按真实会话成本模拟的预设（GLM 5.3 Flash 省流、DeepSeek V4.1 Flash 省流）。
- `defaults`／`presets` 以宿主 volatile 叶子契约下发表单；显式用户配置透传时仍是 volatile ref 且携带用户值。

### 数据可靠性（优先修复）

- **损坏的状态文件不再被当作「从未启用」**：读取状态时区分「文件不存在」与「文件损坏」。损坏的会话粘性停止干预，`status`/`restore`/`clean`/维护动作都显式报告损坏，而不是把用户引向一个会静默失败的入口；唯一出口是确认后 `clean confirm delete-session`（冷库数据在此之前保持不动）。
- **恢复失败不再误清理**：冷节点缺失或校验不符时，恢复停在安全侧——冷库与宿主原始日志都不动，故障理由持久化；`off`/`clean` 与恢复共享同一份事务事实，依赖未核对前拒绝删除。
- **投影替换与账本保持一致**：事务记录先于投影替换落盘，启用时重放核对；重试沿用同一冷节点 id，避免同一次归档产生两份漂移的正文。

### 召回与装包

- **修正隔离冷库的工作记录读取**：召回一律携带回执角色视图（`view: 'receipt'`），否则默认候选池会排除 `tool-output` 记录，使归档正文实际存在却查不到。视图不被支持时显式失败并计入状态面板，绝不静默回退到正式灵枢根。
- **协议归一**：兼容多种召回响应封套，非法响应按错误处理，不产生「零命中」假象。
- **证据装包**：装包受预算约束；去重只作用于**当前仍可见**的证据，已退出上下文、之后又需要的证据可以再次装包——不会因为曾经发过就被永久去重。

### 冷却与生命周期

- **当前轮围栏**：最后一条助手消息及其操作在当前批次被排除（理由码 `not-yet-exposed`），下一个用户消息落面后自动成为正常候选。这防止把模型此刻可能还在发送证据的操作从可见上下文里抽走。
- **单批释放上限**：一批最多释放约 65536 token，超出的候选留到下一批，并在报告中标注，避免大量证据在一步内同时退出上下文。
- **有界重试与生命周期互斥**：重试有上限且失败理由持久化；归档、恢复、停用并发时互斥，取消信号贯穿各入口。
- **可观测性**：批次报告解释「为何没有候选」（按理由码分条）与是否触顶；状态面板含回执视图探测结果、保留与批量设置、失败明细。

### 文档

- 收紧过强表述：缓存命中率结论改为「该单会话实测中的主导因素」并标注样本边界，不再写成普适「唯一杠杆」。
- 补全当前轮围栏与单批释放上限的口径，避免文档与行为不一致。

## 0.5.0 — 2026-10-10

- **删除占用率安全网，保留数成为唯一触发线。** 第二层「组装输入超过目标占用率就继续压」在真实 1M 窗口长会话里从未触发；删除 `targetOccupancy` 与 `releaseMarginRatio` 两个会话级设置，`set target`/`set margin` 不再可用，面板只保留 `retain` 与 `batch`。上下文上限改由宿主自己的自动压缩兜底。

## 0.4.2 — 2026-10-10

- 归档批次失败取证后的修复：失败单元 id 碰撞、失败原因未持久化等问题。
- CRLF 写入重试修复。

## 0.4.0 — 2026-10-09

- 攒批归档与缓存经济学：批量阈值成为成本杠杆。
- 大正文按码点分块写入与逐块回读校验。

## 0.3.x — 2026-10-09

- 助手思考块随正文归档并在 `restore` 时逐字节取回。
- 最近一次测量落盘，区分「未触发」与「测量失败」。
- `set autorestore off` 后给出回头路提示。
- 面板改为锚定触发器的弹层，修复全新对话里按钮打不开的问题。

## 0.2.x — 2026-10-08

- 首个可用版本：按会话启用、隔离冷库、表层替换、`restore`/`clean` 守卫。
- 移除模式档位，`/memory-lab on` 一条命令即进入可用状态。



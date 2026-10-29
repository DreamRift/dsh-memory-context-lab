# 变更记录

> 0.14.0-beta.7 ~ beta.10 未在本文件单独收录（当时以进展卡与转正方案为准）；beta.11 起恢复逐版记录。

## 0.14.0-beta.48（2026-10-29，测试版）

相比 0.14.0-beta.47：

### 修复（beta.46 审计的 P1/P2 待修项）

- **B-1（P1）恢复不再丢工具调用参数**：摄入侧把 assistant 消息里的 `tool-call` 块（脱敏后）写进 `payload.structure.toolCalls`，`text` 不变（索引、净收益判据、`sourceChars` 均不受影响）；`restore` 依据 structure 渲染确定性「工具调用」块。真实会话里 27/27 凭证、81 次调用、105,975 字参数原先不可恢复，现在可按 ID 回读。同 callId 去重；16000 字窗口守卫仍是失败关闭。
- **G-A（P1）损坏库自动截断 + 显式 repair**：`transactions` / `vouchers` / `forgotten` / `redactions` 日志的**尾部半行**（无结尾换行且 JSON 不可解析）在跨进程写锁内重读后截到最后一条完整行；打开期自动执行，也可用 `/memory-lab repair [status|apply]` 手动/审计。中段损坏、完整行解析失败、账实不符一律**不截断**，仍失败关闭（读允许、写拒绝）。截断前先写 `repair-log.jsonl` 审计，审计失败则不改字节。
- **G-B（P2）`fileExists` 只把 ENOENT 当「没有」**：EACCES/EMFILE/ELOOP 向上抛；不再因一次 stat 失败重建 manifest（事务号复用）或覆盖同 ID 记录。`openV3SessionStore` 支持注入 stat（守卫测试用）。
- **C-D / C-E（P2/F）崩溃恢复按模式分流、事务号随 intent**：`archive-intent.json` 增 `mode` 与 `txn`；按步归档恢复只写 `lastArchiveAt`，不再写回合级 `lastArchiveEndSeq`；补凭证沿用 intent 的事务号（不再硬编码 `txn:1`）。旧 intent 无这两个字段时按回合级/1 处理（兼容）。
- **C-F 归档意图对账每个 pre-step 都尝试**：不再只在建库时跑一次（voucher 失败后要等重启才自愈）。
- **D-B 恢复会计接 N-11 三桶**：`restored + skipped + forgotten === total`；已遗忘记录单独计数，不再混进「跳过」，命令面与停用回执都显示「已遗忘 N」。
- **D-C 隐私面级联失败可见**：遗忘/撤销时逐段收集回执清除结果，失败写告警并在命令回执里列出「N 段不可定位」；历史凭证行增「正文已清除」标记（`redactions.jsonl` 持久标记，sync 读取）。
- **D-D undo 恢复 pin**：遗忘不再删除 pin（pin 是用户意图）；撤销后保护自然仍在。
- **D-E 恢复资格单一实现**：归档服务不再自写「逐字节相等」循环，统一走 domain 的 `restoreEligibilityOf`。
- **B-3 夹具保真**：`fake-session` 不再把 `tool/call` 放进活动面（与真实宿主一致），`pushToolCall` 默认 log-only，需要旧形状显式 `{ onSurface: true }`。
- **F-C 状态行闸门同源**：「按步归档闸门」与「下一次归档」共用同一次 dry-run 的占用/闸门事实，并标出「同一时刻 / 来自上一步记录」。
- **F-B 注释纠偏**：`statusOf` 不再宣称「零 I/O」（实测每次 2 次 statSync + 内容缓存）。
- **H-1 索引重建移出写锁**：锁外构建 + 锁内新鲜度复核（事务号/已提交数/遗忘戳）后短写；期间有写入或复核不符则退回锁内全量重建（正确性优先）。
- **G-D**：删除 `write-lock.mjs` 的死代码 `exists()`。

### 明确不做（用户拍板）

- 停用恢复（`off`）的窗口守卫与总预算**不改**；正式版功能与使用文档里说明。
- `tool/call` 正文 400 字上限**不放宽**；恢复走 structure，不改 text。
- user/assistant 可见文本**不纳入脱敏**（保持「只保护外部数据」边界）。
- E-B/E-C/E-D（租约只记注入、T2 阈值语义、跨回合回注去重）**保持现状**；跨回合去重记为未来可选项。
- 本版随发布流程打包并安装到本机 profile（用户明确要求）；**不重启 DSH**。

### 测试

- 新增 `v3-store-repair`（4 条：尾部半行 dry-run/apply/审计/自动修复、中段不动、EACCES 失败关闭）与 `v3-restore-toolcalls`（2 条：structure 脱敏/去重、restore 带回工具名与参数）。
- 扩展 `v3-archive-e2e`（intent.mode/txn）、`v3-compact`（pin 保留、隐私面可见、undo）、`v3-property`（真中段损坏夹具）、`v3-file-references`（log-only 调用不在工作集）。
- 全量 101 套 / 468 用例 / 464 通过 / 4 安装面 skip / 0 失败（4 skip = profile 仍是 beta.46 副本，装 beta.48 后真跑）。

## 0.14.0-beta.47（2026-10-29，测试版）

相比 0.14.0-beta.46：

### 新功能

- **按轮归档的轮次判定可切换（设置页）**：`turnBasis` = `human`（默认，真人消息算一轮）或 `dsh`（按 DSH 自己的 `turn/start` / `step/start` 的 `data.turn` 计数，与界面「N 轮」同一口径）。
- **为什么需要**：真实会话 9513ac70 = 一条真人指令 + 10 次目标自动继续，界面显示「14 轮 281 步」，但真人判定把 10 次自动继续全部算进**同一个当前回合**，按轮归档从结构上永远压不到它们（只压到 2 轮）。`dsh` 判定下，目标自动继续会开新轮 → 上一轮成为「已完成」，可以立即归档。
- **安全边界不变**：当前轮永不归档；pin / 未完成工具对 / 插件回执 / 无记录仍是整组硬边界；回注包透明；净收益判据、回执与恢复语义完全不变。两种判定唯一差别是「什么算一轮」。
- **游标分开存**：真人判定与 DSH 判定的「判负跳过」游标各自独立（`notWorthThroughSeqTurn` / `notWorthThroughSeqTurnDsh`），避免一次切换把另一种分组口径的判负结论拿来跳过未评估的轮。
- **当前轮精确定位**：pre-step 把 `payload.turn` 传给选择器；当前轮刚开、活动面还没有它的节点时，上一轮也能立刻判为已完成（否则会晚一轮）。`now` / `status` 没有 payload.turn 时保守按「最后一组是当前轮」。
- **兼容**：日志里没有任何 turn 计数（旧宿主/旧夹具）时自动退回真人判定，不猜轮次。
- **观察面**：`/memory-lab status` 的模式行与「轮次判定」行、`settingsLine` 都显示当前判定；设置页的下拉框显示「真人消息（默认） / DSH 轮次」。

### 测试

- 新增 4 条用例：`v3-archive-event-shape` 两条（DSH 轮次分组 + 当前轮刚开时上一轮仍可归档）、`v3-archive-prestep` 一条（默认真人判定不压、切 DSH 判定后只压第 1 轮、当前轮留在面上）、`v3-client-surface` 一条（下拉框渲染与写入字符串值）。
- 全量 99 套 / 461 用例 / 457 通过 / 4 安装面 skip（profile 仍是 beta.46 副本）/ 0 失败。

### 升级

- 本版**未打包、未安装、未重启**；设置页的下拉框要替换 profile 中的插件包并重启 DSH 才会出现（宿主半与客户端半都要重新装配）。

## 0.14.0-beta.46（2026-10-29，测试版）

相比 0.14.0-beta.45：

### 修复

- **判负（not-worth）的按步 span 永久堵死队头（P1）**：真实会话 55cc43c5 中 seq 930–946（3 步）的记录正文只有 105 字（assistant 消息 metaOnly、`payload.text` 为空，tool-call 参数不在记录正文里），回执 186 字，`makePlan` 判 `not-worth`；而 `selectStepSpan` 永远从最老 span 开始、`archiveStepOnce` 遇 `not-worth` 直接返回，于是该 span 之后 119 步 / 50 个请求零归档，末步占用涨到 23.2%。
- 修法只动「非安全边界」：选择器新增 `minStartSeq`（只考虑 startSeq 大于游标的步骤）；入口把判负 span 的 `endSeq` 记进进程内游标 `entry.notWorthThroughSeq`，下一次从它之后继续选；单步最多连续跳 16 段。**pin / 未完成工具对 / 无记录 / 插件回执仍由选择器照常 break**，判负 span 留在活动面上不被误压。`status` 的「下一次归档」用同一游标（只读，不推进）。
- 未改净收益判据、未引入缓存成本模型、未改摄入正文（metaOnly 仍不进索引）；回合级选择器未动。

### 升级

- 替换 DSH profile 中的插件包并重启 DSH（宿主半与客户端半都要重新装配）。

### 测试

- 新增 `test/v3-archive-not-worth.test.mjs`（判负队头 → 预览与执行都越过它、第二段继续归档、判负 span 仍在面上）；`v3-step-cooling` 增 `minStartSeq` 选择器用例。
- 红色对照：临时去掉 `minStartSeq` 过滤后，两条新用例均实测必红（not-worth 卡在 seq 3–12 / 6 条记录、sourceChars 6 < receiptChars 183），复原后转绿。
- 全量 99 套 / 452 用例 / 452 通过 / 0 失败 / 0 skip（安装 beta.46 后安装面 5 条全部真跑）。

### 发布

- tag `v0.14.0-beta.46`（commit `07b9aa1`）；GitHub Release（Pre-release）asset 78 files / 280,825 B / sha256 `15a30783070e124b490b3a7f0b1f7e071b5a1960f540e44cf88cf880ca6c073b`（远端 digest 已核对）。
- profile 依赖切到 `记忆上下文/dist/dsh-memory-context-lab-0.14.0-beta.46.tgz` 并 `pnpm install`；安装副本 `src/` 63 文件与源码逐字节一致（唯一差异是发布侧镜像标记行）；`install.test` 5/5 真跑通过。**未重启 DSH**。

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
- profile 已装 beta.45（`src/` 与发布包一致），**未重启**。

### 测试夹具

- 凭据形态夹具改为运行时拼接（`fake('AIza', 'SyA…')`）：运行时值与脱敏强度不变，仓库里不再出现能被 GitHub 秘密扫描整串匹配的假密钥（该条告警已按误报关闭；发布包不含 `test/`，用户不受影响）。测试：98 套 / 450 用例 / 450 通过 / 0 失败 / 0 skip（安装 beta.45 后安装面全部真跑）。

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
- **文档**：实时降温判定设计-beta.40（开发期文档，不随发布包分发；灵枢 role 分层/时间衰减/可回读/主动遗忘四条对照，及为何不引入概率模型）。

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
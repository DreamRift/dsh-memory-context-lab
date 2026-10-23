# 变更记录

## 0.13.2-beta.6（2026-10-23）**测试版，未打 tag / 未装到本机 profile，未推送 GitHub**

**第 8 轮审计（`reports/第8轮结论.md`）的按根因修复批。只修缺陷、不改产品边界。**
本轮不按 18 条红探针逐条排期，而是先归并成 9 个根因组，一组一处抽象改动。

源码树 **117 套全绿、0 套失败**；回归集探针 **71/71 全绿**；
`revert-probe` 全矩阵 **66 个场景 / 62 OK / 4 遗留脱节**（本批新增 12 条，全部改回去必红）。
逐条处置见[修复计划（beta.6）](../docs/dev-0.13.2/修复计划-beta.6.md)与
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
逐条处置见[进展卡（beta.5）](../docs/dev-0.13.2/进展卡-beta.5.md)。

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
（脱节仍是历史维护债，本轮新增的 6 条全部「改回去必红」）。逐条处置见[进展卡（beta.4）](../docs/dev-0.13.2/进展卡-beta.4.md)。

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
**未推送 GitHub**（推送按 [发布流程](../docs/发布流程.md)另行执行）。
逐条处置见[进展卡（beta.3）](../docs/dev-0.13.2/进展卡-beta.3.md)。

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
profile 依赖仍指向 `#v0.13.1`。发布动作见 [发布流程](../docs/发布流程.md)。

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
profile 依赖仍指向 `#v0.13.1`。发布动作见 [发布流程](../docs/发布流程.md)。

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
- 设计定稿：[0.11.0-压缩成员级排除设计-20261018.md](../docs/历史归档/版本计划与提示词/0.11.0-压缩成员级排除设计-20261018.md)。

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

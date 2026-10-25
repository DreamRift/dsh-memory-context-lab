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

## 安装

```text
plugin_manager add_bundle dsh-memory-context-lab
```

或使用本 Release 附件 `dsh-memory-context-lab-0.13.1.tgz`。

**不兼容**：`/memory-lab2` 已删除，旧会话目录不再被读取（不删不迁移）。

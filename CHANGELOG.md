## 0.15.4（2026-11-06，全面排查 63 项缺陷修复；正式版）

按 [0.15.3 全面排查报告]（63 项：P1×8 / P2×34 / P3×21）
与[缺陷修复方案]逐条落地。本版**无新增配置项、无数据迁移**。

### 归档停摆（P0，真机复现）

- **根因**：`domain/archive/steps.mjs` 在阶段 1 选窗口时，`hasHuman` 检查写在了 `turn` 赋值**之前**。
  第一步的 `turn` 恒为 `null`，于是首个含真人消息的单元（往往是**已被归档过的历史残留**）被当成
  回合锚点，扫描从一开始就无法继续 → 归档静默停摆，而 `status` 仍显示闸门已开。
- **修法**：把 `turn` 赋值提到检查之前（6 行顺序调整）。
- **守卫**：`v3-step-leading-anchor-turn.test.mjs`。真机验证：重启后凭证由 8 张增至 12 张，最后一张到 seq 4167。

### 隐私与清除

- **M-01 脱敏吞正文（P1）**：`redact.mjs` 的 `KEY_VALUE_RE` 普通分支值写成 `[^\r\n]{4,}`（吃到行尾），
  一行里 `password: x; 后续正文` 的**后续全部被吃掉**。改为两步法（问题 1-C）：先切 token，
  再按键名判值边界；接受「纯字母短密码」的已知残留。实测曾有 23 条记录被截断（9010→759 字符）。
  守卫 `v3-redact-swallow-m01.test.mjs`。
- **问题 3-B 承诺降级**：`forget purge` 后 `records/` 真删，但 `vouchers.jsonl` 里的回执正文仍在。
  文案据实改为「可见面已清除，审计账本保留痕」，不再暗示「彻底删除」。守卫 `v3-forget-promise-q3.test.mjs`。
- **A-01 恢复节点永久阻断清除（P1）**：restore 出来的节点没有账本身份，`redact`/`purge` 按 seq 定位不到它，
  于是一旦恢复过就一直清不掉。按问题 5-A 让恢复节点**可再归档**，从而获得账本身份。
  守卫 `v3-restore-then-redact-a01.test.mjs`。
- **T-03 跨句柄清除账本不刷新**：`redactedVoucherIds()` 改为按戳刷新后读，导出等读路径 `await` 它。
  守卫 `v3-redactions-cross-handle-t03.test.mjs`。
- **A-05 孤儿回执永不清除（P2）**：`orphan-receipts.jsonl` 存的是**明文回执正文**，却完全不在遗忘级联里。
  forget/purge 之后这段明文永久留盘；又因为没有对应凭证，`restore` 恒 `receipt-changed`——既不可恢复、
  也不可清除。新增 `redactOrphansFor`：命中行**整本重写**（不是追加标记位——追加只会让读面忽略旧行，
  明文仍在盘上），正文置空、保留 `recordIds` 作审计；`restoreOrphan` 见到 `redacted` 明确报
  `orphan-redacted`。守卫 `v3-a05-orphan-cascade.test.mjs`（含「磁盘上不得残留明文」断言）。
- **A-03 老账本 undo 猜错槽位（P1）**：无 seq 的老账本走「面上第一个常量节点」兜底，赌错就把别处正文
  写进本凭证槽位（位置与内容互换）。收紧为**常量节点必须唯一**，否则失败关闭（`redaction-seq-ambiguous`）。
  守卫 `v3-redaction-seq-identity.test.mjs` 新增用例。

### 性能

- **M-04 每步全量重建索引（P1）**：小增量分支原走 `scheduleIndexRebuild`（1500 ms 节流后**全库重建**），
  实测单次 3,044 ms / 26 MB，稳态约 4.5 s 一轮、写入约 340 MB/min、主线程占用 67%。
  改为**增量索引**（`lexical-index.mjs` 新增增量原语），小增量只并入新增记录。
  守卫 `v3-index-incremental-m04.test.mjs`。

### 语义正确性

- **M-03 记录重复**：提交前按**事件 ID** 去重，命中即拒绝落库（问题 6-C）。
  ⚠️ **不做正文 hash 去重**——实测 2,127 条（418 组）是「正文相同但事件不同」的两次真实操作，
  合并它们等于篡改历史。守卫 `v3-ingest-dedupe-m03.test.mjs`（含一条反向用例：不同事件的相同正文必须都落库）。
- **问题 2 / 问题 7 缺省对齐（M-02、C-01、C-02）**：客户端不再自带一份与宿主相反的缺省值。
  `controlOfStatus` 回落 `enabled:false, recall:true`；模式回落改为 `full-history`（宿主
  `modeForNewSession` 同值）。**宿主侧行为不变**：新会话默认关闭、自动回注默认开，二者原本就是正确行为，
  只修 `controlLine` 文案。守卫 `v3-client-defaults-c02-c05.test.mjs`、`v3-defaults-alignment-q2q7.test.mjs`。
- **C-05 内部码直出**：`no-session` / `unknown-command` / `no-remote` / `no-result` 不再作为用户可见文案
  显示（改为中文人话），但 `code` 字段保留（诊断与测试锚点）。
- **C-03 面板静默写别的会话（P2）**：侧栏面板能对**任意选中会话**执行 `now`/`compact`/`export`/`fork`，
  却既不说明命令落到哪个会话，也不显示该会话的控制状态——可以对一个已停用的会话发写命令而毫无提示。
  面板拿不到「当前会话 id」（侧栏常驻面 props 无 `sessionId`），因此不能靠比对来警告；改为**显式化目标**：
  所有写命令先弹一步确认，把目标会话名写进提示，用户必须看见才继续。读命令（status/history）不拦。

### Windows 与持久化

- **T-02 心跳与 rename 争用（P1）**：写锁心跳原用 `writeFileAtomic`（含 rename），在 Windows 上与
  读取句柄争用触发 `EPERM`。按问题 4-B+A：心跳与 rename **解耦**，并只对 `EPERM` 做**有界重试**
  且记日志；不做无差别重试，也不走原生 `ReplaceFile` 路径。守卫 `v3-heartbeat-decoupled-t02.test.mjs`。
- **T-01 提交追加门**：账本追加门改为尾部窗口读，避免整本解析。守卫 `v3-commit-append-gate-t01.test.mjs`。

### 生命周期（问题 8-A+D）

- **新增 `/memory-lab storage [status|clean [--yes]]`**：`quarantine/`（崩溃残留，只进不出）与
  `exports/`（本地导出包，无 TTL）此前**既无出口可清、也无处看大小**。现在：
  `status` 报告实际残留（文件数与体积，读不到就说读不到，不猜 0）；`clean` 先预览，
  加 `--yes` 才真删；**只删这两处，绝不动 `records/`、账本与索引**；不跟随符号链接。
  **不做 TTL 自动删**——自动删正文与「可恢复」的承诺相冲。
  统计与清理**同源**（同一趟扫描），避免「status 报 3 个、clean 删 5 个」。
  `/memory-lab status` 增加「残留」行。守卫 `v3-storage-residue.test.mjs`（7 例）。

### G6b「可见片段去重」：保留，登记为候选（未接线）

`src/v3/domain/visibility/` 全套保留，但 `composition.mjs` 的唯一 `createRecall(...)` 调用点
**不传** `visibility` / `dedupeVisible`；仓库没有 `snapshotOf` 生产方、也没有对应设置项，
整链在真实会话中**不可达**（A-06 / A-07 / A-11）。按用户裁定保留代码、登记待议。
新增 `v3-g6b-unwired.test.mjs` 钉住「不得悄悄接线」；既有 `v3-g6b-source-guard` 的
零引用判据改为**剥注释后**匹配（旧写法会把「此处不要加 dedupeVisible」的警告注释误判成接线）。

### 验证

- `plugin` 与 `release` 各 `node scripts/test-all.mjs` **261/261 套件通过**（exit 0，win32-x64）。
- 本版新增守卫 **14 个**；每项均做「临时回退 → 红 → 恢复 → 绿」变异自证。
- `release/src`、`release/test` 与 `plugin` 对应树**零差异**；两处 `package.json` 同为 0.15.4。

### 未做

- **未打 tag、未建 Release**（待单独授权）；推送 GitHub 见发布记录。
- **未安装到 desktop profile**（需用户确认重启时机）。

## 0.15.3（2026-11-06，DSH 0.2.2 命令通道兼容修复）

- **根因**：DSH 0.2.2 的动态客户端门面只放行白名单生命周期方法与当前插件声明的服务，不再转发 `ctx.inject`。旧实现把 `remote.commands` 放进可选子插件注入，父插件的 `fiber.inject` 没有它，读取 `ctx.remote.commands` 被动态门面拒绝，弹层只能显示「命令通道不可用」。
- **修法**：浏览器半正式声明 `['slots', 'locale', 'remote', 'remote.commands']`；`uiWorkspace` 与 `configForms` 仍按非核心可选接入处理。宿主探针的 `turn/start` 字段检查同步 0.2.2 实际形状。
- **守卫与验证**：plugin 与 release 各 `node scripts/test-all.mjs` **239/239 套件通过**（exit 0，win32-x64）；release 相关客户端回归 57/57；`probe:host` 对 DSH `0.2.2-rc.1` 11/11 PASS。
- **产物**：`dist/dsh-memory-context-lab-0.15.3.tgz`（同时复制到 `release/dist/`），10,248 条目；精确字节数与 sha256 见 `release/RELEASE.md`，包内文档不写自身摘要。
- **验收边界**：未安装到 desktop profile、未重启 DSH，真实浏览器点击验收待做。

## 0.15.2（2026-11-05，按步归档死锁修复；未推送）

0.15.1 的源码线收口后，真机走查发现**按步归档在真实会话里一次都压不动**：把模式切到「按步归档」后，`/memory-lab status` 的「下一次归档」恒为「活动面不连续（not-dense）」。本轮只修这一处根因，**不改产品方向、不改默认值、无新增配置项、无数据迁移**。

### 根因

真实宿主在**上一步 `step/end` 之后、下一步 `step/start` 之前**产出预步骤回执；而 `buildStepUnits` 只收「打开的步骤内」的事件，两步之间的回执**不属于任何步骤单元**。选择器因此完全看不见它：既不让单元 `hasPlugin`，也不会把它吸收进 span，于是每段 span 的密集判据（`shadowed.length !== wanted.length`）必然失败。回执由 pre-step 产出，位置**恒**在两步之间，所以「压完一批就永久停摆」是稳定结局而非偶发。离线夹具把回执都写在步骤**内部**，因此一直全绿。

### 修法

- `domain/archive/steps.mjs` 新增 `attachInterStepNodes`：切完单元、进 `traceBatch` **之前**做一次只读归位，把两步之间的活动面节点归到**前一个单元**。
- **回注包透明**：并进 `surfaceSeqs` 一起遮蔽，但**不进** `recordSeqs`（与回注包既有口径一致）。
- **硬边界**：回执/恢复、真人消息、其余无记录节点是硬边界——前一个单元到此收尾，边界留在活动面，后面的步另起一段。硬边界同时作用于阶段 2（窗口内切 run）与阶段 3（批尾闭包向后扩展），两处都就地 `closeRun` 并如实报 `boundary`。

### 不改

步骤**内部**的回执仍是整步边界（原判据一字未动，有用例对照）；回执不吸收（F1 / AUD51-05-02 不变）；净收益、pin、未完成工具对、H=200 判据全部不变。

### 守卫与自证

- 新增 `test/v3-step-inter-receipt.test.mjs`（5 例）：两步之间的回执是硬边界且不产生 not-dense、回执之后自成后续段（不停摆）、两步之间的回注包透明、段内回执判据不变（对照）、以及**端到端**——真实时序下 `archiveForStep` 真的落到活动面且回执仍在面上。
- **变异自证**：注释掉归位调用 → **4 例红**（含端到端）；恢复后 5/5 绿，文件 md5 回到原值。
- **真机日志复跑**：把上一会话的 `session.v4.jsonl.zstd`（14,614 事件 / 240 节点）按真实 surface fold 重放给选择器——修前 `not-dense`（`seqs [101,138]` 形状），修后正常成段。

### 验证

- `plugin` 源码线 `node scripts/test-all.mjs`：**239/239 套件通过**（exit 0，2026-11-05，win32-x64 / Node v26.12.1）；步骤相关 7 个套件 79/79 绿。
- `release` 镜像自测：**239/239 套件通过**（exit 0，镜像内装面按设计 skip）。
- `node scripts/check-docs.mjs` errors = 0。
- **产物**：`dist/dsh-memory-context-lab-0.15.2.tgz`（同时复制到 `release/dist/`），10,248 条目；精确字节数与 sha256 记在 `release/RELEASE.md`——CHANGELOG 本身在包内，写死自身摘要会自指失效。

### 未做

**未安装到 desktop profile、未重启 DSH**（需用户另行授权）——真机上要等重装并通过 pre-step 触发后，才会看到按步归档恢复。**未推送、未打 tag、未建 Release**（等用户单独授权）。

## 0.15.1（2026-11-04，定制 dsh-ops 随包分发；未推送）

用户拍板恢复「定制版 dsh-ops 作为记忆上下文 bundle 的第二组件」，并把完整 Windows x64 Bash 载荷一起打包，默认开启 Bash。版本升到 0.15.1；源码线与 release 镜像同步。

### 组件与打包

- `cordis.patch.yml` 恢复两条组件行：`memory-context-lab` 与 `dsh-ops`；插件页「包含的组件」显示两行，点 `dsh-ops` 进入它自己的完整设置页（键 `dsh-memory-context-lab#dsh-ops`；dsh-ops 客户端同时注册 `dsh-ops#dsh-ops`，两种承载形态都能打开）。
- dsh-ops 以 **vendored 依赖**随包分发：`package.json` 的 `dsh-ops: file:./vendor/dsh-ops`；**不进入 `dsh.profile.bundles`**，不会多出一张独立插件卡片。DSH 的 bundle 运行时解析会递归收集该依赖，Loader 仍能用裸名 `dsh-ops` 加载。
- 随包携带完整 Windows x64 Bash 载荷 `vendor/bash-win32-x64`（`@dsh-ops/bash-win32-x64@0.2.1`，PortableGit + GNU bash 5.3.15，解压约 411 MB）；`package.json` 以 `optionalDependencies` 的 `file:` 依赖安装，dsh-ops 从自己的包根向上解析到它。
- 重新构建并随 dsh-ops 包携带 `runtime/win32-x64/bash-ipc`（`opsipc.dll` / `opsnt.dll` / `provenance.json`）：没有这份兼容回执时，受限模式（read-only / workspace-write）会拒绝 `ops_bash`；这是 0.15.1 默认 Bash 可用的必要条件。
- 默认值：`bash: true`、`hidePwsh: false`、`hideOfficialTools: true`、`dynamicTools: false`、`discovery.enabled: false`；四个预设默认开启，panel/tui 默认关闭。所有定制版 ops 功能（文件工具、PTC、面板、TUI、设置页）保留。
- `README` 与 `docs/设置与组件.md` 更新为两组件形态；旧「不随插件启动 dsh-ops」的说明退役。

### 兼容修补

- 记忆上下文文件核证白名单加入 `ops_inspect_local_file`：默认替换官方 `read` 后，ops 的读文件调用仍进 `file-references` 账本。
- `v3-tool-surface-default` 从「只能一个组件行」改成「双组件 + 完整载荷」守卫：钉死两条 patch 行、dsh-ops 默认值、`file:` 依赖、Bash 载荷、dsh-ops 不声明 `dsh.bundle`、客户端双键、三工具清单不变。

### 验证

- `plugin` 与 `release` 各跑 `node scripts/test-all.mjs`：**203/203 套件通过**（exit 0）；`node scripts/check-docs.mjs` errors = 0。
- 临时 profile 用 pnpm 12.14 安装新 tgz：`node_modules/dsh-memory-context-lab/node_modules/dsh-ops` 与 `@dsh-ops/bash-win32-x64` 均存在；`createRequire` 能解析两者；`bundledShell` 返回载荷内 `bin/bash.exe`，直接运行报告 **GNU bash 5.3.15**。
- `dsh --profile <temp> --dump-config` 显示两条组件行（`memory-context-lab`、`dsh-ops`）及默认配置；`confinedBash` 能从随包载荷复制出带 IPC 回执的受管 bash。
- **产物**：`dist/dsh-memory-context-lab-0.15.1.tgz`（同时复制到 `release/dist/`，作为 GitHub Release asset） = **10,247 条目 / 165,530,447 B / sha256 `06D84177…B749`**；内层定制 dsh-ops tgz = **663 文件 / 4,753,367 B / sha256 `05D7E3AE…FFA00`**。
- **边界（如实登记）**：dsh-ops 的 `Config` 不是宿主原生 Schemastery schema，`--dump-config-schema` 对 dsh-ops 报 `unsupported`；组件行页由 dsh-ops 自己的 `plugins.row.config` 渲染，不依赖该 schema，但宿主配置 schema 工具不覆盖它。
- **未做**：desktop profile 安装与 DSH 重启需用户另行授权；GitHub 推送/tag/Release 未做。真实宿主工具面与受限模式 `ops_bash` 执行走查结果以安装轮为准。


### 0.15.1 修复轮：契约与默认值变更（2026-11-05，40 项确证缺陷收口）

按 `docs/dev-0.15.1/记忆上下文-0.15.1-独立排查报告.md` 的严重度顺序逐条根因修复。逐条根因、守卫与「改回去必红」的变异读数见 `docs/dev-0.15.1/修复处置台账.md`。**以下是会改变外部可观察行为的部分**（其余为内部健壮性修复）。

- **默认值变更（用户裁定 §1★9）**：`turnBasis` 默认从 `human` 改为 `dsh`。长程「一条真人指令 + N 次目标自动继续」的会话在 `human` 判定下只有 1 个回合，按轮归档**从结构上永远压不到**（真机 6 个 full-history 会话 records 213–1931、`lastArchiveAt=null`）。改默认后这些会话的已完成轮次会开始被归档。想保持旧行为的用户可在设置页切回 `human`。
- **`disableSession` 文案（P2-06）**：未接线路径不再印「已恢复 N/M 段」，改为「可恢复 N/M 段（本次未执行恢复；原文仍在冷库，`/memory-lab restore` 可还原）」。生产路径当前无调用方，这条改动只为将来接线时不带假账。
- **摘录预算语义（P2-10）**：`SEARCH_EXCERPT_MAX_CHARS` 的语义明确为**每窗口**预算（注释记录历史误读），新增 `SEARCH_EXCERPT_MAX_TOTAL_CHARS`（160×2+3 = 323）作为唯一真实上界。**不收紧实现**——收紧会让「两个远处事实都可见」这条被 G1/P5 保护的产品行为消失。
- **读游标绑定 detail（P2-09）**：游标版本材料改为 `<detail>|<objectVersion>`。换 detail 的旧游标会得到 `read-cursor-object-changed`（失败关闭），不再静默沿用；读信封新增 `detail` 回显。
- **回注纯壳判据（P2-08）**：`previewChars=0` 现在**不注入**（判据从「条数为 0」改为「有效正文总量为 0」），`notPresented` 带回 `bodyChars` 与原因。
- **回执批量顶层字段（P2-19）**：多段批的 `receiptText` 现在包含**全部段**、与 `receiptChars` 同源（旧实现只取首段、字符数却是各段之和）。
- **purge 与恢复资格（P2-07）**：`archive.history()` 行新增 `purged`；`redacted` 改为「有 redactions 标记 **或** 该凭证任一记录已被 purge」——purge 事实优先于标记。`restoreVoucher` 命中 purge 账本即回 `record-purged`。
- **回注尾行（P2-18）**：尾行改为指向可分页的 `memory_context_read`（此前只给命令面、不分页）。
- **工具面参数越界（P2-12）**：搜索 `limit` / 回读 `length` / 引用 `refs_limit` 越界由「静默夹取」改为**失败关闭**。
- **写锁损坏 owner（P1-05）**：`owner.json` 解析失败不再直接抛错，改按「锁目录 mtime + TTL」判定——未过 TTL 仍失败关闭，过 TTL 接管并记 `repair-log`。这**部分推翻** 0.14.0-beta.54 的 B3-6「owner.json 损坏一律失败关闭」。
- **新账本与字段**：`orphan-receipts.jsonl`（P1-07，补账失败时的孤儿回执，与 `vouchers.jsonl` 分账）；`redactions.jsonl` 新增 `seq` 字段（P1-08，老行无 seq 时按唯一性兜底，否则失败关闭）；按步归档新增诊断字段 `skippedHeads/headSkipped`（P1-09，只在真的跳过时出现）。
- **追加门与读门分离（P3-07）**：`appendCheckpoint` / `appendCheckpointBaseline` 的追加前检查从「整本解析」改为「尾部 64 KiB 窗口」（新模块 `adapters/storage/append-tail.mjs`）。**读门未改**：`readCheckpoint` 仍整本解析、首个坏行即 `usable:false`。2 万行账本实测 12.08 ms → 1.10 ms/次。
- **死分支（P3-08）**：`readSettings` 不再产生 `turnBasisInvalid` 标记，status 也不再印「配置值非法，已按 human 运行」——宿主 schema 早已在加载期拒绝非法值，那条提示不可达，且其「回落值」与 0.15.1 的新默认不一致。客户端 `diagnosticLines` 保持**未接线 + 如实标注**：诊断包四个事实今天都没有生产方，生产面上一行诊断都不出（有用例钉死）。

**验证**：`plugin` 源码树 `node scripts/test-all.mjs` **238/238 套件通过**（exit 0，2026-11-05，win32-x64 / Node v26.12.1）。**未做**：`release/` 镜像同步、打包、安装、重启 DSH——等用户授权。

### 0.15.1 修复轮补丁：按步归档「两步之间的回执」死锁（2026-11-05，真机走查发现）

真机把 `mode` 切到按步归档后**一次都压不动**：`/memory-lab status` 的「下一次归档」恒为「活动面不连续（not-dense）」。

- **根因**：真实宿主的 pre-step 在上一轮 `step/end` **之后**、下一步 `step/start` **之前**追加回执，而 `buildStepUnits` 只收「打开的步骤内」的事件——**落在两步之间的回执不属于任何步骤单元**。选择器因此完全看不见它：既不让单元 `hasPlugin`，也不会被吸收进 span，于是每段 span 的密集判据（`shadowed.length !== wanted.length`）必然失败。回执是 pre-step 产出的，位置**恒**在两步之间，所以「压完一批就永久停摆」不是偶发，而是按步归档在真实会话里的稳定结局。夹具里回执都写在步骤**内部**，因此离线一直是绿的。
- **修法**（`domain/archive/steps.mjs` 新增 `attachInterStepNodes`，在切完单元、进 `traceBatch` 之前只读归位）：把两步之间的活动面节点归到**前一个单元**——回注包**透明**（并进 `surfaceSeqs` 一起遮蔽，但不进 `recordSeqs`，与回注包既有口径一致）；回执/恢复、真人消息、其余无记录节点是**硬边界**（前一个单元到此收尾，边界留在活动面，后面的步另起一段）。硬边界同时作用于阶段 2（窗口内切 run）与阶段 3（批尾闭包向后扩展），两处都就地 `closeRun` 并如实报 `boundary`。
- **不改**：步骤**内部**的回执仍是整步边界（原判据一字未动，有用例对照）；回执不吸收（F1 / AUD51-05-02 不变）；净收益、pin、未完成工具对、H=200 判据全部不变。
- **守卫**：新增 `test/v3-step-inter-receipt.test.mjs`（5 例）——两步之间的回执是硬边界且不产生 not-dense、回执之后自成后续段（不停摆）、两步之间的回注包透明、段内回执判据不变（对照）、以及**端到端**：真实时序下 `archiveForStep` 真的落到活动面且回执仍在面上。
- **变异自证**：注释掉归位调用 → **4 例红**（含端到端）；恢复后 5/5 绿，文件 md5 回到原值。
- **真机日志复跑**：把上一会话的 `session.v4.jsonl.zstd`（14,614 事件 / 240 节点）按真实 surface fold 重放给选择器——修前 `not-dense`（`seqs [101,138]` 形状），修后正常成段。
- **验证**：`node scripts/test-all.mjs` **239/239 套件通过**（exit 0，`.tmp/full-r29.log`）；步骤相关 7 个套件 79/79 绿。**未做**：`release/` 镜像同步、打包、安装、重启 DSH——真机上要等重装并通过 pre-step 触发后才会看到按步归档恢复。

## 未发布：0.15.0 独立审计修复轮（2026-11-04）

按 `记忆上下文-0.15.0-独立审计报告` 逐项修复。**这一轮不改产品方向、不升版本号、不推送、不重新安装**；
下面的「验证」是本机源码树的离线结果，真实宿主行为仍未验收。

### 门禁可复现（H2 / F1–F3）

- `release/README.md` 重写为公开面（去掉 7 条包外开发链接），`release/CHANGELOG.md` 两处链接改为纯文本；
- `v3-i2-shadow` 合同文档路径改为相对 `plugin/` 推导，文档缺失时 skip（不再依赖已移除的 worktree 布局）；
- T2 超时定时器不再 `unref()`：等超时的调用方自己保证事件循环存活，`node --test` 22.x 下 5 个取消/超时用例不再被 cancelled；
- `scripts/test-all.mjs` 改**递归收集**（只排除 `p0/fixtures/` 测试数据），把 5 个 P0 反例以契约门形式并入
  （`test/p0/run-red-baseline.mjs`），去掉 `--test-force-exit`，skip 单独计数。

### 工具面与诊断（H1 / H3 / H7 / M7）

- **ops 不再跟随插件启动**：`cordis.patch.yml` 只保留 `memory-context-lab` 一行；删除
  `src/v3/adapters/dsh-ops/**`、composition `dshOps` 诊断项、客户端文案与测试；
- shadow 端口守卫改**读方法白名单 + set/defineProperty/deleteProperty/setPrototypeOf 陷阱 + 嵌套递归包装**，
  `set`/`persist`/`add`/`store`/`merge` 与直接赋值/删除一律拒绝；
- 诊断去掉 `MEMORY_CONTEXT_DIAGNOSTICS` 环境变量后门；诊断函数带运行时开关（关闭即抛 `EDIAGNOSTICS_DISABLED`），
  `calls` 改为只读 getter，外部赋值无法伪造「零调用」；
- 工具注册单条失败后可补齐：保留已成功项、只为缺失名字重试（有界退避），不再「一次失败永久缺位」。

### 隐私与隔离（H4 / H5 / M5 / M6 / M9）

- **遗忘语义显式化**：`forget apply` 仍是逻辑遗忘（冷库正文保留、undo 可用），命令面不再宣称「正文已清除」；
  新增 `forget purge` 物理删除正文与派生物（摘要转述、repair-log 残留、文件引用），undo 明确拒绝；
- 回执清除的持久标记失败不再被吞：只有「活动面替换 + redactions 标记」都成功才计清除；
- `adopt-from` 默认拒绝，父会话需显式 `adopt-allow on`；可判读的原生 fork 关系不一致即拒绝；
- 导入包增加体积（64 MiB）/条数（5000）/单条字符（1 MiB）上限；
- repair-log 不再写尾部半行原文（只留长度 + sha256 前 16）；文件引用不再落绝对路径（改 `workspaceId`），
  工作区外引用只留文件名，遗忘/清除时级联删除。

### 并发与存储（H6 / M1–M4 / M10 / C2）

- 凭证 ID 唯一性由存储层在跨进程锁内强制（`ESTORE_DUPLICATE_VOUCHER`），`recoverIntent` 不再锁外判重；
- `usage.jsonl` 追加进跨进程锁、按 seq 去重、加保留上限（1 MiB / 4096 行）；
- 写锁：staging 创建入 try（不再留孤儿 `.tmp`）、owner 读取对瞬态 EPERM/EBUSY 有界重试（C2 偶发失败根因方向）、
  rename 后复核 token（fencing）、取得尝试上限（防时钟回拨无界自旋）、释放失败返回 `error` 而非吞掉；
- 状态/控制读取每 tick 校验文件戳（去掉「目录 mtime 未变就 0 stat」的失败开放短路）；
- 版本补键在展开之后赋值（`schemaVersion: undefined` 不再落成无版本文件）；落盘写归一化结果。

### 技术债与测试强度（T3–T8 / C5 / C6）

- `textOfBlocks` 统一为 `domain/text/blocks.mjs` 单一实现（事件面 `\n`、预览面 `''` 显式声明）；
- `log-prefix` 自检改为真的写临时源文件并跑同一扫描器；
- `check-docs` 不再整目录豁免 `release/`（只豁免 `release/docs/` 镜像子树），`release/README.md` 照常审计；
- 发布包 `files` 去掉 `scripts/`（tgz 不再带 11 个开发脚本）；
- 新增：C4-9 写原语拒绝 `policyState`（C6）、计划冻结边界选择器用例（C5）、H1 工具面静态守卫、
  H4 purge、H5 同意门、H6 凭证去重、M3 文件戳新鲜度、M7 工具补齐等套件。

### 验证

- `node scripts/test-all.mjs`：**全部 203 套件通过（exit 0，Node v22.22.2，win32-x64）**；
  P0 契约门（R01/R03 GREEN + R02/R04/R08 冻结口径一致）在门禁内执行；
- `node scripts/check-docs.mjs`：**errors = 0**（288 个自有文档；release 公开面 `README.md`/`CHANGELOG.md` 照常审计，
  其余镜像子树按「第二副本」豁免；`dsh-ops/` 为独立子项目）；
- **安装（2026-11-04 15:15）**：`npm pack` 重建 `dist/dsh-memory-context-lab-0.15.0.tgz`（115 条目 / 561,043 B /
  sha256 `7bb5309f…cfb`，不含 `test/`、`scripts/`）；desktop profile `pnpm install` 完成，安装副本 0.15.0、
  `src/index.mjs` 哈希 `400bf0e1…`。**DSH 未重启**（仍是旧进程），重启后新代码才生效。
- **profile 清理（2026-11-04 15:19）**：`pnpm remove dsh-ops` 移除退役组件的 profile 依赖
  （`package.json`/`pnpm-lock.yaml` 无残留、`node_modules/dsh-ops` 已删除、删除 2 个包）；
  `dsh.profile.bundles` 本就不含它。孤儿运行时数据 `~/.dsh/dsh-ops`（便携 Git，412 MB）经确认后删除；
  源码目录 `dsh-ops/` 保留（独立子项目）。
- **未做**：DSH 重启、真实会话走查、推送/tag/Release。真实宿主行为仍按审计结论记为未验证。

## 0.15.0（2026-11-01，集成分支；按步攒批 + 回执摘要 + 缓存观测/检索修复）

本版把开发流程 P0–P8 中可离线验收的切片并入集成分支，并回答两条产品要求：**按步归档恢复“攒够 N 步再提交一批”**、**归档回执带总结且不破坏原历史**。P7 首次呈现按默认关闭交付；P0 的真实宿主/出站观测与 P9 真实模型对照仍未完成（见开发流程 §8.1 末）。

### 新增

- **按步攒批（`coolingBatchSize`）**：全局设置，1–200，默认 10。候选（工作集之外已完成的步骤）不足阈值时等待；达标后取最旧一批，按 pin / 未完成工具对 / 缺记录 / 插件回执等硬边界切成多个安全段，**逐段** intent+voucher 提交；单段失败即停并如实回报已提交/失败/未提交，已提交段不回滚，失败段保留 intent 供下次对账。显式 `now`/`compact` 绕闸门与阈值，但**不绕**保护闭包、完整性、正净收益与 H=200 上限。
- **回执摘要**：归档回执默认带确定性摘要（不调用模型、不引入新事实）。摘要预算 = `min(400, 原文 − 基础回执 − 余量)`，预算 < 40 时整条省略；**摘要不会导致归档失败**（小步骤仍可归档）。原事件仍 append-only 保留，`restore` 逐张恢复完整原文。
- **固定三工具**：`memory_context_search` / `memory_context_read` / `memory_context_compact`，版本加载时一次性注册、schema 固定；`submit` 只把提案排到下一安全边界（accepted ≠ committed），边界重验证失败即 stale。
- **缓存观测**：`plugin-surface` 影子观测（投影指纹/相位/代际/跨进程消息链种子），严格不参与归档决策（导入级 + 符号级守卫）。

### 组件与设置面（2026-11-04，用户拍板）

- **设置面只保留组件行页**：删除 `plugins.bundle.config` 注册，bundle 详情页不再出现「外面一层」设置块；
  同一张表单只挂在 `plugins.row.config`（键 `dsh-memory-context-lab#memory-context-lab`）。字段表见
  `docs/设置与组件.md`，17 个 `Config` 字段与客户端 `FIELDS` 仍由 `v3-client-surface` 交叉钉住。
- ~~**定制版 dsh-ops 成为第二组件**~~ **已于 2026-11-04 取消**：用户拍板「ops 跟随插件启动不再需要」。
  `cordis.patch.yml` 恢复只声明 `memory-context-lab` 一行；I3 shadow adapter、composition `dshOps`
  诊断项、客户端文案与对应测试一并删除。默认工具面回到「不隐藏、不替换官方工具」——与 P2 工具面
  合同一致，也消除了「默认替换官方工具但从未验收」的中间态。dsh-ops 源码仍是独立子项目，
  需要时自行安装，不再由本插件启动或改变模型可见工具集合。
- **旧组件形态（历史）**：0.15.0 曾把 dsh-ops 以普通依赖装进 profile（不进 `dsh.profile.bundles`），
  并注册组件行设置页与运行时状态卡。该形态随「ops 跟随插件启动」取消一并退役：现行安装面只有本插件
  tgz，patch 只有一条组件行，`enableMode: with-memory-context` 的跟随 gate 不再是待接线项。
- **验证**：源码树 `node scripts/test-all.mjs` **全部 199 套件通过**（2026-11-04，win32-x64，Node v26.12.1）。
  dsh-ops 侧 `npm run build` + `npm run build:ptc`（Rust 1.88，win32-x64 worker）通过；完整 `npm run verify`
  未跑（worker 套件与上游 CI 门不在本轮范围）。

### 修复

- **检索命中窗口**：稀有标识符加权，自然问句下尾部错误码/路径不再被正文常用词挤掉；`truncated` 如实反映中段缺口；chunk 索引截断时回退现扫；`boundQuery` 不再切碎尾实体。
- **T2 合同**：显式 deadline 被尊重（文档化 60s 硬顶）；`k` 参数与 `state` 四态资格保留；外部名次分不穿本地装包门。0.9.17 仍为 candidate，默认名单仍是 0.9.10。
- **摘要完整性**：读取/导出路径重算 sources 指纹并与落盘值对账，篡改 `sources` 会让摘要不可见、不可导出（隐私失败关闭）。
- **资源释放**：`runtime.close` 等 provider 关闭落定后再关 store；`dispose` 返回 Promise；provider 拒绝不产生未处理拒绝。
- **观察面如实**：窗口外候选全部不划算时报 `not-worth`（带跳过段数与字数），不再冒充「保留窗口」。

### 验证

源码树（集成分支，2026-11-01，Node v26.12.1 / win32-x64）：`node scripts/test-all.mjs` **exit 0**，原文「全部 163 套件通过。」；聚合 **163 套 / 901 用例 / 895 通过 / 0 失败 / 6 skip**（skip = install 4 + release-doc 1 + win32 0600 1）。

### 未验边界

- **P0 未通过**：真实宿主 runtime 时序、`outbound-request`/供应商 wire、脱敏可回放轨迹、真实 usage 指标口径仍缺；本版只冻结源码/夹具证据。
- **P9 未做**：无真实模型配对评估，因此不宣称缓存命中/成本收益。
- **P7 未启用**：源码合同成立（pre-step 改写会在下一次 `deriveMessages` 生效），但真机顺序未验；候选默认关闭、装配零引用。
- **P6 关闭**：无数据集与逐路径消融证据，`queryExcerpt`/多路召回/图与时间路径/任务事实均未启用。


## 未发布（beta.55 候选：beta.54 审计后续 B 组，2026-10-31；**版本号未升**，package.json 仍 0.14.0-beta.54）

收「记忆上下文插件：beta.54 审计后续——修复与改进方案（2026-10-31，存工作区外，不入仓）」B 组 2 项（负责人 2026-10-31 拍板：D2 做、D4 做）。不改产品边界：归档/回注/恢复语义不变，只加一个新结果态与两条暂停文案。

### 变更

- **B-1 归档单飞**：`archiveForStep` 拆成单飞包装 + `runArchiveForStep` 原主体。同一进程内同一会话的归档同时只允许一个在跑，第二个立刻得到新结果态 **`archive-busy`**（不排队）——旧实现 `entry.inflight` 只挡摄入，`/memory-lab now` 与 pre-step 同时进入会在占槽层撞出一条 `intent-pending` 失败（无数据损坏，但用户看到一条 failed 噪音）。`try/finally` 保证抛错也清闸（否则永久 busy）。调用点适配：pre-step 的归档结果本就被忽略（busy 静默跳过，下一步自然重试）；`now`/`compact` 的回执经 `archiveLine` 新分支回「正在归档中（并发归档已被挡住），稍后再试。」。**语义边界（不夸大）**：单飞只覆盖本进程，两个进程仍可能同时归档——那时由占槽返回 `intent-pending`；`dryRunArchive`（status）不加单飞，只读必须永远能答。
- **B-2 status 预览对齐 pending intent**：`dryRunArchive` 在 paused 判断之后、选 span 之前经**只读** `peekArchiveIntent` 看一眼意图槽位：槽位压着未对账意图（或内容不是合法意图对象）→ 预览返回 `intent-pending`；意图文件不可读 → `intent-unreadable`；两个新状态在 `archiveLine` 显示为「暂停：存在未对账的归档意图（活动面已替换、凭证未落账）…」与「暂停：归档意图文件不可读（失败关闭）…」。旧实现预览只跑选择器，槽位占用时 status 仍显示「下一次归档：seq X–Y（可归档）」，而真实提交会被锁内占槽挡下——预览与实际自相矛盾。分类判据 `classifyArchiveIntent` 是 **peek 与 reserve 共用的唯一实现**（判据同源）；reserve 外层行为不变（半截 JSON → unreadable 失败关闭、身份不匹配 → pending）。peek 不进写锁、无任何写副作用（不写盘、不补账、不清理），**不加缓存**（缓存会让「刚对账完仍显示暂停」，正是本项要消除的矛盾）。

### 验证

- 源码树全量（真 node v26.12.1，三片 47+47+45，2026-10-31）：**139 套 / 628 用例 / 623 通过 / 0 失败 / 5 skip**（基线 137 套/621 例 + 新增 2 套 7 例；skip = install 4 条安装面按设计 SKIP——源码已改、安装副本仍旧代码——+ v3-export 1 条 win32 0600）。
- 新增 `v3-archive-singleflight`（4 条：Promise.all 并发恰一 archived 一 busy 且只多一张回执/单飞期间槽位 absent/busy 与抛错后可恢复/单飞窗口内外来占槽被槽位挡住——单飞不越权替代占槽）、`v3-status-intent-preview`（3 条：pending 槽预览返回 intent-pending 且文本不说「可归档」/目录占位注入读错误 → intent-unreadable/空槽回归保护 + peek 零副作用）。
- 反例回归（改回去必红 → 复原必绿）：删 `archive-busy` 闸 → singleflight S1 红；`try/finally` 改裸 await → S3 红；删 peek 分支 → status-preview P1/P2 红。

## 0.14.0-beta.54（2026-10-31，测试版）

收「记忆上下文插件：详细修复与改进方案（2026-10-30，存工作区外，不入仓）」A 批「持久化与补账」4 项：R2-01 / R3-01 / R3-02（P1）+ R3-03（P2）。不改产品边界：命令面、设置面、面板文案均无变化。

### 变更

- **R2-01（P1）归档意图占槽**：新归档提交前先经 `reserveArchiveIntent` 在会话跨进程写锁内重读校验——槽位为空或同一身份（幂等重占）才写入；已有未对账意图（pending）或意图不可读（unreadable）→ 结构化阻断本会话的新归档（不写 intent、不碰宿主面、不追加凭证，正常对话与只读能力不受影响）。归档意图带稳定 `intentId`，由 `random.uuid` 端口生成（composition 注入、entry 装配传入，application 层不直接 import node:*）。入口对账结果改为可观测：意图补账失败/清理冲突/不可读均上报 `keptIntent`，归档面据此暂停，直到对账收敛。
- **R3-02（P1）按身份清理**：新增 `clearArchiveIntentIfMatches`——锁内重读比对身份（新格式比 `intentId`；旧格式没有 ID 时以规范化完整载荷指纹作一次性比较条件），不匹配返回 `conflict` 而不删除；迟到的旧清理不再可能删除新意图。清理冲突/失败如实上报（`cleared:false` + `clearStatus`），不再冒充清理成功。旧 `clearArchiveIntent`（按路径无条件 rm）删除。
- **R3-01（P1）state/control 锁内读改写**：新增 `updateSessionState` / `updateSessionControl` / `ensureInitialSessionState`——在同一会话跨进程写锁内**强制磁盘重读 → 归一化 → 合并 patch → 原子写回**；入口的 setState / setControl / 初始化 / 对账位点写入全部改走 patch。并发改不同顶层/嵌套字段不再互相覆盖；损坏/不可读的现存状态不按默认值覆盖（失败关闭）；非法 patch 抛错且磁盘不变；初始化 create-if-absent，两进程同时初始化只落一个。
- **R3-03（P2）写锁续约与失锁失败关闭**：续约间隔按**实际 TTL** 推导（`heartbeatIntervalOf`，恒小于 TTL；旧实现固定按默认 60s 推导，自定义小 TTL 的长事务在首次续约前就被别的进程判 stale 接管）；续约单飞；心跳 lost（token 被换）或出错 → 停表并经 `ownership.assertOwned()` 抛新错误码 **ELOCK_LOST**。store 全部写原语（事务提交/凭证追加/遗忘与撤销/导入/隐私标记/检查点/索引重建短写）与 journal repair 的截断在提交前复核所有权——失锁后拒绝继续写；已在途的写入保留事务恢复证据，抛错不等于撤销。边界：提交前检查与真正落盘之间仍有窗口，这是协作式取消，不是硬性跨进程 fencing。
- **守卫两处（全量回归撞出，均已修复复验）**：`contract-wiring` 判 `clearArchiveIntent` 导出零消费 → 按白名单只缩不涨删除该死导出，e2e 三个 journal 夹具的 clear 改走按身份清理；`architecture-guard` 判 application 层 `import node:crypto` 违反依赖方向 → `random` 端口随 runtime 透出，5 个测试文件 10 处 `createArchiveService` 调用点补注入。

### 验证

- 源码树全量（真 node v26.12.1，三片 46+46+44，2026-10-31）：**136 套 / 618 用例 / 613 通过 / 0 失败 / 5 skip**。5 条 skip = install.test.mjs 4 条（profile 尚未装本版时安装面断言按设计跳过，安装后复跑转真跑）+ v3-export.test.mjs 1 条（win32 的 chmod 只作用只读位，0600 mode 断言按任务书 skip）。
- 新增 4 套 29 例：`v3-intent-reserve`（7：占槽幂等/拒绝/旧格式指纹/并发恰一成功含真实子进程/按身份清理/R3-02 编排/不可读失败关闭）、`v3-archive-intent-guard`（7：正常归档/凭证持续失败不覆盖旧意图/解除故障恰好补一次/不可读阻断/迟到清理不删新意图/引擎级 pending 与 unreadable 阻断自愈）、`v3-lock-renewal`（7：间隔推导/小 TTL 保活/失锁传播 ELOCK_LOST/心跳出错/正常与重入路径/token 透传）、`v3-state-control-rmw`（8：并发改不同字段全保留/嵌套按域合并/读缓存落后于磁盘/损坏不覆盖/create-if-absent/非法 patch 失败关闭/control 并发/跨进程真实子进程）。
- 反例回归（改回去必红）：`v3-lock-renewal` 的「小 TTL 长事务：旧固定间隔必被接管」、`v3-state-control-rmw` 的「并发改不同字段（旧写法确定丢字段）」、`v3-intent-reserve` 的「R3-02 编排：A 迟到清理 → B 的意图仍在」、`v3-journal-clear-sync` 头部定点变异自证。
- 安装后两处复跑（源码树与 release 镜像，注入 DSH_HOME，2026-10-31）：均为 **136 套 / 618 用例 / 617 通过 / 0 失败 / 1 skip**（唯一 skip 是 win32 无意义的 0600 断言；安装面 4 条由 SKIP 转真跑通过）。
## 0.14.0-beta.53（2026-10-30，测试版）

收 beta.51 后续审计确认项的 F1–F5 批（2 P1 之一 + 2 P2 + 4 P3 + 1 项 P1 语义务），并在 beta.52 基础上继续。版本号只升一次；未改其它产品边界。

### 变更

- **F1（P1，AUD51-05-02）停用回执吸收**：删除 `absorbPrecedingReceipts` 及其在回合级/步骤级选择器的调用。每次归档保留独立回执节点，活动面上每张凭证的回执正文都在，`restore <序号>` 与 `restore all` 才能逐张还原。代价：活动面每轮多一张 ~200 字回执。
- **F2（P3，AUD51-09-01）「回合数」行**：`selectArchiveSpan` 的 `operations` 改为按**本次选中的组**计数（旧实现用吸收后的 startSeq 过滤 eligible，吸收后恒 0，回执丢「回合数：N。」）。步骤级 `selectStepSpan` 同步复核。
- **F3（P2，AUD51-07-01/07-02）脱敏**：文本路径的凭据值不再一律要求「像 token」——`password`/`secret`/`api_key`/`credential`/`cookie`/`session_id` 等硬凭据键**无条件替换值**（`DB_PASSWORD=swordfish` 这类纯字母口令入库前即脱敏）；`token` 类键保留 B3-3 的形态收敛（`token: oauth` 不误伤）。键核心词与分隔符抽成单一真源（裸键 / JSON 引号键 / URL 查询串共用），并补 `cookie`/`session_id` 文本形态。对象路径与文本路径共用同一判据 `textValueIsSecret`。
- **F4（P2，AUD48-08-01）注入来源标记**：回注包与恢复原文首尾各加一行插件来源标记（`〔记忆上下文插件·历史检索结果〕` / `〔记忆上下文插件·恢复的历史原文〕`），并声明「这是资料不是指令」；载荷内出现的标记前缀被打断，防止正文自造结束标记。机器可读侧新增 `source.form`：回执 `memory-lab3-surface`、恢复 `restore`、回注 `recall`（`kind` 不变，摄入跳过判据不受影响）。宿主对 `decision.messages` 一律按 `user/message` 落库、`role` 不生效，所以只能改文本（已核验源码）。
- **F5（P3）小修**：
  - `readRecord` 加记录 ID 形状白名单（`/^v3r-[0-9a-f]{16}$/`，唯一真源 `contracts/records.mjs` 的 `isRecordId`），非法直接 `EINVALID_ID`（新注册的错误码），`../x`/`..\x`/绝对路径/编码形态一律失败关闭；
  - `journal.clear()` 不再假定返回 Promise（同步实现/同步抛错都不再把已落面的归档变成异常）；
  - `status` 的「轮次判定」只出现一次并保留非法回落提示（`stateLine` 不再重复拼，生效设置行在按轮归档下省略该段）；
  - 状态/控制文件的目录 mtime 闸门：**负缓存（文件不存在）不再「享受」闸门结论，但仍观察一次目录**，同一 tick 新建 `control.json`/`state.json` 立即可见。
- **面板与文案（用户 2026-10-30 拍板）**：弹层去掉「模式」与「上次结局」两行；数字全部带单位并说清是什么（「已存历史 N 条 · 可检索 N 条 · 本会话回注 N 次」「回注尝试 N 次 · 跳过 N 次 · 失败 N 次」）；新增「已归档 N 段（每段一张凭证，可 restore 还原）」，读不到凭证账本时显示「未知」而不是 0。状态投影 `STATUS_PROJECTION_VERSION` 2 → 3（view 增加 `archived`）。
- **`receipt-changed` 文案**：吸收停用后不再归因「被后续归档吸收」，改为「活动面上找不到与凭证逐字节相同的回执正文（回执已被改写或压缩）；旧轮请按记录 ID 回读原文」。

### 验证

- 新增 `v3-receipt-independent`（5 条：连续归档 3 轮后活动面 3 张回执、每张都能 restore）、`v3-redact-aud51`（6 条：纯字母凭据值 + Cookie/Set-Cookie/session_id 的文本/摄入/导出三路径）、`v3-injection-source-marker`（3 条：标记本身/恢复落面/回注落面）、`v3-record-id-whitelist`（3 条：穿越形态/非字符串/合法不回归）、`v3-journal-clear-sync`（3 条：同步返回/同步抛错/Promise 两态）、`v3-status-turnbasis-single`（3 条：合法一条/非法一条带提示/stateLine 不重复）。
- 删除 `v3-receipt-absorb`（吸收退场）；更新 `v3-command-surface`/`v3-surface-contract`/`v3-client-chip`/`v3-status-projection-control`/`v3-status-file-gate`/`v3-redact-false-positive`/`install` 断言。
- 全量 `test:all`：**安装前**源码树与 release 镜像各 **132 套 / 589 用例 / 584 通过 / 0 失败 / 5 skip**（5 skip = 安装面 4 条按版本差异跳过 + win32 无意义的 0600 断言）；**安装到 profile 后**两处复跑均 **588 通过 / 0 失败 / 1 skip**（安装面 4 条转为真跑通过，唯一 skip 是 win32 无意义的 0600 断言）。
- 发布与安装：release 镜像自测全绿；profile 依赖已切到本版 tgz 并完成 `pnpm install`（安装副本 0.14.0-beta.53，`src/` 与 release 0 差异）；**DSH 未重启**，重启后新语义生效。tag/Release 未推送。tgz 条目数、字节数与 sha256 记在开发仓进展卡（包内文档不写自身哈希：哈希算的是含本文件的包，写进来必然自指矛盾）。

## 0.14.0-beta.52（2026-10-30，测试版）

用户拍板：归档/恢复都不再设体积预算；恢复超上下文交给 DSH 自身压缩；新增手动归档按钮。

### 变更

- **移除归档预算门（AUD51-05-01 的根因）**：`makePlan` 不再按 `restoreChars` 拒绝归档；`restoreChars` 只作为凭证上的观测值（`history` 可预判），归档照常进行。
- **移除恢复上限**：删除设置项 `restoreMaxChars`；`restoreVoucher`/`restoreAll` 不再有 `maxChars`；`restore-too-large` 退场。恢复多少由用户决定，超上下文由 DSH 压缩处理。
- **手动归档**：composer 弹层「本对话控制」与侧栏面板都新增「立即归档」按钮，执行 `/memory-lab now`；用户可在需要时自行折叠已完成回合。
- **文案**：`receipt-changed` 说明「回执已被后续归档吸收，旧轮请按记录 ID 回读」；`status`/`config show`/帮助不再出现恢复预算。

### 验证

- 新增 `v3-restore-unbounded`（4 条：大回合照常归档、恢复完整文本、dry-run 无预算拒绝、设置/文案退场）；`v3-command-surface`/`v3-surface-contract`/`v3-client-chip` 同步更新。
- 全量 `test:all`：**127 套 / 569 用例 / 568 通过 / 0 失败 / 1 skip**（安装后；唯一 skip 为 0600 的 POSIX-only 断言）；release 镜像同口径 568 通过 / 0 失败 / 1 skip。安装前为 564 通过 / 5 skip（安装面因版本不同按设计跳过）。

# 变更记录

> 0.14.0-beta.7 ~ beta.10 未在本文件单独收录（当时以进展卡与转正方案为准）；beta.11 起恢复逐版记录。

## 0.14.0-beta.51（2026-10-30，测试版）

相比 0.14.0-beta.50（本版一次收完[审计 beta.50 后续]的全部 40 项确认缺陷：2 P1 + 10 P2 + 28 P3，按 B1/B2/B3 批执行；不改产品边界）：

### 修复（B1 批，两个 P1）

- **AUD50-02-01（B1-1）：JSON 引号键凭据绕过脱敏**。`redactText` 补引号键形态（键名允许引号、分隔符两侧空白）；脱敏实现上移到 `domain/security/redact.mjs` 供摄入与导出共用；导出重建时对正文**再过一次脱敏**（与 07-01 修复同一道双保险）。
- **AUD50-02-02（B1-2）：恢复预算 16k 与自动回执体积冲突**（实测单凭证 20 万+ 字符，restore 永久失败）。按产品拍板落地：恢复预算改为设置项 **`restoreMaxChars`「恢复正文上限」**（1000–200000，默认 16000；非法值回落默认，失败关闭）；**不做隐式截断**；归档/恢复因超预算失败时给出实际体积、预算值与调法（不藏配置名）。

### 修复（B2 批，P2 数据完整性 / 隐私 / 性能）

- **摄入 02-03/04/05**：单个缺 `arguments` 的 tool/call 不再永久卡死本会话摄入（拒绝计数在 status 可见，不重放）；assistant 工具调用块兼容真实宿主的 `{type,id,name,arguments}` 形状；脱敏值的 `;/,;` 分隔边界按上下文区分，分隔符后的凭据续脱敏。
- **存储 03-01/02/03**：打开期对账整段进跨进程写锁（不再与在飞提交竞态锁死会话）；`importRecords` 与事务/遗忘共用同一把锁与事务号分配（不再并发同号）；`records/` 只认合法记录名，崩溃 tmp 启动即清。
- **性能 04-01/02**：会话 runtime 空闲淘汰（store + T1 解析索引不再每会话常驻，淘汰时释放缓存）；新增**打开期检查点**（事件→记录映射，与提交同锁追加、失败只损下次打开速度），进程内打开不再 O(记录数) 全量读。
- **状态 06-01**：`status` 生效设置行消费合并后的完整全局值（不再丢 turnBasis/fullHistory/planFirst/autoRestore 四键，与 `config show` 同源）。
- **导出 07-01**：导出重建时 user/assistant/tool 正文一律再过 `redactText`；清除账本读不到仍失败关闭。

### 修复（B3 批，P3 批量小修）

- **摄入/脱敏**：事件时间只在未来得合法时保留（02-06）；`redactValue` 截断可见（02-07）；非凭据键名白名单，author/authMode 等不再过度脱敏（02-08）；归一化失败的尾部事件不再堵住 lastSeq 推进（02-09）。
- **存储**：事务 commit 行丢失如实报告（03-04）；写锁读错误只把 ENOENT 当「没有」（03-05）；voucher/redactions 追加并入写锁（03-06）。
- **归档/索引**：归档选择**吸收紧邻上一张回执**（一进一出，不再每轮 +1 常驻，05-01）；当前轮判定以日志为权威，不再固定晚一个 step（05-02）；dsh start/end 不按数值比较（宿主为字符串序号）；归档选择改增量投影缓存（04-03）；statusOf 的 I/O 事实如实标注（04-04）；indexStamp 弃 mtimeMs 粒度（04-05）。
- **命令/UI**：`restore` 先判 `result.error`（06-02）；`verify all` 空态口径对齐 file-status（06-03）；USAGE/hint 补 `set gate`（06-04）；`unpin` 回报实际移除数（06-05）；not-found 与库损坏错误码分离（06-06）；composer 弹层消费 `stateError`（06-07）；`turnBasis` 改枚举校验，非法值回落可见（06-08）。
- **隐私/导入**：导入按 `validateRecord` 整包预检（07-02）；分享包默认 0600 收紧（07-03）；导出 state 白名单，只留可解释归档事实（07-04）。
- **发布/测试（10-01..06）**：删除死模块 `card-renderer.mjs`/`budget.mjs`；安装面版本门改**整树哈希**比对；host 契约探针扩到 11 项字段并钉进测试；新增 release↔plugin 文档差异白名单守卫（`release-doc-guard`）；npm 分发现状、公开面流程与「未重启」口径按事实改正。

### 验证

- 新增回归 29 个测试文件（脱敏 5 条、命令面契约、导入预检、打开检查点、回执吸收、写锁并发/凭证锁、runtime 淘汰、恢复预算、turnBasis 枚举、安装面守卫、宿主探针、release 文档守卫等）；删除随死模块退场的 3 个旧测试。
- 源码树全量 `npm run test:all`：**127 套 / 571 用例 / 566 通过 / 0 失败 / 5 skip**（skip = 安装面 5 条，未安装时按设计跳过）（2026-10-30，日志 `plugin/.tmp/test-beta51.log`）。
- 安装后复跑：**127 套 / 571 用例 / 570 通过 / 0 失败 / 1 skip**——安装面 5 条真跑全过；唯一 skip 是「导出文件 0600」的 POSIX-only 断言（win32 chmod 无意义，用例自注）。
- **发布与安装**：release 镜像自测 **127 套全绿**（安装面 5 条在镜像内按设计 skip）；tag `v0.14.0-beta.51`（commit `a8586e4`），origin/main 与 tag 均已推送（ahead/behind 0 0）；tgz 78 条目 / 266,993 B / sha256 `e28ac854…068f`；**GitHub Release 未建（gh 未登录，待补）**，npm 分发仍未实施。profile 已装 beta.51（pnpm，安装 2026-10-30 **12:02:21**），安装副本 0.14.0-beta.51 与 release src 一致；DSH 已于 2026-10-30 **12:07:25** 重启并运行 beta.51（进程核对：主进程族最早启动 12:07:25，晚于安装 12:02:21；安装副本 0.14.0-beta.51）。原「未重启」口径随即过时。

## 0.14.0-beta.50（2026-10-29，测试版）

相比 0.14.0-beta.49（本版修审计 beta.49 的 3 个 P1 + 归档选择器 2 个 P2/P3，均为已确认缺陷）：

### 修复（按轮归档 turnBasis=dsh 的真实停摆点）

- **P1 AUD48-04-04：系统提示节点让首轮永久不可归档，并堵死后续所有轮**。真实宿主把渲染后的系统提示作为 `system/message` 活动面 node 0；插件摄入封闭集不含它（无 v3 记录），dsh 分组又把它算进第 1 轮，选择器在队头遇到 `missing-record` 直接 break；同时宿主拒绝 `user/message` 回执覆盖 node 0，跨 node 0 的替换必然失败。修法：`system/message` / `developer/message` 作为**结构性边界**，不纳入任何轮组（留在活动面、不被遮蔽），档从它之后开始；组中段出现时切段，不跨它拼 span。真实副本复跑：`full-history => {start:18,end:760,recs:163}`（修前 `missing-record seq 17`）。
- **P1 同一根因的后续：上一轮回执被算进下一轮**。归档回执的事件 seq 落在下一轮开头（`turn/start` 已把它的 seq 归到下一轮），旧 `groupByDshTurn` 给它打 turn，下一轮组 `hasPlugin=true` → `plugin-boundary`，归档只成功一次。修法：非回注的插件节点（回执/恢复）不参与轮组，作为表面分隔 `finish` 后跳过；回注包仍透明。新增回归：系统提示 + 两轮归档 + 第三轮后继续归档第 2 轮。
- **P2 AUD48-04-01：空正文回合的净收益洞**。`makePlan` 的 `sourceChars > 0 &&` 短路让 0 字正文的完成回合也被压成 160 字回执，活动面净增。修法：`receiptText.length >= sourceChars`（含 0 必判负）；结构（toolCalls）的可恢复性不改变「可见正文为 0」。
- **P3 AUD48-04-02：回执「操作数」恒为 1**。按轮归档的 operations 是**回合数**、按步归档是**步骤数**；回执改按口径写「回合数：N」/「步骤数：N」，不再把 1 个回合误写成 1 次操作。
- **P3 AUD48-11-01：判负被掩盖 + now 不能重试**。判负 span 之后没有别的候选时，旧实现把原因掩成 `no-completed-group`，且进程内游标让同一 span 无法重试。修法：记住最近一次 `not-worth` 事实供 status/dry-run 读取（不覆盖 pinned/missing-record 等安全边界原因）；`/memory-lab now` 显式忽略判负游标重试一次。

### 修复（审计批次 1 其余 P1/P2）

- **P1 AUD48-02-04：脱敏漏前缀键 / PEM / 全角冒号 / URL 编码**。`SENSITIVE_VALUE_PATTERNS` 的 `\b` 在 `AWS_SECRET_ACCESS_KEY` / `MY_API_KEY` 的 `_` 处不成立；补 PEM 私钥整段规则、键名允许 `._-` 连接、分隔符收全角冒号与 `%3D`；只替换值、保留键名。
- **P1 AUD48-08-02：导出包带走已遗忘/已清除的回执摘要**。导出改为接收 `redactedVoucherIds`：redactions 命中、或 `recordIds` 与 forgotten 相交的凭证，剥离 `receiptText/summaryText` 并标 `redacted:true`，与 history 的「正文已清除」口径一致；清除账本读不到时导出失败关闭。
- **P2 AUD48-08-03：导入/导出丢 metaOnly / structure**。bundle 保留 `payload.metaOnly/metaReason/structure`，`importRecords` 同字段落库；导入后「仅元数据」不再被当成空正文损坏，工具调用参数不丢。

### 验证

- 新增/扩展回归：`v3-archive-prestep`（系统提示首节点、回执边界）、`v3-archive-not-worth`（空正文判负 + 状态可见 + now 重试）、`v3-ingest-redaction`（前缀键/PEM/全角/URL 编码）、`v3-export`（凭证清除 + metaOnly/structure 往返）。
- 红绿对照：临时回退 `plugin/src` 后，上述用例全部失败（系统提示/回执边界/滞后 turn 3 红、空正文 1 红、脱敏 1 红、导出 2 红）；恢复后全部通过。
- 全量：**101 套 / 475 用例 / 475 通过 / 0 失败 / 0 skip**（`npm test`，2026-10-29；日志 `.tmp/test-beta50.log`）。
- **发布与安装**：release 镜像自测 101 套全绿（安装后安装面 5 条真跑）；tag `v0.14.0-beta.50`（commit `5d0f13f`）、GitHub Release（Pre-release）asset 78 files / 243,865 B / sha256 `b04e72d4…2df9`；profile 已装 beta.50，安装副本 `src/` 63 文件与 release 逐字节一致（唯一差异是发布侧镜像标记行）。DSH 已于 2026-10-29 21:34:43 重启并运行 beta.50（安装 21:22:12；发布时记的「未重启」随即过时，AUD50-10-01 复核作废）。

## 0.14.0-beta.49（2026-10-29，测试版）

相比 0.14.0-beta.48：

### 修复（按轮归档：切换 dsh 后反而停摆）

- **P1 `currentTurn` 滞后导致整段历史变「当前轮」**：`groupByDshTurn` 原先只拒绝「超前于日志最大轮一步以上」的 `payload.turn`，没有拒绝**滞后**。当真机把 turn 交成 1 而日志已到第 3 轮时，`group.turn >= 1` 会把第 1/2 轮也标成 current，选择器返回 `no-candidate / no-completed-group`，按轮归档从此对整段历史失效（切回 human 后因新真人消息重新出现完成轮，才恢复）。
- **修法**：只有 `currentTurn === lastTurn` 或 `currentTurn === lastTurn + 1` 才信任；滞后/超前都退回「最后一组是当前轮」，宁可晚压一轮，也不能把活动内容压掉。
- **验证**：新增 `v3-archive-prestep` 用例「currentTurn 滞后于日志最大轮时，仍按最后一组为当前轮归档」；修前实测返回 `no-candidate / no-completed-group`，修后归档第 1 轮（seq 2–3），第 2/3 轮保留。
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
- 全量 101 套 / 468 用例 / 468 通过 / 0 失败 / 0 skip（安装 beta.48 后安装面 5 条全部真跑）。

### 发布

- tag `v0.14.0-beta.48`（commit `82764d4`）；GitHub Release（Pre-release）asset 78 files / 241,227 B / sha256 `4131f77d137f6cbacc69ce83185857b614afbc4d454ac9284686d7f49e028c0c`（远端 digest 已核对）。
- profile 依赖切到 `记忆上下文/dist/dsh-memory-context-lab-0.14.0-beta.48.tgz` 并 `pnpm install`；安装副本 `src/` 63 文件与 release 逐字节一致（唯一差异是发布侧镜像标记行）；安装面 5/5 真跑通过。**未重启 DSH**。

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
- **文档**：[实时降温判定设计-beta.40]（灵枢 role 分层/时间衰减/可回读/主动遗忘四条对照，及为何不引入概率模型）。

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
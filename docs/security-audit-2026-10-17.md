# 外部安全审计（2026-10-17）— 0.10.1 的遗忘完整性与新增面

**方法** 三路并行只读审计（遗忘复活面 / 层级压缩与来源 / 冷库与边界）+ 关键发现逐条人工复核 + 修复后全量回归。审计与修复由外部贡献者完成（与作者不同会话）。

## 结果总览

| 级别 | 数量 | 已修复于本 PR |
|---|---|---|
| P0 | 1 | ✅ 层级压缩候选未过滤遗忘成员（复活口） |
| P1 | 1 | ⚠ 报告（跨进程目录互斥缺失——设计裁量，未改） |
| P2 | 6 | ✅×3（fork 时序侧信道 / 弱候选 exclude / relations 面泄露）；⚠×3 报告 |

## P0：层级压缩候选未过滤遗忘成员——已遗忘内容经蒸馏复活

**位置** hierarchy-coordinator.mjs `memberViewOf`：对 `plan.recordIds` 逐条 `deps.getRecordBody(recordId)`，**无任何遗忘账本查询**；冷库正文不可读时静默回退到回执原文（注释自述「不是阻断」）。而 runtime 注入的 deps 里**本来就提供了** `isRecordVisible`（遗忘账本同步过滤）——但只有展开页的渲染路径在用。

**攻击链**：归档成员 → `forget` 该成员（账本墓碑，冷文件仍在）→ 层级压缩对该组运行 → `getRecordBody` 读回已遗忘成员的**原文全文** → 进入 extractAtoms → 蒸馏卡（L1）/相位卡（L2）/聚合凭证——已遗忘内容经蒸馏面重新可读。展开页的同款过滤只管渲染，管不住蒸馏阶段的内容吸收。

**修复（本 PR）**：候选阶段逐成员查遗忘账本，任一成员不可见 → 整组 `return null`（失败关闭，调用方以 `status: 'blocked'` 记录）。不做部分排除——避免凭证 digest 与成员集的语义复杂化，保守优先。

## P2 修复（3 项，本 PR）

1. **fork-map 先读后拒的时序侧信道**（readback.mjs）：父 ID 经 fork 解析到已遗忘子 ID 时，旧代码先 `readRecord`（载荷入内存、哈希校验完成）再查墓碑——调用方可从时序区分「已遗忘但物理存在」。修复：墓碑判定前移到任何磁盘读取之前。
2. **弱候选未过滤遗忘**（client-adapter）：`queryDetailed` 支持 `exclude` 参数但调用方未传——遗忘后到下次索引同步之间，弱指针会指向已遗忘冷记录（存在性泄露；回读仍 fail-closed）。修复：把遗忘账本的 ID 集合传入 exclude。
3. **relations 面泄露已遗忘配对伙伴**（retrieval.mjs `describeRecordRelations`）：callId 配对循环不过遗忘账本。修复：新增 `forgetIndex` 参数，配对循环剔除已遗忘伙伴（runtime 传入）。

## 报告但未改（需要作者裁量）

1. **P1 跨进程目录互斥缺失**（store.mjs `#reserveDirectory`）：`openDirectories` 是进程内 Set——两个 Node 进程同时打开同一会话目录会各持 catalog 与事务号，后写覆盖前写、事务号可复用（崩溃对账前提被破坏）。修复方向：目录级锁文件（pid+启动时间）或 OS 独占句柄 + `ELOCKED`。改动面涉及所有打开路径，留作者裁量。
2. **读路径默认不校验哈希**：`store.readRecord` 不传 `verifyHash` 时返回 `integrity:'ok'` + `verified:false`——等长篡改可漏过。回读层（readback）默认 `verifyHash:true` 且 verified 位语义正确（BUG-012 修复），但任何新调用方忘记检查 `verified` 就会拿到「看起来 ok」的未验内容。建议：`integrity:'ok'` 仅在 verified 为真时给出（或改名 `unverified` 迫使显式接受）——涉及全部调用方，留作者裁量。
3. **writeFileAtomic 无 fsync**：断电窗口内 rename 已落盘而数据未刷 → payload 空洞（size-mismatch 会被发现，等长篡改在 P1-2 前提下漏过）。建议 open→write→sync→close。
4. **readJson 把不可读折叠为 undefined**：与 `readJsonStrict`（EDAMAGED）并存易被误用——调用方 falsy 判断会把损坏当未初始化。
5. **readRange 的 maxBytes 无上界 clamp**：若来自不可信的载荷头声明会大额分配（调用点未确认是否已 clamp）。
6. **getRecordKind 读失败默认 'tool-output'**：来源维度弱标注（作者注释自述「不猜」——但 tool-output 是个确定标签，`unknown` 更诚实）。

## 审计确认为稳固的部分

- 遗忘守卫双路径覆盖：精确 ID（readback.mjs:44-50，守卫在 readRecord 之前）与 fork-map 别名（本 PR 前为读后拒，本 PR 后为读前拒）均抛结构化 `EFORGOTTEN`
- 冷写拒绝遗忘节点（client-adapter:206-208）；回注候选面剔除遗忘 span（:304-308，计数单列）；searchRecords 检索通道同口径过滤（:346-348）
- 索引同步差集：候选剔除 + 记账除名 + T1 物理清除（removeDocs）；T2 无清除原语时**如实报 unsupported** 并披露「服务端残留、读面已拦截」（runtime.mjs:2785）——诚实边界做得对
- 列表分页：遗忘条目游标语义正确（错位修复 BUG-006 保持），只有存在性披露
- working-set 的 verified 语义：verifyHash:false 时如实 `ok(unverified)`，不冒充验过（BUG-012 修复稳固）
- 展开页遗忘过滤：隐藏成员计数、占位渲染、页切片语义正确

## 未确认（下一轮优先）

1. 聚合凭证 digest 的重算覆盖面与伪造面（agg-voucher.mjs 未读——parseReceiptRecordIds 允许一凭多记，回执自述 recordId 与真实成员集的交叉校验是否存在）
2. 模型摘要模式的注入面（compressor-model.mjs 未读——模型产出进 receipt 时是否强制降级 verified/来源标注）
3. worker NDJSON 协议面（帧上限/畸形 JSON/伪造 observations 入 receipt）
4. forget undo 与层级压缩吸收的交互（undo 恢复可见性后，已被蒸馏进卡的原文如何对账）

## 验证

修复后全量：**57 套件 0 失败**（Windows x64 · Node 24.18 · 本机）。三态口径：无一处 skip 被计为 pass。
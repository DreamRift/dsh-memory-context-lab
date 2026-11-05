/**
 * 回读上限与回读分页语义的单一真源（contracts，零运行时依赖）。
 *
 * ## 为什么单独成文件
 * `/memory-lab read` 的截断上界在**命令面**（src/index.mjs），首次呈现的外置阈值在
 * **P7 候选**（domain/first-ingress）。此前两处各写一个 8000：
 * - 阈值 = 8000，read 上限 = 8000，且判定是「严格大于」——**凡是能被外置的正文，
 *   read 必然截断**。句柄承诺的「逐字可回读」从构造上就不成立；
 * - 两处各写一份数字，改一处就复发。
 *
 * 现在只有一个绝对数字（READBACK_MAX_CHARS），阈值由它派生；任何一处再写死上限
 * 都会让 v3-p7-first-ingress 的同源守卫红。
 *
 * ## 为什么留 1/4 余量
 * - 阈值判定用 `text.length`（UTF-16 单元）——这是**命令面**的尺（见下方 C-G1-09 裁决），
 *   记录正文是脱敏后的副本、可能比宿主原文更短/更长；
 * - 阈值必须**严格小于**上限，且留出可解释的余量：6000 字的正文回读 6000 字，
 *   不会因为一行「（已截断…）」提示或多一个码点就越界。
 */
export const READBACK_MAX_CHARS = 8000

/**
 * 首次呈现的外置阈值 = 上限的 75%（6000 字）。
 *
 * 只允许在这里派生：调用方（domain/first-ingress/preview.mjs）直接用这个符号，
 * 不得再写 8000/6000 字面量。
 */
export const FIRST_INGRESS_THRESHOLD_CHARS = Math.floor(READBACK_MAX_CHARS * 0.75)

/**
 * 偏移单位裁决（C-G1-09，0.15.0 G2 落地；本文件是唯一真源）。
 *
 * 旧状：同一份正文有三个尺子——
 * - `toolRead` / 摘录用**码点**（`[...text]`）；
 * - 命令面 `/memory-lab read` 用 **UTF-16 单元**（`text.length`）截 8000 且**不分页**；
 * - 本文件的注释又写「read 用 text.length 判截断」。
 * 三处口径不一致，模型按工具面拿到的 offset 去切命令面输出必然错位。
 *
 * 裁决（G0 冻结，G2 执行）：
 * 1. **工具面（memory_context_read / memory_context_search）一律码点**：offset、length、
 *    next_cursor 的位移单位都是 `code-point`，与 `EXCERPT_OFFSET_UNIT` / `SEARCH_OFFSET_UNIT` 同义。
 * 2. **命令面 `/memory-lab read` 保持现状：UTF-16 单元、8000 字符、不分页**——这是
 *    **有意的例外**，不是待修缺陷。命令结果会进会话日志、一次性呈现，扩展命令分页是
 *    另一个任务，本轮不重做命令体系。
 * 3. 因此**首次呈现之后的模型回读不得依赖命令面**：命令面既换了单位又不给续读游标。
 *    需要可验证分页的分页语义时，只能用工具面。
 */
export const READBACK_OFFSET_UNIT = 'code-point'

// 命令面的偏移单位是 UTF-16 code unit（`text.length`）——只是**注释**，不是本合同的常量：
// 本轮只钉工具面语义，命令面行为一行不改（扩展命令分页是另一个任务）。

/**
 * 读侧游标版本（C-M-04）。
 *
 * 旧读侧 `next_cursor` 是**裸十进制偏移**：不绑定对象、不绑定内容版本、不绑定单位、
 * 不绑定会话；非法值还被静默当成 0（`cursorOffsetOf` 的 `return 0`），于是
 * 「换个对象接着读」「内容已经变了还用旧游标」都会**读错而不是报错**。
 *
 * 新游标：`v1.<o|f>.<对象ID摘要>.<对象版本摘要>.<单位码>.<偏移36>.<会话摘要>.<校验和>`。
 * 绑定维度 = 版本 + 对象 ID + 对象内容版本 + 偏移单位 + 会话；逐项比对失败返回**具体错误码**
 * （不清零、不回第一页、不跳页）——与 G1 搜索游标（C-G1-05）同一套纪律与 `v1.*` 形态。
 * 形态/校验和的唯一实现是 `domain/readback/read-cursor.mjs`；本文件只放版本号常量。
 */
export const READBACK_CURSOR_VERSION = 1

/**
 * 单页偏移上界：超过它说明游标被改过或调用方在病态翻页，失败关闭（解析资源有界）。
 * 与搜索侧的 `SEARCH_PAGE_MAX_OFFSET` 同量级，但独立定义（两边可以各自演进）。
 */
export const READBACK_PAGE_MAX_OFFSET = 1000000

/**
 * G4 首次呈现外置（候选，**默认关闭**）的读合同条目（0.15.0，附在既有回读语义之后）。
 *
 * 本节只补「首次呈现之后模型该怎么读回来」这一条链的合同，**不改**上面任何一条既有语义：
 * READBACK_MAX_CHARS / FIRST_INGRESS_THRESHOLD_CHARS / READBACK_OFFSET_UNIT /
 * READBACK_CURSOR_VERSION / READBACK_PAGE_MAX_OFFSET 原样保留，命令面仍是不分页的例外。
 *
 * ## 为什么需要这一节
 * 旧首次呈现候选的句柄指向命令面 /memory-lab read：UTF-16 计数、单次上限、**不分页**。
 * 于是「正文被外置」与「模型读不回来」同时成立（G4 前 F04 / P7「回读能力」一节）。
 * G2 交付的 `memory_context_read` 才是可实际分页的面：offset/length/cursor 全部**码点**，
 * 单页上界与 READBACK_MAX_CHARS 同量级（本文件的 READBACK_OFFSET_UNIT 裁决）。G4 的外置回执
 * 因此只指向工具面，并如实写出命令面的例外。
 *
 * ## 两种哈希分别命名（不得互换）
 * - `surface-content-hash`：**宿主原始 content 块**的变更检测指纹（写入前取，用来拒绝覆盖
 *   已被别处改写的正文）；
 * - `record-text-hash`：**已落库副本正文**的变更检测指纹（正文可能已脱敏/已改写）。
 * 脱敏会改变字节，因此不要求脱敏正文匹配原文 hash；两项同时给出，读侧才知道自己在看哪个对象。
 *
 * ## 幂等 ID
 * 外置事实的身份是「来源事件 + 原文 hash + 策略版本 + 会话」的确定性派生值，形如
 * `fi-<16 位小写十六进制>`。同一组输入恒等 → 重试/重启后能按 ID 对账，不会反复替换或重复外置；
 * 它不是密码学摘要，不能当安全边界（与 shared/fnv1a64 同一条边界）。
 */
export const FIRST_INGRESS_POLICY_VERSION = 1

/** 幂等 ID 前缀（用法见上：确定性派生，不是凭据）。 */
export const FIRST_INGRESS_ID_PREFIX = 'fi-'

/** 两种哈希的**名字**是协议：回执、报告与对账都用这两个名字，不得互相顶替。 */
export const FIRST_INGRESS_HASH_KINDS = Object.freeze({
  surface: 'surface-content-hash',
  record: 'record-text-hash',
})

/**
 * 工具面单页上界（码点）。与 READBACK_MAX_CHARS 同源——工具面本来就是码点单位，
 * 回执里写的「单页最多 N 码点」必须等于读侧真正的一页，不能各写一份。
 */
export const FIRST_INGRESS_READ_PAGE_CHARS = READBACK_MAX_CHARS

/**
 * 首次呈现用例的结局封闭集（报告状态；持久层/表层/报告三者一致性的判定以它为准）。
 * - ok：本次确实外置并确认；
 * - rewritten-unconfirmed：已改写但确认失败（不得宣称原文仍在）；
 * - cancelled：取消，未改写；
 * - state-diverged：表层状态与任何已知形态都不符（不碰它，如实上报）；
 * - 其余为不动作的前提不足：disabled / no-watermark / pairing-unbalanced。
 */
export const FIRST_INGRESS_STATUSES = Object.freeze([
  'disabled',
  'no-watermark',
  'pairing-unbalanced',
  'ok',
  'rewritten-unconfirmed',
  'cancelled',
  'state-diverged',
])

/** 装配合同标识：入口只构造句柄、不激活（默认关闭），测试用它证明「可达但零激活」。 */
export const FIRST_INGRESS_ASSEMBLY_CONTRACT = 'v3-first-ingress-assembly/v1'


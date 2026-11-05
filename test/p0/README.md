# P0 证据与红色基线（独立于正常 CI）

本目录是 0.15.0 P0 的**测试域证据**：基线指纹、§7.2 缺陷复现夹具、宿主源码契约探针入口。
用途只有三个：

1. 为修复提供“改回去必红”的对照；
2. 证明缺陷可重复复现，而不是只存在于研究记录里；
3. 让 P0 的五类证据**一条命令可复算**，并把证据范围写在输出里。

**expect-red 成功只表示缺陷复现成功，不表示正确性通过。**
**源码契约探针通过也不表示真实宿主集成通过。**

## 现行基线（0.15.0，2026-11-01 重冻结）

唯一出处：`test/p0/baseline-freeze.mjs`（`BASELINE`）。当前值：

| 项 | 值 |
|---|---|
| commit | `ca1083a60f87765622ba0bf8089d70e1103cb8ba` |
| tree | `97d12b9a27dacac22837a780483254194d7c8d17` |
| manifest | `dsh-memory-context-lab` **0.14.0-beta.54** |
| src / test / scripts / package.json 指纹 | `55e7bcfff4764979` / `eefeceb50da19c40` / `28a88ba2d7f2f7c9` / `071f0ad812b391a5` |
| 全量 | 144 套 / 725 例 / 719 pass / 0 fail / 6 skip，exit 0（2026-11-01，node v26.12.1 / win32-x64） |
| 宿主 | DSH 0.2.1-rc.5，28 条源码契约 |

指纹算法：`sha256(sorted(relPath + NUL + LF-normalized blob + NUL))[:16]`，按**指定提交的 git blob** 计算（不读工作区脏文件）。
历史快照 `67e708c…` 仍可复算，但不再是默认值；历史证据见
[P0-基线证据](../../../docs/dev-0.15.0/P0-基线证据.md) §1/§4。

## 运行

在 `记忆上下文/plugin/` 下：

```powershell
# P0 门禁（单入口；五项证据 + 证据范围 + 非主张）
node test/p0/run-p0-gate.mjs
node test/p0/run-p0-gate.mjs --asar "<DSH>/resources/app.asar"
node test/p0/run-p0-gate.mjs --json > .tmp/p0-gate.json

# 有效红色基线（R01/R03：P5 范围，本阶段不修）
node test/p0/run-red-baseline.mjs --expect-red   # exit 0
node test/p0/run-red-baseline.mjs                # 契约门：exit 1

# 判定器自测（16 组 + SUPERSEDED 冻结比对 4 断言）
node test/p0/harness-selftest.mjs                # exit 0

# 基线指纹（省略 rev = 现行基线）
node test/p0/fingerprint-baseline.mjs [rev]
```

单件直跑（保留结构化报告）：

```powershell
$env:P0_MODE='baseline'; $env:P0_REPORT_PATH="$PWD/.tmp/r01-report.json"
node test/p0/r01-tail-window.test.mjs
```

## 期间会计：有效红 / 已转正 / 已超期

重冻结后发现：冻结时的五件并非都还红——R02/R04 已由 P1 修好，R08 的夹具复刻的是
**已被替换的调用方形态**。运行器因此分两张表（改在 `run-red-baseline.mjs`）：

| 表 | 件 | 判据 | 现状 |
|---|---|---|---|
| `FIXTURES`（有效红） | R01、R03 | 必须整件 EXPECTED_RED | 两件均红（P5 范围） |
| `SUPERSEDED`（已转正/已超期） | R02、R04、R08 | **逐 defect 与冻结口径精确比对** | 与冻结口径一致 |

- R02：`hits=GREEN / header=GREEN / lease=RED`。租约 RED 是**契约冲突**——新契约要求
  宿主 `session/event` 确认后才写租约，夹具直接调 `recallForInjection` 且不发宿主事件。
- R04：`retry.sameTurnInjects=GREEN`（读取暂败后同回合可重试）。
- R08：两个 defect 仍 RED，但只证明**旧形态**（锁外读快照 → 整数组 patch）仍会丢更新；
  生产 `markReadLease`/`pinRecords` 已改锁内 updater（`v3-entry.mjs` L530/L921），
  完成性证据在 `test/v3-session-state-updater.test.mjs` 与 `test/v3-recall-r02-r04.test.mjs`。

**口径一变 → `DRIFT`（exit 1）**：必须重新取证并更新 `baseline-freeze.mjs` 与
[P0-基线证据](../../../docs/dev-0.15.0/P0-基线证据.md)，**不得直接删件或放绿**。

## 判定规则（为什么不能看退出码）

node 断言失败、模块缺失、语法错误、子进程信号都可能是 exit 1；把任何非零都当
“预期红”会把环境崩溃伪装成缺陷复现。因此每个夹具通过 `P0_REPORT_PATH` 写结构化
JSON（schema `mcl-p0-fixture/1`），记录 control/defect 的声明与实际结果。

**期望集合外置**：每件的 control IDs 与 defect IDs 都写在运行器表里，不从报告自报的
`missingControls/failedControls` 取信。报告必须与外部期望**精确相等**。

**顶层状态自洽**：`status` 只允许 `HARNESS_ERROR / EXPECTED_RED / UNEXPECTED_GREEN / GREEN / RED`，
且必须与 checks 独立推导一致。`status=HARNESS_ERROR` **无条件失败**，不会因为 checks 里
恰好全是 RED 而回 EXPECTED_RED。

运行器只有同时满足以下条件才计 **EXPECTED_RED**：报告有效、checks 形状合法、
control/defect 集合精确相等且无重复、control 全 PASS、defect 全 RED、顶层 status 自洽、
退出码自洽。

任一不满足 → **HARNESS_ERROR**（exit 3）：缺文件、缺依赖、语法错、未捕获断言、
control 失败、报告缺失/损坏、身份不符、状态不自洽、信号终止、超时都走这条失败关闭路径。

## 为什么不接进 `scripts/test-all.mjs`

`test-all.mjs` 只扫描 `test/*.test.mjs` 顶层文件；本目录在子目录且**按设计包含失败断言**。
把它接进全量套件会让正常 CI 永远红，或迫使 CI 用“预期失败”把真实失败一起吞掉。
门禁的 `ci-isolation` 检查就是钉死这一点（聚合器与 npm 脚本都不得提及 P0 目录）。

## 退出码语义

- 单件：基线模式 0 = 全部约定 defect 为 RED；2 = 意外绿；3 = HARNESS_ERROR；
  契约模式 0 = 全 GREEN，1 = 未满足，3 = HARNESS_ERROR。
- `run-red-baseline.mjs`：0 = 有效红全部 EXPECTED_RED（--expect-red）或全 GREEN（契约门）
  **且** SUPERSEDED 冻结口径一致；1 = 契约未满足 / 冻结口径漂移；2 = 意外变绿；3 = HARNESS_ERROR。
- `harness-selftest.mjs`：0 = 判定器自测通过；1 = 判定器行为不符。
- `run-p0-gate.mjs`：0 = 全 PASS/SKIP；1 = 证据漂移；3 = HARNESS_ERROR。**SKIP 单独列出，绝不冒充 PASS。**

## 证据边界

- 全部为**合成夹具**与**源码文本探针**：不是真实宿主、不是真实模型、不是真实会话观测。
  宿主 surface 最终投影、落面失败的真实时序、跨进程 pin/租约竞争、供应商 wire JSON 均未覆盖。
- R01/R03 在 P0 **明确不修**（P5 范围）；R03 只断言“归一/名次分不得直接充当装包资格”，
  不把原始分阈值写成定案。
- R02 只覆盖本进程回注与 `state.json` 租约；R08 深入夹具（真并发/跨进程）按用户 2026-10-31
  指示转交存储实现者，P0 只保留旧形态对照。
- `run-p0-gate.mjs` 每次输出都会打印 `evidenceScope` 与 `nonClaims`；下游不得把门禁绿
  当成“真实宿主已验”或“可发布”。

# dsh-memory-context-lab

按 **DSH 会话** 启用的上下文管理插件：基础是**上下文降温**（把执行完的操作沉入隔离冷库、用极小回执替换），0.9.0 起扩展**全历史记忆上下文**（v2 模式）与**计划先行**。当前版本 **0.9.0-rc.5**，变化见 [CHANGELOG.md](CHANGELOG.md)。

> 适用对象：[DeepSeek Harness (DSH)](https://github.com/DeepSeek-ai/DeepSeek-Harness) 桌面端插件体系。

## 它做什么、不做什么

**做**：归档完成的操作；**保留最近 N 个操作一直生效**（更旧的攒够批量阈值就归档）；按相关度回注归档要点；随时恢复原文、清空本会话隔离数据；全历史模式下除必要历史外全部退热入隔离灵枢临时记忆。

**不做**：增删模型可见的工具（工具集一变就作废整段前缀缓存，省钱变赔钱）；改写 DSH 的 append-only 事件日志（归档走宿主表层替换，原始事件可恢复、可审计、可回放）。

## 缓存纪律

在位置 i 替换内容，会让 i 之后的一切按未命中价重算。插件据此**一批做够**（批次数才是代价来源）、**回注只落在批次尾部**（每条用户消息最多一次）、**工具集恒定**。

## 已核验范围

| 项目 | 值 |
|---|---|
| DSH Desktop | `0.2.0-rc.2` |
| 已核验的 `dsh-memory`（**可选**） | `0.8.1`；缺席时以独立模式运行（本地冷库 + 本地词法检索照常） |
| 冷库运行方式 | 每个启用会话一个独立 MCP Python 子进程 |
| 会话目录 | `$DSH_HOME/.memory-context-lab/sessions/<session-id 的 sha256 前 24 位>/` |
| 真实灵枢保护 | 启用期间按会话抑制 `dsh-memory` 的自动读写（不改动工具集） |
| 依赖的宿主接口 | `agent/pre-step`、`session.surface`、`session.append`、`session.requestHeader()`、`session.requestContext()`、`ctx.tokenMeter`、`ctx.llm.resolveModelInfo`、`ctx.sessionProjections`、`ctx.commands`；可选：`ctx.get('planMode')` 与共享 `plan` 投影（计划先行；缺失时走日志落账或如实降级） |

冷库不可用**不会阻止启用**：设置与状态照常工作，归档与回注在尝试时失败关闭；占用率缺 `requestHeader()` / `ctx.tokenMeter.measure` / `context.contextWindow` 时**失败关闭**，原因显示在 `status` / `dry-run`。

## 使用

本包内含两套引擎：**v1 命令面**（`/memory-lab on|off|status|set|preset|now|dry-run|restore|clean|protect|pin|unpin|help`）与 **v2 引擎**（`/memory-lab2`）。v1 与 v2 **互斥**（`EV1ACTIVE`/`EV2ACTIVE`），同一会话同一时刻只能由一个引擎持有模型可见投影。两个**插件级**开关（面板弹层有，命令面也能设）：

```text
/memory-lab2 set fullhistory on|off   全历史记忆上下文（仅 v2 引擎消费）
/memory-lab  set planfirst on|off     新会话计划先行（两引擎通用；/memory-lab2 set 同义）
```

### v2 引擎（全历史按需记忆化）

v2 是**独立引擎**（独立 schema、隔离目录与回执标记），固定只读工具 `memory_lab_recall`。v2 持有投影时 v1 `set` 报错指路 `/memory-lab2 set`。

```text
/memory-lab2 on | off                启用 / 停用（停用保留冷库，释放投影所有权）
/memory-lab2 restore                 恢复全部可恢复回执的原文，引擎保持启用（不停用）
/memory-lab2 status                  引擎状态、记录数、最近动作、成本账本
/memory-lab2 set auto|recall|batch|retain|fullhistory <值>   与 v1 同名同义，写入 v2 账本
/memory-lab2 now | dry-run           走一次「测量 → 门禁 → 提交 → 表层替换」；dry-run 零副作用
/memory-lab2 history [页]            分页列出冷库记录（稳定 ID）
/memory-lab2 read <记录ID…>          按稳定 ID 回读原文（支持 cursor 续读）
/memory-lab2 recall [预算] [查询]    按预算回读；query 走检索面
/memory-lab2 working-set | card [预算]   工作状态卡：保护集 / 丢弃项 / 溢出原因
/memory-lab2 index [status|sync] | relations <记录ID>   索引状态 / 启动隔离灵枢并同步 / 记录关系
/memory-lab2 import-v1               把本会话 v1 归档以指针级记录导入 v2（不复制正文）
/memory-lab2 fork <子会话ID> | fork-status | fork-reset <子会话ID>   迁移闭包 / 预览 / 清半成品
/memory-lab2 cost | help             成本账本 / 以上全部
```

**模型可见工具只有一个**：`memory_lab_recall`（`record_ids` / `query` / `budget_tokens` / `cursor`），只读；`budget_tokens` 非正整数返回结构化错误并明确「本次未执行」，超上限夹到上限并标注，**不静默换值**。

**检索走哪条路，如实说**：`query` 与自动回注共用一条多路检索，按三级梯队取用——**T0 内置字面索引**（记录 ID、种类、工具名、callId、seq 等元数据，恒在）；**T1 本地词法索引**（默认，纯 Node：CJK 二元组 + ASCII 词元倒排，无外部进程，词条上限 20 万、超限如实标注覆盖边界）；**T2 可选的隔离灵枢后端**（装有 dsh-memory 且 mcp_server 握手成功时由 `/memory-lab2 index sync` 启动；全历史模式下自动启动并随批次增量同步）。T2 不可用时**如实降级到 T1**并说明原因，绝不回退读正式灵枢根；三个后端都只返回记录 ID，正文一律回本会话冷库读。

### 全历史记忆上下文（v2 模式开关）

`/memory-lab2 set fullhistory on` 后，v2 切换为**全历史模式**：完整留下 system 头、**全部人类用户消息**（原位保留）、**退热凭证本身**（不可再退热）与计划工件；其余（助手文本与推理、工具操作、插件卡片与回注包）全部沉入隔离 ArchiveStore 并**自动启动**隔离灵枢后端、按批增量同步索引（插件来源不进索引、不被回注）。「保留最近操作」失效（面板变灰），留下与否由**活跃证据保护层**（v1/v2 共享）裁决——只判断证据能否安全退出模型可见投影，不判断语义还需不需要；软保留受 `set protect <预算>`（默认 32768）与 TTL 约束。凭证约每段 40–60 token、线性累积，代价如实计入成本账本。

### 计划先行（planfirst）

打开后，在**全新对话**第一条消息发出前自动进入 DSH 计划模式（服务可用走服务，否则落账 `plan/mode` 事件）：AI 先产出计划，**用户批准的瞬间自动启用 v1 降温**（免敲 `/memory-lab on`，有通知）。计划生成与评审期间降温/回注/工作状态卡注入全部挂起（手动命令仍可用）；**计划全文（`exit_plan_mode` 调用与结果）终生保留**，v1/v2 都不可退热，常驻上下文作指引。已有历史的会话不自动进入（提示 `/plan`）；缺投影时如实报错；中途手动 `/plan` 同样享受挂起规则。插件级默认在插件配置 `planFirst: true` 设置，可按会话覆盖。

**关闭即退出（0.9.0-rc.5）**：`set planfirst off`（命令或面板开关）会把本会话仍处 active/pending 的计划模式一并退出，输出如实报告；读不到状态时降级为提示手动 `/plan off`。

图形入口与设置：composer 工具行权限控件右侧的「降温」触发器（同一套设置与动作，含全历史/计划先行两个新开关）；开关后不再显示状态文字，**降温状态、全历史、计划先行三行摘要与最近一次命令输出**都显示在弹层底部输出框。全局默认与预设在 设置 → 组件 → 「记忆上下文」行。

**停用或归档都会把会话送回正常。** v2 会话里无论敲 `/memory-lab off`、`/memory-lab2 off` 还是面板拨关「启用降温」，都走 v2 停用路径（先恢复原文、再解除灵枢抑制、最后删隔离目录）；关「全历史」同样先恢复再翻位（0.9.0-rc.5）。恢复放不进模型窗口时如实拒绝（原文留冷库可回读，`clean confirm delete-session` 或先缩上下文）。仍有未恢复回执（含 restore 失败行）时不删，先 `/memory-lab2 restore` 重试或 `clean confirm delete-session` 明确丢弃。**只想恢复原文、不想停用**时用 `/memory-lab2 restore`（面板「恢复原文」按钮在 v2 会话自动改发它）。插件只清理 `$DSH_HOME/.memory-context-lab` 自有数据，**从不写真实灵枢**，也不改写 DSH 会话日志与命令审计。

### 单一触发线怎么算

「保留最近 N 个操作」一直生效，只受批量阈值约束（窗口外攒够 `batch` 个才提交一批；批量阈值是成本杠杆）；硬保护只有 system 指令节点与最新用户消息，防止归档到一半破坏配对完整性。

## 安全边界

- 归档前先把正文写进隔离冷库并**回读校验 hash**；写入失败、回读缺失/裁剪/hash 不符一律保留原文并报出具体阶段。正文超过单冷节点上限时**按码点分块**，每块独立校验，拼接后再校验整篇 hash。
- 回执文本只由稳定标识符构成，逐字节稳定，不扰动缓存；归档是表层替换，`restore` 按原字节写回、可逆。
- `clean` 在仍有未恢复回执时拒绝删除；冷库删除只能删本插件自有目录，且拒绝含链接的路径。

## 安装与卸载

从本仓安装（不用裸 `npm install` 装进 profile，让 pnpm 正确解析宿主提供的 peer 版本）：

```text
dsh plugin --profile <name> add <本仓目录>
卸载数据：删除 $DSH_HOME/.memory-context-lab/（或在每个会话执行 /memory-lab clean）
```

依赖：无必需 peer。可选增强：`dsh-memory`（peer `@furongjun1999/dsh-memory@0.8.1`，提供灵枢词法/结构检索与真实灵枢抑制）。未安装时以独立模式运行——本地冷库与词法检索照常；启用不会被阻止，真正的失败只在尝试时暴露。

## 验证

```text
npm test              # 26 套测试（维护版 6 套 + v2 全套 + plan-first / fullhistory），失败 0
npm run probe:host    # 用宿主真实 JSON Schema 校验器核验工具 schema（需 DSH_ASAR，无参数时 SKIP）
npm run probe:revert  # 20 个回退场景，确认对应测试确实会失败
```

**`npm test` 的第一项是 `entry-coverage`**：比对磁盘上的 `test/*.test.mjs` 与 `scripts.test` 链，防止「写了测试却没接线」。`FakeSession` 按宿主真实折叠规则实现校验，「整段区间替换成一条 user 回执」是被宿主契约验证过的替身，不是靠宽松替身通过。

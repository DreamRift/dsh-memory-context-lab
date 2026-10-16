# dsh-memory-context-lab

按 **DSH 会话** 启用的上下文管理插件：基础是**上下文降温**（把执行完的操作沉入隔离冷库、用极小回执替换），0.9.0 起扩展**全历史记忆上下文**（v2 模式）与**计划先行**。安装、会话命令、图形入口与清理卸载的唯一操作说明都在这里。

## 它做什么、不做什么

**做**：归档完成的操作；**保留最近 N 个操作一直生效**（更旧的攒够批量阈值就归档）；按相关度回注归档要点；随时恢复原文、清空本会话隔离数据。

**不做**：增删模型可见的工具（工具集一变就作废整段前缀缓存，省钱变赔钱）；改写 DSH 的 append-only 事件日志（归档走宿主表层替换，原始事件可恢复、可审计、可回放）。

## 缓存纪律

在位置 i 替换内容，会让 i 之后的一切按未命中价重算。插件据此**一批做够**（批次数才是代价来源）、**回注只落在批次尾部**（每条用户消息最多一次）、**工具集恒定**。完整说明见[架构与边界](../docs/架构与边界.md#前缀缓存纪律)。

## 已核验范围

| 项目 | 值 |
|---|---|
| DSH Desktop | `0.2.0-rc.2` |
| `dsh-memory`（**可选**） | `0.8.1`；缺席时独立模式运行 |
| 冷库 | 复合后端：灵枢子进程（T2）/ 本地 Node store（T1） |
| 会话目录 | `$DSH_HOME/.memory-context-lab/sessions/<session-id 的 sha256 前 24 位>/` |
| 真实灵枢保护 | 启用期间按会话抑制 `dsh-memory` 的自动读写（不改动工具集） |
| 依赖的宿主接口 | `agent/pre-step`、`session.surface`、`session.append`、`session.requestHeader()`、`session.requestContext()`、`ctx.tokenMeter`、`ctx.llm.resolveModelInfo`、`ctx.sessionProjections`、`ctx.commands`；可选：`ctx.get('planMode')` 与共享 `plan` 投影（计划先行，缺失时如实降级） |

冷库不可用不阻止启用（本地 T1 兜底）：归档/回注失败关闭；占用率缺 `requestHeader()` / `ctx.tokenMeter.measure` / `context.contextWindow` 时**失败关闭**，原因见 `status` / `dry-run`。

## 使用

**v1 命令面**（`/memory-lab on|off|status|set|preset|now|dry-run|restore|clean|protect|pin|unpin|help`）的语义归[旧版说明](../plugin-v1/README.md)。两引擎**共用一个包**（`plugin-v1/` 是旧独立打包线）。两个**插件级**新开关：

```text
/memory-lab2 set fullhistory on|off   全历史记忆上下文（仅 v2 引擎消费）
/memory-lab  set planfirst on|off     新会话计划先行（两引擎通用；/memory-lab2 set 同义）
```

### v2 引擎（全历史按需记忆化）

v2 是**独立引擎**（独立 schema、隔离目录与回执标记），与 v1 **互斥**（`EV1ACTIVE`/`EV2ACTIVE`）；用 `/memory-lab2`，固定只读工具 `memory_lab_recall`。

```text
/memory-lab2 on | off                启用 / 停用（停用保留冷库，释放投影所有权）
/memory-lab2 restore                 恢复全部可恢复回执的原文，引擎保持启用（不停用）
/memory-lab2 status                  引擎状态、记录数、最近动作、成本账本
/memory-lab2 set auto|recall|batch|retain|fullhistory <值>   与 v1 同名同义，写入 v2 账本
/memory-lab2 now | dry-run           走一次「测量→门禁→提交→替换」；dry-run 零副作用
/memory-lab2 history [页]            分页列出冷库记录（稳定 ID）
/memory-lab2 read <记录ID…>          按稳定 ID 回读原文（支持 cursor 续读）
/memory-lab2 verify <记录ID…>        验证跟踪：核对引用与归档时是否一致（valid/stale/unverified）
/memory-lab2 mark-stale <记录ID> <原因>   人工标记失效（只写旁证）
/memory-lab2 recall [预算] [查询]    按预算回读；query 走检索面
/memory-lab2 forget preview|apply|undo|status [目标…]   主动遗忘：可撤销；宽条件先 preview 后 apply
/memory-lab2 compress … · expand <ID>   层级压缩（默认关）；expand 只读；set compressmodel 开模型摘要
/memory-lab2 working-set | card [预算]   工作状态卡：保护集 / 丢弃项 / 溢出原因
/memory-lab2 index [status|sync] | relations <记录ID>   索引状态 / 灵枢同步 / 记录关系
/memory-lab2 import-v1               把本会话 v1 归档按指针导入 v2（不复制正文）
/memory-lab2 fork <子会话ID> | fork-status | fork-reset <子会话ID>   迁移闭包 / 预览 / 清半成品
/memory-lab2 cost | help             成本账本 / 以上全部
**模型可见工具只有一个**：`memory_lab_recall`（`record_ids` / `query` / `budget_tokens` / `cursor`），只读；`budget_tokens` 非正整数返回错误「本次未执行」，超上限夹到并标注，**不静默换值**。


**检索如实分级**：T0 字面索引（记录 ID、工具名、callId、seq 等）恒在；T1 本地词法索引；T2 可选隔离灵枢后端（`index sync` 或全历史模式自动启动）。T2 不可用时**如实降级到 T1**，绝不读正式灵枢根；冷库读写同理（T1 兜底）。详见[降温模式](../docs/降温模式.md)。

### 全历史记忆上下文（v2 模式开关）

`/memory-lab2 set fullhistory on` 后，v2 切换为**全历史模式**：完整留下 system 头、**全部人类用户消息**、**退热凭证本身**与计划工件；其余（助手文本与推理、工具操作、插件卡片与回注包）沉入隔离 ArchiveStore 并**自动启动**隔离灵枢后端、按批增量同步索引（插件来源不进索引、不被回注）。「保留最近操作」失效（面板变灰），去留由**活跃证据保护层**（与 v1 共享 `protection.mjs`）裁决——只判断证据能否安全退出模型可见投影；软保留受 `set protect <预算>`（默认 32768）与 TTL 约束。凭证约每段 40–60 token、线性累积，代价如实计入成本账本。

### 计划先行（planfirst）

打开后，在**全新对话**第一条消息发出前自动进入 DSH 计划模式（服务可用走服务，否则落账 `plan/mode` 事件）：AI 先产出计划，**用户批准的瞬间自动启用 v1 降温**（免敲 `/memory-lab on`）。计划期间降温/回注/工作状态卡注入挂起（手动命令仍可用）；**计划全文（`exit_plan_mode` 调用与结果）终生保留**，v1/v2 都不可退热。已有历史的会话不自动进入（提示 `/plan`）；缺投影时如实报错。插件级默认 `planFirst: true`，可按会话覆盖。

**关闭即退出（rc.5）**：`set planfirst off` 把本会话仍处 active/pending 的计划模式一并退出；读不到状态时降级提示 `/plan off`。

图形入口与设置：composer 工具行权限控件右侧的「降温」触发器（同一套设置与动作，含全历史/计划先行两个新开关）；**降温状态、全历史、计划先行三行摘要与最近一次命令输出**显示在弹层底部输出框。全局默认与预设在 设置 → 组件 → 「记忆上下文」行。

**停用或归档都会把会话送回正常。** v2 会话里无论 `/memory-lab off`、`/memory-lab2 off` 还是面板拨关「启用降温」，都走 v2 停用路径（先恢复原文、再解除灵枢抑制、最后删隔离目录）；关「全历史」同样先恢复再翻位。恢复放不进模型窗口时如实拒绝（原文留冷库可回读，`clean confirm delete-session` 或先缩上下文）。仍有未恢复回执时不删，先 `restore` 重试或明确丢弃。插件只清理 `$DSH_HOME/.memory-context-lab/` 自有数据，**从不写真实灵枢**，也不改写 DSH 会话日志与命令审计。

### 单一触发线怎么算

「保留最近 N 个操作」一直生效，只受批量阈值约束（窗口外攒够 `batch` 个才提交一批；批量阈值是成本杠杆，实测数字见[降温模式](../docs/降温模式.md#单一触发线保留数)）；硬保护只有 system 指令节点与最新用户消息。提交时按**相邻性**切成连续段（run）：受保护/不够格/冷写失败的单元会切段，回执的 N 可小于批量阈值，机制见[降温模式](../docs/降温模式.md#单一触发线保留数)。

## 安全边界

- 归档前先把正文写进隔离冷库并**回读校验 hash**；写入失败、回读缺失/裁剪/hash 不符一律保留原文并报出具体阶段。正文超过单冷节点上限时**按码点分块**，每块独立校验，拼接后再校验整篇 hash。
- 回执文本只由稳定标识符构成，逐字节稳定，不扰动缓存；归档是表层替换，`restore` 按原字节写回、可逆。
- `clean` 在仍有未恢复回执时拒绝删除；冷库删除只能删本插件自有目录，且拒绝含链接的路径。

## 安装与卸载

插件已作为 bundle 安装在 desktop profile。改动宿主侧源码后需要重启 DSH Desktop；只改 `src/client.js` 时刷新页面即可。

```text
卸载：plugin_manager remove_bundle dsh-memory-context-lab
清数据：删除 $DSH_HOME/.memory-context-lab/（或在每个会话执行 /memory-lab clean）
```

## 验证

```text
cd 记忆上下文/plugin && npm test              # 31 套（含 plan-first / fullhistory / 验证跟踪 / 后端指定），失败 0
cd 记忆上下文/plugin && npm run probe:host    # 用宿主真实 JSON Schema 校验器核验工具 schema（需 DSH_ASAR，无参数时 SKIP）
cd 记忆上下文/plugin && npm run probe:revert  # 20 个回退场景，确认对应测试确实会失败
```

**`npm test` 的第一项是 `entry-coverage`**：比对磁盘 `test/*.test.mjs` 与 `scripts.test` 链，防止「写了测试却没接线」。全套 31 套（v1 六套 + v2 全套 + 灵枢后端 + plan-first / fullhistory / reliability / 验证跟踪 / 独立运行三套）；逐套件范围与日期见[验证与评估](../docs/验证与评估.md#v2-测试覆盖2026-10-13)。

`FakeSession` 按宿主真实折叠规则实现校验，「整段区间替换成一条 user 回执」是被宿主契约验证过的替身——契约忠实度与逐套件范围的权威出处见[验证与评估](../docs/验证与评估.md)。

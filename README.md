# dsh-memory-context-lab

按 **DSH 会话**启用的上下文管理插件：基础是**上下文降温**（完成的操作沉入隔离冷库、用极小回执替换），0.9.0 起扩展**全历史记忆上下文**（v2）与**计划先行**。安装、命令、图形入口与卸载的唯一说明都在这里。

## 它做什么、不做什么

**做**：归档完成的操作；**保留最近 N 个操作一直生效**（更旧的攒够批量就归档）；按相关度回注要点；随时恢复原文、清空本会话数据。

**不做**：增删模型可见工具（一变就作废整段前缀缓存）；改写 DSH 的 append-only 日志（归档走表层替换，可恢复、可审计、可回放）。

## 缓存纪律

在位置 i 替换内容会让 i 之后按未命中价重算。插件据此**一批做够**、**回注只落批次尾部**（每条用户消息最多一次）、**工具集恒定**。见[架构设计](docs/architecture-design.md)。

## 已核验范围

| 项目 | 值 |
|---|---|
| DSH Desktop | `0.2.0-rc.2` |
| `dsh-memory`（**可选**） | `0.8.1`；缺席时独立模式运行 |
| 冷库 | 复合后端：灵枢子进程（T2）/ 本地 Node store（T1） |
| 会话目录 | `$DSH_HOME/.memory-context-lab/sessions/<sha256 前24位>/` |
| 真实灵枢保护 | 启用期间按会话抑制 `dsh-memory` 自动读写 |
| 依赖的宿主接口 | `agent/pre-step`、`session.surface`/`append`、`requestHeader()`、`tokenMeter`、`llm`、`sessionProjections`、`commands`；可选 `planMode`。见[架构设计](docs/architecture-design.md) |

冷库不可用不阻止启用（T1 兜底）：归档/回注失败关闭；占用率缺 `requestHeader()`/`measure`/`contextWindow` 时**失败关闭**。

## 使用

**v1 命令面**（`/memory-lab on|off|status|set|preset|now|dry-run|restore|clean|protect|pin|unpin|help`）的语义见旧独立打包线（`plugin-v1/`，不随本包分发）。两个**插件级**开关：

```text
/memory-lab2 set fullhistory on|off   全历史记忆上下文（仅 v2 引擎消费）
/memory-lab  set planfirst on|off     新会话计划先行（两引擎通用；/memory-lab2 set 同义）
```

### v2 引擎（全历史按需记忆化）

v2 是**独立引擎**（独立 schema、目录与回执标记），与 v1 **互斥**（`EV1ACTIVE`/`EV2ACTIVE`）；用 `/memory-lab2`，固定只读工具 `memory_lab_recall`。

```text
/memory-lab2 on | off                启用 / 停用（停用保留冷库，释放投影所有权）
/memory-lab2 restore                 恢复全部可恢复回执的原文（引擎保持启用）
/memory-lab2 status                  引擎状态、记录数、最近动作、成本账本
/memory-lab2 set auto|recall|batch|retain|fullhistory <值>   与 v1 同名同义，写入 v2 账本
/memory-lab2 now | dry-run           走一次「测量→门禁→提交→替换」；dry-run 零副作用
/memory-lab2 history [页]            分页列出冷库记录（稳定 ID）
/memory-lab2 read <记录ID…>          回读原文（精确 ID / 冷节点基名 / callId 均可；cursor 续读）
/memory-lab2 verify <记录ID…>        验证跟踪：valid/stale/unverified
/memory-lab2 mark-stale <记录ID> <原因>   人工标记失效（只写旁证）
/memory-lab2 recall [预算] [查询]    按预算回读；query 走检索面
/memory-lab2 forget preview|apply|undo|status   主动遗忘（可撤销；宽条件先 preview）
/memory-lab2 compress … · expand <ID>   层级压缩（默认关）；set compressmodel 开模型摘要
/memory-lab2 set sharel2content on|off  层级卡是否共享正文摘录（默认关）
/memory-lab2 working-set | card [预算]   工作状态卡：保护集 / 丢弃项 / 溢出原因
/memory-lab2 index [status|sync] | relations <记录ID>   索引状态 / 同步 / 记录关系
/memory-lab2 import-v1 · fork …       指针导入 v1 归档 / 迁移闭包（fork-status、fork-reset）
/memory-lab2 cost | help             成本账本 / 以上全部
```

**模型可见工具只有一个**：`memory_lab_recall`（`record_ids`/`query`/`budget_tokens`/`cursor`），只读；`budget_tokens` 非正整数直接报错「本次未执行」，**不静默换值**。

**检索如实分级**：T0 字面索引恒在；T1 本地词法；T2 可选隔离灵枢后端。T2 不可用时**如实降级到 T1**，绝不读**正式灵枢根**；冷库同理。见 [架构设计](docs/architecture-design.md)。

### 全历史记忆上下文（v2 模式开关）

`set fullhistory on` 后 v2 进**全历史模式**：留下 system 头、全部人类消息、退热凭证与计划工件；其余沉入隔离 ArchiveStore 并增量同步索引（插件来源不进索引、不被回注）。「保留最近操作」失效，去留由**活跃证据保护层**裁决。

### 计划先行（planfirst）

**全新对话**首条消息前自动进入 DSH 计划模式（服务可用走服务，否则落账 `plan/mode`）：AI 先出计划，**用户批准即自动启用 v1 降温**。计划期间降温/回注/工作卡挂起；**计划全文终生保留**。已有历史的会话不自动进入（提示 `/plan`）。

**关闭即退出（rc.5）**：`set planfirst off` 把本会话仍处 active/pending 的计划模式一并退出；读不到状态时降级提示 `/plan off`。

### 0.12.0：投影经济学与「归档—重读」循环修复

- **投影头**：回执/卡片声明 `投影：A 类｜释放 ≈N token / M 字｜取回 ≈K token`；失真只有 A 类。
- **取回动作可见**：回执末尾是可照抄的 `memory_lab_recall(record_ids=["mcl2-…"])`；工作卡「本步可回读」≤3 条、≤80 字符/条。
- **读取租约**：`set readlease <0..50>`（默认 3）让最近 N 个含读取的操作保留 M=2N 步，到期转「需复核」；是租约不是保护集扩张。
- **读取账本**：`read-ledger.json` 只记 `path|offset` 键不记正文；`status` 分开报口径 A/B 重读占比；损坏失败关闭。
- **回注包不再被折掉**：`recall` 移出折叠卡形态，成为断组边界。
- **卡片净占用上界**：按字符算（4000），最新工作卡永远保护，折叠回执保留全部成员 `seq:`。
- **其它**：回执加 `status`；回注须有结构事实；卡片降噪；检索口径文案如实。

**面板开关同步补丁（同日重打）**：权威状态记录改按引擎取账本，且只表态账本真的持有的开关位——修掉「v2 会话每写一条记录就把全历史/计划先行压回关」与「v2 停用后全历史显示开却点不动」。
### 0.11.0：脱敏、成员级排除、弱指针置信度与三个 P0

**卡片默认不复制正文**：摘录类值渲染成 `（正文摘录未共享）`，只留属性标签、来源 ID 与 `expand`；结构化属性（退出码、测试摘要、版本号）照常保留。`set sharel2content on` 才放摘录。

**成员级排除**：被遗忘者排除出参与集（不读正文、不进 L1/L2/`sourceRecordIds`/`leafIds`）。

**弱指针带置信度**：`weakPointer`/`isHit`/`confidence:{kind:'weak',…}`；exact 后验与强命中共源。

**两个会话日志 P0**：`user/message` 必带 `data.source`（写进 `opts` 会被丢弃）；`prune.shadowedSeqs` 按活动面位置切片取名单。

图形入口：composer 工具行右侧「降温」触发器（同一套设置与动作），弹层底部显示三行摘要与最近一次命令输出；全局默认在 设置 → 组件 → 「记忆上下文」。

**停用或归档都会把会话送回正常。** v2 会话的 `/memory-lab off`、`/memory-lab2 off` 或面板拨关都走 v2 停用路径（先恢复原文、再解除抑制、最后删隔离目录）；关「全历史」同样先恢复再翻位。恢复放不进窗口时如实拒绝；仍有未恢复回执时不删。插件只清理自有隔离数据，**从不写真实灵枢**。

### 单一触发线怎么算

「保留最近 N 个操作」一直生效，只受批量阈值约束（窗口外攒够 `batch` 个才提交一批）；硬保护只有 system 头与最新用户消息。提交按**相邻性**切连续段，受保护/不够格/冷写失败的单元会切段。

## 安全边界

- 归档前先把正文写进隔离冷库并**回读校验 hash**；失败、缺失、裁剪、hash 不符一律保留原文并报出阶段。超单节点上限时**按码点分块**，逐块校验后再校验整篇。
- 回执只由稳定标识符构成，逐字节稳定，不扰动缓存；归档是表层替换，`restore` 按原字节写回。
- `clean` 在仍有未恢复回执时拒绝删除；冷库删除只能删自有目录，且拒绝含链接的路径。
## 安装与卸载

从 [GitHub Releases](https://github.com/DreamRift/dsh-memory-context-lab/releases) 下载对应版本的 `dsh-memory-context-lab-<版本>.tgz`，执行 `dsh plugin add <tgz 绝对路径>`，随后重启 DSH Desktop。当前版本为 0.13.0（安装源用 npm 式版本规格时可用 git 标签，无需保留 tgz）。

插件已作为 bundle 装在 desktop profile。改宿主侧源码需重启 DSH Desktop；只改 `src/client.js` 刷新页面即可。
```text
卸载：plugin_manager remove_bundle dsh-memory-context-lab
清数据：删除 $DSH_HOME/.memory-context-lab/（或在每个会话执行 /memory-lab clean）
```

## 验证

```text
npm test              # 83 套 826 项，失败 0
npm run probe:host    # 用宿主真实 JSON Schema 校验器核验工具 schema（需 DSH_ASAR，无参数时 SKIP）
npm run probe:revert  # 28 个回退场景，确认对应测试确实会失败
```

**`npm test` 第一项是 `entry-coverage`**：比对磁盘 `test/*.test.mjs` 与 `scripts.test`，防止写了测试却没接线。全套 83 套（0.12.0 的 76 套 + 0.13.0 新增 7 套：恢复完整性 / 孤儿重建 / 压力闸门纯函数 / 压力闸门接线 / PTC 回读 / source.kind 契约 / 全量卡保护）；逐套件范围见工作区《验证与评估》（不随本包分发）。

`FakeSession` 按宿主真实折叠规则实现校验，「整段区间替换成一条 user 回执」是被宿主契约验证过的替身——契约忠实度与逐套件范围以 `npm test` 输出为准。

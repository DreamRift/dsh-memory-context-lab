# dsh-memory-context-lab

按 **DSH 会话** 启用的上下文管理插件：基础是**上下文降温**（把执行完的操作沉入隔离冷库、用极小回执替换），0.9.0 起扩展**全历史记忆上下文**（v2）与**计划先行**。安装、会话命令、图形入口与清理卸载的唯一操作说明都在这里。

> **当前源码版本 0.14.0-beta.2（测试版；热修 beta.1 首发卡死）**：v3 影子线（beta.2：摄入后台异步+索引去 O(N²)）——八层架构、上界回注、影子挂载（v2 零改动）；详见 CHANGELOG。功能。与 0.13.1 的可观察差异见[变更记录](./CHANGELOG.md)与[进展卡（beta.1）](../docs/dev-0.13.2/进展卡.md)、[进展卡（beta.2）](../docs/dev-0.13.2/进展卡-beta.2.md)、[进展卡（beta.3）](../docs/dev-0.13.2/进展卡-beta.3.md)、[进展卡（beta.4）](../docs/dev-0.13.2/进展卡-beta.4.md)、[进展卡（beta.5）](../docs/dev-0.13.2/进展卡-beta.5.md)。命令面**没有变化**；beta.3 起设置页的「全历史记忆上下文」与「保留最近操作」真正生效（此前是空开关）；beta.4 起设置页保存不再抹掉 schema 里其它字段，`/memory-lab set` 的数字参数不再被静默截断；beta.5 起 `set autorestore off` 真正「只停用不恢复」（窗口守卫照常生效），设置页数字框与 `history` 的每页条数不再静默改值。

## 它做什么、不做什么

**做**：归档完成的操作；**保留最近 N 个操作一直生效**（更旧的攒够批量阈值就归档）；按相关度回注归档要点；随时恢复原文、清空本会话隔离数据。

**不做**：增删模型可见的工具（工具集一变就作废整段前缀缓存，省钱变赔钱）；改写 DSH 的 append-only 事件日志（归档走宿主表层替换，原始事件可恢复、可审计、可回放）。

## 缓存纪律

在位置 i 替换内容，会让 i 之后一切按未命中价重算。插件据此**一批做够**（批次数才是代价来源）、**回注只落在批次尾部**、**工具集恒定**。见[架构与边界](../docs/架构与边界.md#前缀缓存纪律)。

## 已核验范围

| 项目 | 值 |
|---|---|
| DSH Desktop | `0.2.0-rc.2` |
| `dsh-memory`（**可选**） | `0.8.1` / `0.9.8` / `0.9.10`（三个版本都做过抑制补丁核验）；缺席或版本不在范围内时独立模式运行，**抑制不启用**并在 `on` 回执与 `status` 里如实说明 |
| 冷库 | 复合后端：灵枢子进程（T2）/ 本地 Node store（T1） |
| 会话目录 | `$DSH_HOME/.memory-context-lab/sessions/<session-id 的 sha256 前 24 位>/` |
| 真实灵枢保护 | 启用期间按会话抑制 `dsh-memory` 的自动读写（不改动工具集）；`status` 有独立一行「真实灵枢抑制：已启用 / 未启用（原因）」 |
| 依赖的宿主接口 | `agent/pre-step`、`session.surface`、`session.append`、`requestHeader()`、`requestContext()`、`tokenMeter`、`llm`、`sessionProjections`、`commands`；可选 `planMode`（缺失时如实降级）。详见[架构与边界](../docs/架构与边界.md) |

冷库不可用不阻止启用（T1 兜底）：归档/回注失败关闭；占用率缺 `requestHeader()` / `tokenMeter.measure` / `contextWindow` 时**失败关闭**，原因见 `status` / `dry-run`。

## 使用

**唯一命令是 `/memory-lab`**（0.13.1 起 v1 引擎与 `/memory-lab2` 已删除）。日常面：

```text
/memory-lab on | off          启用 / 停用（停用保留冷库，释放投影所有权）
/memory-lab status            引擎状态、记录数、最近动作、占用率、单批释放上限、成本账本
/memory-lab restore           恢复全部可恢复回执的原文，引擎保持启用（不停用）
/memory-lab now | dry-run     走一次「测量→门禁→提交→替换」；dry-run 零副作用
/memory-lab read <记录ID…>    回读原文（精确 ID / 冷节点基名 / callId 均可）
/memory-lab set <键> <值>     auto | recall | autorestore | batch | retain | readlease | pressure | protect |
                             fullhistory | compress | compressmodel | sharel2content | planfirst
/memory-lab card | cost       工作状态卡 / 成本账本（都是顶层子命令，没有 debug 分组）
/memory-lab recall <查询词> · verify | mark-stale | relations | history | working-set | index
/memory-lab forget preview|apply|undo|status · compress preview|run|status · expand <凭证ID>
/memory-lab fork <子会话ID> | fork-status | fork-reset <子会话ID>
/memory-lab clean confirm delete-session   丢弃本会话隔离冷库（不可撤销；须先 off）
/memory-lab help              本帮助（按「生命周期 / 回读检索 / 证据 / 遗忘 / 压缩 / 迁移 / 设置」分组）
```

模型可见的只读工具是 `memory_lab_recall(record_ids=[…])`——回执的「可回读」行直接给这个调用，照抄即可。

**0.13.1 不兼容**：`/memory-lab2` 已删除；旧会话目录 `sessions/<key>/state.json` 不再被读取
（不删不迁移）。已归档原文仍在磁盘，确认不需要后可手动删除 `$DSH_HOME/.memory-context-lab/sessions/`。

### 层级卡脱敏与成员级排除（0.11.0）

**卡片默认不复制正文**：摘录类值渲染成 `（正文摘录未共享）`，只留 entity、属性标签、极性/关系标签、来源 ID 与
`expand` 入口；结构化属性（退出码、测试摘要、版本号）照常保留。`set sharel2content on` 才放摘录（默认 off、失败关闭）。

**成员级排除**：一条成员被遗忘不再废掉整组——被遗忘者排除出参与集，其余照常压缩；全排除仍整组失败关闭。细节见[降温模式](../docs/降温模式.md)。

### 全历史记忆上下文（v2 模式开关）

`/memory-lab set fullhistory on` 后，插件切换为**全历史模式**：完整留下 system 头、**全部人类用户消息**、**退热凭证本身**与计划工件；其余沉入隔离 ArchiveStore 并自动启动隔离灵枢后端、按批增量同步索引（插件来源不进索引、不被回注）。「保留最近操作」失效（面板变灰），去留由**活跃证据保护层**（`protection.mjs`，与降温管线共用）裁决；软保留受 `set protect <预算>`（默认 32768）与 TTL 约束。

### 计划先行（planfirst）

打开后，**全新对话**第一条消息前自动进入 DSH 计划模式（服务可用走服务，否则落账 `plan/mode`）：AI 先产出计划，**用户批准的瞬间自动启用降温**（免敲 `/memory-lab on`）。计划期间降温/回注/工作状态卡挂起（手动命令仍可用）；**计划全文终生保留**，不可退热。已有历史的会话不自动进入（提示 `/plan`）；缺投影时如实报错。插件级默认 `planFirst: true`，可按会话覆盖。

**关闭即退出（rc.5）**：`set planfirst off` 同时退出本会话仍处 active/pending 的计划模式。

图形入口与设置：composer 权限控件右侧的「降温」触发器（同一套设置与动作）；**状态、全历史、计划先行三行摘要与最近一次输出**显示在弹层底部。全局默认与预设在 设置 → 组件 → 「记忆上下文」。

**停用或归档都会把会话送回正常。** `/memory-lab off` 或面板拨关都走停用路径（先恢复原文，再解除抑制、删隔离目录）；关「全历史」同样先恢复再翻位。恢复放不进窗口时如实拒绝（原文留冷库可回读）；仍有未恢复回执时不删。插件只清理 `$DSH_HOME/.memory-context-lab/` 自有数据，**从不写真实灵枢**，也不改写会话日志与命令审计。

### 单一触发线怎么算

「保留最近 N 个操作」一直生效，只受批量阈值约束（窗口外攒够 `batch` 个才提交一批）；硬保护只有 system 指令节点与最新用户消息。提交按**相邻性**切段：受保护/不够格/冷写失败的单元会切段，回执 N 可小于阈值。

## 安全边界

- 归档前正文写入隔离冷库并**回读校验 hash**；失败/缺失/hash 不符一律保留原文并报出阶段。超过单节点上限时**按码点分块**，每块校验后再校验整篇。
- 回执文本只由稳定标识符构成，逐字节稳定，不扰动缓存；归档是表层替换，`restore` 按原字节写回、可逆。
- `clean` 在仍有未恢复回执时拒绝删除；冷库删除只能删本插件自有目录，且拒绝含链接的路径。
- **并发与持久化**：第二个写句柄得 `ELOCKED`（15s 心跳 / 60s TTL / stale 接管，只读不取锁）；fsync 只覆盖原文、事务、manifest、engine 与 disposition，派生缓存只保证原子替换可重建。锁是互斥而非事务，跨文件读改写仍靠 revision CAS 与失败关闭。

## 安装与卸载

插件已作为 bundle 安装在 desktop profile；改宿主侧源码需重启 DSH，改 `src/client.js` 刷新页面即可。

```text
卸载：plugin_manager remove_bundle dsh-memory-context-lab
清数据：删除 $DSH_HOME/.memory-context-lab/（或在每个会话执行 /memory-lab clean）
```

## 验证

```text
cd 记忆上下文/plugin && npm run test:all      # 118 套逐套汇总（推荐）
cd 记忆上下文/plugin && npm test              # 与 test:all 同一批套件，失败即中断
cd 记忆上下文/plugin && npm run probe:host    # 宿主 schema 校验（需 DSH_ASAR；无参数 SKIP）
cd 记忆上下文/plugin && npm run probe:revert  # 66 个回退场景，确认对应测试会失败
cd 记忆上下文/plugin && npm run probe:lingshu # 隔离灵枢写入健康探测；不可用如实报环境原因
```

**`npm test` 第一项是 `entry-coverage`**：比对磁盘 `test/*.test.mjs` 与 `scripts.test` 链，防止「写了测试却没接线」。0.13.2-beta.7 全套 **118 套**（全通过、0 跳过；Node v26.12.1），逐套件范围见[验证与评估](../docs/验证与评估.md)。

> 沙箱宿主里 `%TEMP%` 可能不可写（`mkdtemp` 报 `EPERM`）：环境限制，非缺陷；把 `TEMP`/`TMP`/`TMPDIR` 指到可写目录。
`FakeSession` 按宿主真实折叠规则实现校验；契约忠实度见[验证与评估](../docs/验证与评估.md)。
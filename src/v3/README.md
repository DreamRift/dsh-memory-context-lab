<!-- release mirror: 与 plugin/src/v3/README.md 同文；仅此标记用于区分镜像与源文档。 -->
# v3 源码目录（0.14.0 线）

按《开发计划-v3》§2 建立的模块化单体，**0.14.0-beta.10 起是插件的唯一引擎**：
v2 的引擎、数据根读取、设置面与客户端面均已删除（其口径留在 `docs/历史归档/v2机制文档/`，
**不是**现行依赖，也不再作为反例库被 import）。数据根独立：`$DSH_HOME/.memory-context-lab/v3/`，
不读 v1/v2 数据、不迁移。

## 依赖方向（由 test/v3-architecture-guard.test.mjs 守卫）

```
host-adapter(adapters/host) -> application -> domain
                                  -> ports <- adapters(storage/retrieval)
index.mjs（插件入口：Config/命令/回注钩子）→ composition/composition.mjs（唯一 composition root）
```

| 层 | 可依赖 | 禁止 |
|---|---|---|
| `contracts/` | 同层、`../shared` | 一切运行时依赖（node:fs/os/child_process、裸包名） |
| `domain/*/` | 同域、其他 domain、`../contracts`、`../shared` | node 内置 fs/os/child_process/crypto、裸包名（DSH/MCP/npm）、ports、adapters、application、projection、observability |
| `ports/` | `../contracts`、`../shared` | domain、adapters、node:fs |
| `application/` | domain、ports、contracts、shared | adapters、直接宿主对象 |
| `adapters/*` | 上述全部 | 互相绕过 ports 读内部状态 |

时间、随机数、文件系统、宿主事件一律经 ports 注入（计划 §2.7）；domain 保持纯函数。

## 设置面

宿主 `dsh-settings` 用 `entry.fiber.runtime.Config` 生成「设置 → 组件」页，且只渲染 `meta.volatile` 字段；
volatile 字段解析成引用包装（`Symbol.for('cosmokit.volatile.write')`），`index.mjs` 的 `readSettings()` 每次解包。
当前五个字段：`enabled` / `limit` / `packMinScore` / `previewChars` / `queryMaxChars`——**每个都必须有消费者**，
否则设置页就成了「能改但不生效」的假控件。

## 数据根

v3 只使用 `<DSH_HOME>/.memory-context-lab/v3/`；clean 只处理 v3 自有目录（计划 §2.6）。

## 模块清单（随实施更新）

- `contracts/errors.mjs`：错误信封 kind/code/message/text 的单一真源。
- `ports/index.mjs`：HostSurface / SessionStore / MemoryProvider / Clock / Random / Metrics 的方法面定义。
- `contracts/outcomes.mjs`：投影结果合同（applied/partial/failed；「失败伪装已完成」「瞒报失败」在结构层非法）。
- `test/v3-property.test.mjs`：property/fuzz 层（种子确定可重放：P1 逐字节回读×200 / P2 预算上界×300 / P3 pack⊆display×200 / P4 损坏双语义×50）。
- `adapters/retrieval/backend-negotiation.mjs`：记忆后端协商（探测注入；D3 失败关闭回 T1；决策记录随 provider 返回——报实际生效不是期望）。
- `entry/v3-entry.mjs`：引擎挂载（attachV3Engine：pre-step 增量摄入、批量事务、断点续传、阈值/装包参数透传、失败只告警、dispose 注销）；回注取数（`recallForInjection`，判别式 status + 按会话计数）由入口钩子调用，**追加消息在入口完成**。
- `composition/composition.mjs`：composition root（唯一看全层的装配点；`handleDshEvent` / `handleDshEventBatch` 归一化与 own-source 裁决；Date.now/randomUUID 只出现在这里）。
- `adapters/host/dsh-host.mjs`：DSH 宿主适配器（surfaceOp 逐字对齐真实契约：append+surfaceOp{replace,startSeq,endSeq}+sourceEventSeqs；确认面 eventAt/surface.nodes；P1 source.kind 自有；normalizeDshEvent 四类映射）。
- `application/surface-executor.mjs`：投影执行（R4：replace 被拒→降级 append+cardReplaceFallbacks+一步恢复；宿主确认必须带 seq；新卡未落面不推进状态）。
- `adapters/retrieval/t1-provider.mjs`：T1 检索提供者（BM25；查询词元去重；覆盖门槛按不同词元并设上限；索引按文件戳缓存、损坏即重建、`allowRebuild:false` 供热路径；read 顶层 text 恒非空；capabilities 报实际生效后端）。
- `application/recall.mjs`：recall 用例（纯壳不注入；首部切片按码点；P3 同回合一次；OOV 去重有界；超硬顶拒绝注入；单条命中读取失败不废整包；回读句柄是真实命令 `/memory-lab read`）。
- `projection/card-renderer.mjs`：工作卡渲染（allocateBudget 接入；页脚保留量先扣再用；严格上界含页脚；丢弃可见）。
- `domain/context/slot-planner.mjs`：双槽规划（Q3-A/B：注入即替换/稳态双槽/占位回执；gateRecallInjection P3 回注闸；决策归 domain，渲染在 projection）。
- `application/session-lifecycle.mjs`：enable/disable/restore/forget 用例（Q-01 三结局回执；G3 unknown 守卫；N-11 会计；forget 幂等+隐私面）。
- `application/process-turn.mjs`：processTurn 用例（顺序固化：归一化→裁决→持久化→投影→计量；`processTurn.many` 让一批事件共用一笔事务，失败整批 failed 且回合号回滚；装配期端口校验 + random 探针）。
- `adapters/storage/session-store-port.mjs`：SessionStore 端口装配（assertPort + 锁内事务 + 遗忘不入索引 + 恢复资格 N-11b）。
- `contracts/index.mjs`：contracts 聚合出口（只转发不定义）。
- `adapters/storage/lexical-index.mjs`：可重建词法索引（倒排 tf；tokenizeQuery 同尺；损坏 ESTORE_CORRUPT 不静默；缺失 null 可重建；stale 判定）。
- `adapters/storage/write-lock.mjs`：跨进程写锁（两阶段创建 / token 心投校验 / stale 墓碑接管 / deadline 内 ELOCKED；withWriteLock 同进程串行+重入，队列排空自清理）。
- `adapters/storage/session-store.mjs`：M2 会话存储（原子写 randomUUID 临时名 + **fsync**；事务协议 payload→commit 行→txnNext；崩溃对账：残留隔离/号不复用/推进对账/尾损坏判 damaged 读允许写拒绝且字节不动；账本各自损坏时**按账本**拒绝追加；记录读写校验会话归属；遗忘集合读前按文件戳刷新；close 后 ESTORE_CLOSED）。
- `domain/retrieval/query.mjs`：查询规范化（CJK 单字+相邻双字、ASCII 小写）/ 双面 min_score 门槛 / 确定性排序。
- `domain/context/budget.mjs`：投影预算器（structural 无条件保留 + 超预算如实标注；protected 次优；soft 丢最旧保最新；无生产类目可见摘除；非法预算 fail-fast）。
- `domain/archive/restore.mjs`：恢复资格（逐字节重建）/ 停用动作（Q-01 正交 + G3 unknown fail-closed）/ 会计结算（N-11 三桶恒等）。
- `domain/session/turn.mjs`：回合判定（真实用户=非插件来源的 user 事件；turn 0 禁止注入；oncePerTurnGate 同回合同类只放行一次）。
- `contracts/events.mjs`：归一化事件合同（四类型封闭集；保留宿主原始 event id/source）。
- `contracts/decisions.mjs`：裁决合同（五 kind / 三 effect 封闭集；basis 必填；sealDecision 深冻结）。
- `shared/deep-freeze.mjs`：深冻结原语（shared 层首个模块）。
- `contracts/records.mjs`：记录合同（封闭字段集 / kind 封闭集 / bytes 必须等于 UTF-8 字节长度——v2「按字符数算 size」教训锁死）。
- `contracts/capabilities.mjs`：T1/T2 能力协商（D3：未知版本 fail-closed 回 T1；直连要求 memory_*，隔离路线要求 cg + isolated=true；0.9.10 真实冒烟后登记）。
- `adapters/host/t2-environment.mjs`：定位 dsh-memory 包根与 Python（`MEMORY_LAB_T2_REPO` / `MEMORY_LAB_T2_PYTHON` / `MEMORY_LAB_T2=0`）；找不到按 T1。
- `adapters/retrieval/t2-mcp-client.mjs`：隔离 MCP 逐行 JSON-RPC（initialize/tools/list/tools/call/shutdown；超时/退出/协议错误失败关闭；`spawnImpl` 可注入）。
- `adapters/retrieval/t2-token.mjs`：隔离根内独立令牌库（不读写 `~/.mdcg/_tokens.json`；明文 0600）。
- `adapters/retrieval/t2-probe.mjs`：四步冒烟（initialize / tools/list / 写六要素 / 读回 / forget），成功交回已握手 client。
- `adapters/retrieval/t2-isolated-provider.mjs`：T1 + 隔离灵枢复合 provider（融合检索、镜像队列、遗忘同步、诊断计数）。
- `contracts/sources.mjs`：消息来源标识单一真源（`PLUGIN_SOURCE_KIND` = 包名，守卫钉住；`HUMAN_SOURCE_KIND` = 'user'）。
- `domain/session/user-input.mjs`：从 pre-step 的 `payload.messages` 取人类输入（只认 `source.kind==='user'`，不用「排除已知污染源」的启发式）。
- `domain/session/isolation-key.mjs`：会话隔离键归一（M1 首个纯函数）。

/**
 * memory-context-lab 浏览器半（0.14.0-beta.13 新增）。
 *
 * ## 为什么必须有这个文件（0.14.0-beta.12「有 Config 还是没有设置页」的根因）
 *
 * beta.12 的结论是「导出 `Config` 就有设置页」。宿主源码核验（app.asar 内
 * `@deepseek-ai/dsh-settings/lib/index.js` 的 `describe()`）证明那句话只对了一半：
 *
 * - `describe()` 只认 `entry.fiber.runtime.Config`（且要求 `toJSON`），**它产出的是
 *   `settings.describe` 的数据行（ns / revision / schema / value / base / user），
 *   不是页面**。没有 Config 时 `volatileForm()` 返回 undefined，命名空间整行缺席；
 *   有 Config 只是让这一行**存在**。
 * - 设置页本身由 `@deepseek-ai/dsh-client-ui-plugin-manager` 渲染，它只认三个
 *   **槽位注册**（同一份 README「Configuration pages」节）：
 *   `plugins.item`（官方插件，列在「内置插件设置」）、
 *   `plugins.bundle.config`（按**包名**键控，渲染在 bundle 详情页说明与组件行之间）、
 *   `plugins.row.config`（按 `<包名>#<行 id>` 键控，给该行一个「配置」入口）。
 *   没有任何槽位注册 = 页面上没有任何设置界面，**与 Config 是否存在无关**。
 * - 于是「配置页」= 客户端半（本文件）+ 宿主半的 Config，两件缺一不可。
 *
 * beta.11 删客户端面时删掉的是**文件**，却保留/连带移除了**声明**；beta.11 的 P0-A
 * 只证明「声明在、文件不在 → 装配期抛 ClientPackageCompositionError」，
 * 推不出「声明该删」。正确修复是补齐文件——本文件。
 *
 * ## 本文件必须遵守的宿主契约（2026-10-27 对 app.asar 源码核验）
 *
 * 1. **自注册格式**：`window.__ModuleLoader__.load({ id, factory })`，`id` 必须等于
 *    **包名**（`dsh-client-modules` 用包名作浏览器模块标识；`<id>/client` 与裸 id 同解）。
 * 2. **可被 require 的只有平台基线表**（`dsh-web-frontend` 种子表实测：
 *    `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` /
 *    `@deepseek-ai/cordis` / `zod` / `@tanstack/react-virtual` /
 *    `@deepseek-ai/dsh-client-store` / `@deepseek-ai/dsh-client-ui-slots` /
 *    `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-dockkit`）。
 *    本文件只用其中两个；**不能用相对路径 require**（entry 与 chunk 不允许同步 require
 *    另一个相对 client*.js 输出），所以本文件是自足的，常量在宿主半与这里各有一份，
 *    由 `test/v3-client-surface.test.mjs` 钉住一致性。
 * 3. **表单来源只有两条**：
 *    - 页面给 `form`（`plugins.row.config` 的详情页在命名空间已服务时传
 *      `{state, mutate}`）；
 *    - 页面不给（`plugins.bundle.config` 只传 `view`）时自己从 `configForms`
 *      服务取 `ConfigFormController`（`getSnapshot` / `subscribe` / `mutate`）。
 *    两条都只写这一个组件，避免两份表单漂移。
 * 4. **不 dispose 共享 form**：`configForms.get(ns)` 是提供方缓存并拥有的对象，
 *    提供方在自身卸载时统一 dispose。这里 dispose 会把缓存里的实例标记为已废，
 *    同一页面里插件行「关掉再打开」就再也读不到配置（静默变成 loading）。
 *
 * Python/Node 侧不可加载：本文件顶层就会碰 `window`，`import` 它必然抛错；
 * 它只由宿主当作构建产物原样服务给浏览器（`exports["./client"]`）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-context-lab',
  factory: (require) => {
    const React = require('react')
    const { Button, Switch } = require('@deepseek-ai/dsh-client-ui-primitives')

    /** 宿主设置命名空间 = `cordis.patch.yml` 里这条 insert 的 id（`dsh-settings.describe()` 的 ns）。 */
    const NS = 'memory-context-lab'
    /** 客户端模块 id = 包名（`dsh-client-modules` 的判据）。 */
    const BUNDLE = 'dsh-memory-context-lab'
    /** 行配置键 = `<包名>#<行 id>`；行 id 就是那条 insert 的 id。 */
    const ROW_KEY = BUNDLE + '#' + NS
    /** 本页面自己的字典命名空间。 */
    const LOCALE_NS = 'memory-context-lab'
    /**
     * composer 面板（0.14.0-beta.16，恢复 v1/v2 的「chip + 弹层」形态）。
     *
     * 槽位契约（宿主 `dsh-cordis-client-runner` 的 CLIENT_SLOT_API 目录，2026-10-27 核验）：
     * `conversation.input.left` 是 list / scope=session，注册项必填 `id`；它渲染在
     * composer 工具行左侧（紧邻权限控件），**hero 与 composer 两种变体都存在**——
     * 旧的 `conversation.composer.dock` 只在 composer 变体渲染，新对话里点不到。
     * 必须用 `ctx.slots.inject` 等槽位声明出现；id 用自己的，避免替换宿主条目。
     */
    const CHIP_SLOT = 'conversation.input.left'
    const CHIP_ID = 'memory-context-lab'
    const CHIP_ORDER = 20
    /** 宿主半 status-projection.mjs 的 key（两侧各一份，由测试交叉核对；客户端不能相对 import 宿主模块）。 */
    const PROJECTION_KEY = 'memoryContextLabStatus'

    /**
     * 设置面。**顺序即页面顺序**；`min`/`max`/`step` 必须与宿主半 `Config` 的 schema
     * 一致（`test/v3-client-surface.test.mjs` 对 `src/index.mjs` 的 Config 做交叉核对），
     * 否则客户端先放行、宿主再拒绝，用户只会看到「保存失败」。
     */
    const FIELDS = [
      { key: 'enabled', kind: 'boolean', label: 'enabledLabel', hint: 'enabledHint' },
      { key: 'fullHistory', kind: 'boolean', label: 'fullHistoryLabel', hint: 'fullHistoryHint' },
      // 轮次判定（0.14.0-beta.47）：两个值用下拉框而不是开关——开关的「开/关」说不出
      // 哪一边是默认，用户无法从界面判断切换后压得更快还是更慢。
      {
        key: 'turnBasis',
        kind: 'string',
        options: [{ value: 'human', label: 'turnBasisHuman' }, { value: 'dsh', label: 'turnBasisDsh' }],
        label: 'turnBasisLabel',
        hint: 'turnBasisHint',
      },
      { key: 'planFirst', kind: 'boolean', label: 'planFirstLabel', hint: 'planFirstHint' },
      { key: 'autoRestore', kind: 'boolean', label: 'autoRestoreLabel', hint: 'autoRestoreHint' },
      { key: 'limit', kind: 'number', min: 1, max: 20, step: 1, label: 'limitLabel', hint: 'limitHint' },
      { key: 'coolingGate', kind: 'number', min: 0, max: 95, step: 1, label: 'coolingGateLabel', hint: 'coolingGateHint' },
      { key: 'restoreMaxChars', kind: 'number', min: 1000, max: 200000, step: 100, label: 'restoreMaxCharsLabel', hint: 'restoreMaxCharsHint' },
      { key: 'packMinScore', kind: 'number', min: 0, max: 50, step: 0.1, label: 'packMinScoreLabel', hint: 'packMinScoreHint' },
      { key: 'previewChars', kind: 'number', min: 40, max: 4000, step: 10, label: 'previewCharsLabel', hint: 'previewCharsHint' },
      { key: 'queryMaxChars', kind: 'number', min: 32, max: 4000, step: 16, label: 'queryMaxCharsLabel', hint: 'queryMaxCharsHint' },
    ]

    /** 与宿主半 `SETTINGS_DEFAULTS` 同值：只用于「宿主还没答」时的占位显示，不参与写。 */
    const DEFAULTS = { enabled: true, fullHistory: true, turnBasis: 'human', planFirst: false, autoRestore: true, limit: 10, coolingGate: 20, restoreMaxChars: 16000, packMinScore: 0.5, previewChars: 160, queryMaxChars: 512 }

    /** 会话弹层可覆盖的数值项（全局默认在插件设置页；这里只写本对话）。 */
    /**
     * 会话弹层可覆盖的数值项（全局默认在插件设置页；这里只写本对话）。
     * gate 只在「按步归档」下显示——它是该模式独有的闸门，别的模式显示只会误导。
     */
    const SESSION_OVERRIDE_FIELDS = [
      ...FIELDS.filter((field) => field.key === 'limit'),
      { key: 'gate', kind: 'number', min: 0, max: 95, step: 1, label: 'gateLabel', hint: 'gateHint', onlyWhen: 'cooling' },
    ]

    const zh = {
      summary: '回注设置：开关、条数、装包阈值、首部长度、查询上限',
      title: '记忆上下文',
      description: '控制命中历史时往本步上下文追加多少内容。改动即时生效，无需重启。',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      saveFailed: '宿主没有接受这次修改，已保留你填的值供修改。',
      reset: '恢复默认',
      resetDone: '已恢复默认值',
      loading: '正在读取设置…',
      unavailable: '该插件当前未加载，暂时无法配置。',
      readOnly: '本部署的设置为只读。',
      invalid: '请填 {min}–{max} 之间的数字，留空表示恢复默认值。',
      enabledLabel: '默认回注开关',
      enabledHint: '新会话的默认。命中历史时把要点追加到本步上下文；本对话可在 composer 面板单独关闭。',
      fullHistoryLabel: '默认全历史模式',
      fullHistoryHint: '新会话默认把已完成历史归档成可恢复回执；关闭后改用压力闸门驱动的普通降温。',
      turnBasisLabel: '按轮归档的轮次判定',
      turnBasisHint: '真人消息：只有你发新消息才算下一轮（默认，压得慢）。DSH 轮次：按界面「N 轮」计数，目标自动继续的每一轮都算，压得更快；被压的原话仍可按 ID 恢复。',
      turnBasisHuman: '真人消息（默认）',
      turnBasisDsh: 'DSH 轮次',
      invalidChoice: '请选择下拉框里的选项。',
      planFirstLabel: '计划先行默认',
      planFirstHint: '计划期间暂停归档与自动回注，计划工件受保护。',
      autoRestoreLabel: '停用/恢复时还原原文',
      autoRestoreHint: '关闭后只保留回执，不自动把原文写回活动面。',
      limitLabel: '默认单次回注条数',
      coolingGateLabel: '按步归档闸门（占用 %）',
      coolingGateHint: '上下文占用达到该百分比才压缩旧步骤；0 = 每步都判断（最省 token、最费前缀缓存）。',
      restoreMaxCharsLabel: '恢复正文上限（字符）',
      restoreMaxCharsHint: '恢复体积（正文+工具调用参数）超过它的完成回合不会写恢复凭证；1000–200000。',
      gateLabel: '按步归档闸门',
      gateHint: '本对话的闸门百分比（跟随全局 = 留空）；0 = 每步都判断。',
      limitHint: '新会话默认；本对话可在 composer 面板覆盖（1–20）。',
      packMinScoreLabel: '装包阈值',
      packMinScoreHint: '低于此相关度的命中不进回注包（0 表示不过滤）。',
      previewCharsLabel: '单条首部字符数',
      previewCharsHint: '每条命中在回注包里保留多少个首部字符（40–4000）。',
      queryMaxCharsLabel: '查询词上限',
      queryMaxCharsHint: '查询词只取人类消息的前 N 个字符（32–4000）；整条长消息会把检索拖成「必须命中整句」。',
      chipLabel: '记忆上下文',
      chipLabelCount: '记忆上下文 · {count}',
      chipLabelCoverage: '记忆上下文 · {count} 可检索',
      chipAria: '记忆上下文面板',
      chipTitle: '打开记忆上下文面板（摄入 / 回注 / 设置）',
      panelTitle: '记忆上下文',
      panelNoSessions: '当前没有可选择的会话',
      panelSession: '会话',
      panelStatus: '状态',
      panelCompact: '压缩摘要',
      panelHistory: '历史',
      panelExport: '导出',
      panelSettings: '回注设置',
      panelNoSettings: '设置服务未就绪，暂时只能查看状态；可到插件设置页修改。',
      panelHint: '改动即时生效。完整观测：/memory-lab status。',
      statusReady: '已摄入 {ingested} · 可检索 {searchable} · 回注 {injected}',
      statusReadyNoSearchable: '已摄入 {ingested} · 可检索 未知 · 回注 {injected}',
      statusSearchableOnly: '可检索 {searchable} · 回注 {injected}',
      statusReadyUnknownCount: '已摄入 状态未知 · 回注 {injected} 次',
      statusLast: '上次结局：{status}',
      statusAttempted: '尝试 {attempted} 次 · 跳过 {skipped} · 失败 {failed}',
      statusIngesting: '摄入中…',
      statusPending: '正在建立影子库…',
      statusAbsent: '本会话尚未摄入（发出任意一条消息后开始）',
      hostPlanOn: '宿主计划模式：开（用「计划」按钮或 /plan off 退出；插件的「计划先行」只暂停归档与回注，两者不是同一个开关）',
      statusFailed: '建库失败（{code}）',
      statusUnknown: '状态未知',
      statusMode: '模式：{mode}',
      statusPlanFirst: '计划先行：开',
      statusArchived: '已归档到 seq {seq}',
statusArchivedAt: '已按步归档（{time}）',
statusStateError: '状态文件异常：{code}（值已按默认回落）',
      modeFullHistory: '按轮归档',
      modeCooling: '按步归档',
      modeRecallOnly: '仅回注',
      forkMemory: '分叉记忆',
      forkAction: 'fork 到新会话',
      forkBusy: '正在 fork…',
      forkDone: '已 fork；子会话会从自己的日志重建记忆',
      sessionControls: '本对话控制',
      sessionEnable: '本对话启用',
      sessionRecall: '自动回注',
      sessionPlanFirst: '计划先行',
      sessionMode: '模式',
      modeWarning: '切换只改变之后的归档时机，不会撤销已归档内容；需要还原旧回执时再用 /memory-lab restore all。',
      modeConfirm: '确认切换',
      modeCancel: '取消',
      approvePlan: '批准计划',
      overridePlaceholder: '跟随全局',
      remoteUnavailable: '命令通道不可用，无法修改本对话控制。',
      commandFailed: '命令失败：{message}',
      commandDone: '已更新',
    }

    const en = {
      summary: 'Recall settings: switch, count, pack threshold, preview length, query cap',
      title: 'Memory context',
      description: 'How much matched history is appended to the current step. Changes apply live; no restart.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      saveFailed: 'The host refused these values; they were kept for you to correct.',
      reset: 'Reset to default',
      resetDone: 'Reset to the default value',
      loading: 'Reading settings…',
      unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
      readOnly: 'This deployment stores settings read-only.',
      invalid: 'Enter a number between {min} and {max}; leave it blank to use the default.',
      enabledLabel: 'Default recall switch',
      enabledHint: 'Default for new chats. This chat can override it in the composer panel; turning it off stops recall only.',
      fullHistoryLabel: 'Default full-history mode',
      fullHistoryHint: 'New chats archive completed history into restorable receipts; off switches to pressure-gated cooling.',
      turnBasisLabel: 'Full-history turn basis',
      turnBasisHint: 'Human messages: a new turn only starts with your message (default, archives slower). DSH turns: count like the "N turns" chip, so every goal auto-continuation counts; archived originals stay restorable by ID.',
      turnBasisHuman: 'Human messages (default)',
      turnBasisDsh: 'DSH turns',
      invalidChoice: 'Pick one of the options in the list.',
      planFirstLabel: 'Default plan-first',
      planFirstHint: 'Pause archiving and auto recall while a plan is active; plan artifacts stay protected.',
      autoRestoreLabel: 'Restore originals on disable',
      autoRestoreHint: 'When off, receipts stay and originals are not written back automatically.',
      limitLabel: 'Default matches per recall',
      coolingGateLabel: 'Per-step archive gate (occupancy %)',
      coolingGateHint: 'Compress old steps only after context occupancy reaches this percent; 0 = judge every step (cheapest tokens, most prefix churn).',
      restoreMaxCharsLabel: 'Restore text budget (chars)',
      restoreMaxCharsHint: 'Completed turns whose restore size (text + tool-call args) exceeds it get no voucher; 1000–200000.',
      gateLabel: 'Per-step archive gate',
      gateHint: 'Gate percent for this chat (blank = follow global); 0 = judge every step.',
      limitHint: 'Default for new chats; this chat can override it in the composer panel (1–20).',
      packMinScoreLabel: 'Pack threshold',
      packMinScoreHint: 'Matches below this score stay out of the pack (0 disables the filter).',
      previewCharsLabel: 'Preview characters',
      previewCharsHint: 'How many leading characters each match keeps in the pack (40–4000).',
      queryMaxCharsLabel: 'Query cap',
      queryMaxCharsHint: 'The query uses only the first N characters of the human message (32–4000).',
      chipLabel: 'Memory context',
      chipLabelCount: 'Memory context · {count}',
      chipLabelCoverage: 'Memory context · {count} searchable',
      chipAria: 'Memory context panel',
      chipTitle: 'Open the memory context panel (ingestion / recall / settings)',
      panelTitle: 'Memory context',
      panelNoSessions: 'No selectable session',
      panelSession: 'Session',
      panelStatus: 'Status',
      panelCompact: 'Compact',
      panelHistory: 'History',
      panelExport: 'Export',
      panelSettings: 'Recall settings',
      panelNoSettings: 'The settings service is not ready; status only for now. Edit in the plugin settings page.',
      panelHint: 'Changes apply live. Full detail: /memory-lab status.',
      statusReady: '{ingested} ingested · {searchable} searchable · {injected} recalls',
      statusReadyNoSearchable: '{ingested} ingested · searchable unknown · {injected} recalls',
      statusSearchableOnly: '{searchable} searchable · {injected} recalls',
      statusReadyUnknownCount: 'Ingestion unknown · {injected} recalls',
      statusLast: 'Last: {status}',
      statusAttempted: 'Attempted {attempted} · skipped {skipped} · failed {failed}',
      statusIngesting: 'ingesting…',
      statusPending: 'Creating the shadow store…',
      statusAbsent: 'Nothing ingested in this session yet (send a message to start)',
      hostPlanOn: 'Host plan mode: on (exit with the plan button or /plan off; the plugin’s plan-first only pauses archiving and recall — they are different switches)',
      statusFailed: 'Store creation failed ({code})',
      statusUnknown: 'Status unknown',
      statusMode: 'Mode: {mode}',
      statusPlanFirst: 'Plan-first: on',
      statusArchived: 'Archived through seq {seq}',
statusArchivedAt: 'Archived per step ({time})',
statusStateError: 'State file error: {code} (defaults in effect)',
      modeFullHistory: 'archive per turn',
      modeCooling: 'archive per step',
      modeRecallOnly: 'recall only',
      forkMemory: 'Fork memory',
      forkAction: 'Fork to new chat',
      forkBusy: 'Forking…',
      forkDone: 'Forked; the child rebuilds memory from its log',
      sessionControls: 'This chat',
      sessionEnable: 'Enabled in this chat',
      sessionRecall: 'Auto recall',
      sessionPlanFirst: 'Plan-first',
      sessionMode: 'Mode',
      modeWarning: 'Switching only changes when archiving happens from now on; archived text stays put. Use /memory-lab restore all to bring it back.',
      modeConfirm: 'Switch',
      modeCancel: 'Cancel',
      approvePlan: 'Approve plan',
      overridePlaceholder: 'Follow global',
      remoteUnavailable: 'Command channel unavailable; this chat cannot be changed.',
      commandFailed: 'Command failed: {message}',
      commandDone: 'Updated',
    }

    const ROW_STYLE = { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: '2px 12px', padding: '10px 0', borderTop: '1px solid rgba(128, 128, 128, 0.18)' }
    const LABEL_STYLE = { fontSize: 12, fontWeight: 500 }
    const HINT_STYLE = { gridColumn: '1 / -1', fontSize: 11, lineHeight: 1.5, opacity: 0.65 }
    const INPUT_STYLE = { width: 116, padding: '4px 8px', fontSize: 12, fontFamily: 'inherit', color: 'inherit', background: 'transparent', border: '1px solid rgba(128, 128, 128, 0.35)', borderRadius: 6 }
    const CONTROL_STYLE = { display: 'flex', alignItems: 'center', gap: 8 }
    const TITLE_STYLE = { margin: '0 0 4px', fontSize: 13, fontWeight: 600 }
    const DESC_STYLE = { margin: '0 0 4px', fontSize: 12, lineHeight: 1.6, opacity: 0.7 }
    const FOOT_STYLE = { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }
    const NOTE_STYLE = { fontSize: 11, opacity: 0.7 }

    /**
     * 设置卡片。同一个组件挂在两个键控槽位上：
     * - `plugins.bundle.config`（键 = 包名）→ bundle 详情页内联一节，页面不给 `form`；
     * - `plugins.row.config`（键 = 包名#行 id）→ 该行的「配置」页，页面给 `form`。
     *
     * @param props - 槽位属性：`view`、`t`，以及可能的 `form`（`{state, mutate}`）。
     * @returns 摘要一行（`view === 'summary'`）或设置表单。
     */
    function Card(props) {
      const t = props.t
      // 组件定义在 apply 内，scope 是其闭包：每个插件实例一张表，互不串。
      const scope = applyScope
      const pageForm = props.form
      const pageState = pageForm === undefined ? undefined : pageForm.state

      const [snapshot, setSnapshot] = React.useState(() => pageState ?? scope.getSnapshot())
      const [draft, setDraft] = React.useState({})
      const [outcome, setOutcome] = React.useState(null)

      // 页面自己会重渲染并传来新 state；bundle 页没有 form，只能自己订阅。
      React.useEffect(() => {
        if (pageState !== undefined) {
          setSnapshot(pageState)
          return undefined
        }
        setSnapshot(scope.getSnapshot())
        return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
      }, [pageState])

      // 宿主答了新 revision（含写完回折）就丢弃草稿：草稿的存在意义只是「还没提交的编辑」。
      const revision = snapshot === undefined ? undefined : snapshot.revision
      React.useEffect(() => {
        setDraft({})
        setOutcome(null)
      }, [revision])

      if (props.view === 'summary') return t('summary')

      const status = snapshot === undefined ? 'loading' : snapshot.status
      if (status === 'unavailable') return React.createElement('p', { style: NOTE_STYLE }, t('unavailable'))
      if (status !== 'ready' || snapshot.value === undefined) {
        return React.createElement('p', { style: NOTE_STYLE }, t('loading'))
      }

      const values = snapshot.value
      const user = snapshot.user ?? {}
      const writable = snapshot.writable !== false
      const mutate = pageForm === undefined
        ? (ops, revision_) => scope.mutate(ops, revision_)
        : (ops, revision_) => pageForm.mutate(ops, revision_)

      /** 当前编辑值：草稿优先，否则取宿主已接受的值（缺值时按默认值占位）。 */
      const draftOf = (field) => {
        if (Object.hasOwn(draft, field.key)) return draft[field.key]
        const current = values[field.key]
        if (field.kind === 'boolean') return current === undefined ? DEFAULTS[field.key] === true : current === true
        if (field.kind === 'string') {
          const allowed = Array.isArray(field.options) ? field.options.map((option) => option.value) : []
          if (allowed.includes(current)) return current
          return allowed.includes(DEFAULTS[field.key]) ? DEFAULTS[field.key] : (allowed[0] ?? '')
        }
        return String(current === undefined ? DEFAULTS[field.key] : current)
      }

      const write = async (ops) => {
        if (ops.length === 0) {
          setOutcome({ kind: 'saved' })
          return
        }
        setOutcome({ kind: 'saving' })
        let accepted = false
        try {
          accepted = await mutate(ops, snapshot.revision)
        } catch {
          accepted = false
        }
        setOutcome({ kind: accepted ? 'saved' : 'failed' })
      }

      /** 收集改动；越界在本地拦下（宿主 schema 也会拒，但那时只剩一句「保存失败」）。 */
      const save = () => {
        const ops = []
        for (const field of FIELDS) {
          if (!Object.hasOwn(draft, field.key)) continue
          const raw = draft[field.key]
          if (field.kind === 'boolean') {
            if (raw !== (values[field.key] === true)) ops.push({ op: 'set', path: [field.key], value: raw })
            continue
          }
          if (field.kind === 'string') {
            const value = String(raw)
            // 只允许下拉框给出的值：手改 draft 或旧配置里的未知值一律拦在本地。
            if (!Array.isArray(field.options) || !field.options.some((option) => option.value === value)) {
              setOutcome({ kind: 'invalid', field: field.key })
              return
            }
            if (value !== values[field.key]) ops.push({ op: 'set', path: [field.key], value })
            continue
          }
          const text = String(raw).trim()
          if (text === '') {
            ops.push({ op: 'unset', path: [field.key] })
            continue
          }
          const number = Number(text)
          if (!Number.isFinite(number) || number < field.min || number > field.max) {
            setOutcome({ kind: 'invalid', field: field.key })
            return
          }
          if (number !== values[field.key]) ops.push({ op: 'set', path: [field.key], value: number })
        }
        void write(ops)
      }

      const resetField = (field) => {
        setDraft((previous) => {
          const next = { ...previous }
          delete next[field.key]
          return next
        })
        void write([{ op: 'unset', path: [field.key] }])
      }

      const rows = FIELDS.map((field) => {
        const id = 'memory-context-lab-' + field.key
        const overridden = Object.hasOwn(user, field.key)
        const control = field.kind === 'boolean'
          ? React.createElement(Switch, {
            key: 'control',
            checked: draftOf(field) === true,
            label: t(field.label),
            disabled: !writable,
            onChange: (next) => setDraft((previous) => ({ ...previous, [field.key]: next === true })),
          })
          : field.kind === 'string'
            ? React.createElement('select', {
              key: 'control',
              id,
              value: draftOf(field),
              disabled: !writable,
              style: INPUT_STYLE,
              'aria-label': t(field.label),
              'data-mcl-select': field.key,
              onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
            }, (field.options ?? []).map((option) => React.createElement('option', {
              key: option.value,
              value: option.value,
            }, t(option.label))))
            : React.createElement('input', {
              key: 'control',
              id,
              type: 'number',
              min: field.min,
              max: field.max,
              step: field.step,
              value: draftOf(field),
              disabled: !writable,
              style: INPUT_STYLE,
              'aria-label': t(field.label),
              onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
            })
        const invalid = outcome !== null && outcome.kind === 'invalid' && outcome.field === field.key
        return React.createElement('div', { key: field.key, style: ROW_STYLE, 'data-mcl-field': field.key }, [
          // 数字输入用 label 关联（htmlFor 指得到 id）；开关的可访问名由 Switch 的 label 提供。
          React.createElement('label', { key: 'label', htmlFor: field.kind === 'boolean' ? undefined : id, style: LABEL_STYLE }, t(field.label)),
          React.createElement('div', { key: 'control', style: CONTROL_STYLE }, [
            control,
            overridden || Object.hasOwn(draft, field.key)
              ? React.createElement(Button, {
                key: 'reset',
                variant: 'outline',
                size: 'sm',
                disabled: !writable,
                'data-mcl-reset': field.key,
                onClick: () => resetField(field),
              }, t('reset'))
              : null,
          ]),
          React.createElement('div', { key: 'hint', style: HINT_STYLE }, invalid
            ? t(field.kind === 'string' ? 'invalidChoice' : 'invalid', { min: String(field.min), max: String(field.max) })
            : t(field.hint)),
        ])
      })

      const note = !writable
        ? t('readOnly')
        : outcome === null || outcome.kind === 'saving' || outcome.kind === 'invalid'
          ? null
          : t(outcome.kind === 'saved' ? 'saved' : 'saveFailed')

      return React.createElement('section', { 'data-mcl-config': NS }, [
        React.createElement('h4', { key: 'title', style: TITLE_STYLE }, t('title')),
        React.createElement('p', { key: 'desc', style: DESC_STYLE }, t('description')),
        ...rows,
        React.createElement('div', { key: 'foot', style: FOOT_STYLE }, [
          React.createElement(Button, {
            key: 'save',
            variant: 'primary',
            size: 'sm',
            disabled: !writable || (outcome !== null && outcome.kind === 'saving'),
            'data-mcl-save': true,
            onClick: save,
          }, outcome !== null && outcome.kind === 'saving' ? t('saving') : t('save')),
          note === null ? null : React.createElement('span', { key: 'note', style: NOTE_STYLE }, note),
        ]),
      ])
    }

    /**
     * chip + 向上弹层的样式（沿用 v1/v2 的视觉与几何）。只引用主题 token，
     * 触发器与 composer 里的权限选择器同形：透明底、无边框、28px 高。
     */
    const CSS = [
      '.mcl-wrap{position:relative;align-items:center;display:inline-flex}',
      '.mcl-chip{box-sizing:border-box;border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;white-space:nowrap}',
      '.mcl-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.mcl-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.mcl-chip:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      ".mcl-chip[data-on='true']{color:var(--dsw-alias-state-business-primary)}",
      '.mcl-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mcl-chip-chevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform 120ms;display:inline-flex}',
      ".mcl-chip[data-open='true'] .mcl-chip-chevron{transform:rotate(180deg)}",
      '.mcl-veil{position:fixed;inset:0;z-index:39;background:transparent;border:0;padding:0}',
      '.mcl-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;box-sizing:border-box;width:320px;max-height:min(440px,60vh);overflow-y:auto;overflow-x:hidden;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-lg);padding:12px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.mcl-title{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.mcl-section{border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:6px}',
      '.mcl-row{display:flex;align-items:center;gap:8px;min-height:28px;min-width:0}',
      '.mcl-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.mcl-field{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.mcl-input{box-sizing:border-box;width:88px;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right}',
      '.mcl-input:disabled{cursor:not-allowed;opacity:.5}',
      '.mcl-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}',
      '.mcl-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}',
      ".mcl-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}",
      '.mcl-switch:disabled{cursor:default;opacity:.5}',
      '.mcl-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.mcl-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}',
      ".mcl-switch[aria-checked='false'] .mcl-thumb{background:var(--dsw-alias-switch-thumb)}",
      ".mcl-switch[aria-checked='true'] .mcl-thumb{transform:translateX(16px)}",
      '.mcl-status{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap}',
      '.mcl-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.mcl-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      '.mcl-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-line;word-break:break-word}',
      '.mcl-panel{box-sizing:border-box;height:100%;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}',
      '.mcl-panel-title{margin:0;font-size:15px;font-weight:600}',
      '.mcl-panel-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}',
      '.mcl-select{box-sizing:border-box;min-width:200px;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.mcl-mode-select{min-width:0;width:128px;height:28px;font-size:12px}',
      '.mcl-mode-confirm{display:flex;flex-direction:column;gap:4px;padding:4px 0}',
      '.mcl-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.mcl-panel-btn,.mcl-btn{box-sizing:border-box;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.mcl-panel-btn:disabled,.mcl-btn:disabled{cursor:default;opacity:.5}',
      '.mcl-panel-icon{display:inline-flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-sm);font-weight:600;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    function StyleTag() {
      return React.createElement('style', null, CSS)
    }

    /** 本实例的配置表单控制器（apply 里发布，Card 读取）。 */
    let applyScope = null
    /** 浏览器插件 ctx（命令通道在调用期解析，避免注入早于挂载）。 */
    let hostCtx = null

    function publishScope(scope) {
      applyScope = scope
    }

    /**
     * 解析 remote 门面：只返回**命令通道已就绪**的 remote，否则 null。
     *
     * 客户端动态门面把 `remote` 暴露成受保护代理，`remote.commands` 只有在
     * `inject` 声明了 `remote.commands` 时才可读；未声明时读取会在代理的 `get`
     * 陷阱里抛 `cannot get property "remote.commands" without inject`。这个抛错
     * 必须在这里吞掉：否则它会冒到弹层的 render，被 SlotErrorBoundary 记成
     * `slot entry crashed` 并把整个 chip 条目 abdicate（H-103）。
     */
    function remoteOf(ctx) {
      if (ctx === null || ctx === undefined) return null
      try {
        const remote = typeof ctx.get === 'function' ? (ctx.get('remote') ?? ctx.remote) : ctx.remote
        if (remote === null || remote === undefined) return null
        // 在 try 内触碰受保护子服务：没有命令通道时返回 null，弹层禁用并说明。
        return typeof remote.commands?.execute === 'function' ? remote : null
      } catch {
        return null
      }
    }

    function describeError(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /**
     * 执行一条完整斜杠命令（会话级控制的唯一写通道）。
     * 返回 { ok, text }，永不 reject。
     */
    function uiWorkspaceOf(ctx) {
      if (ctx === null || ctx === undefined) return null
      try {
        const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx.uiWorkspace
        return workspace !== null && workspace !== undefined && typeof workspace.forkSession === 'function' ? workspace : null
      } catch {
        return null
      }
    }

    async function runLine(ctx, sessionId, line) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return { ok: false, text: 'no-session' }
      if (typeof line !== 'string' || line.length === 0) return { ok: false, text: 'unknown-command' }
      const remote = remoteOf(ctx)
      const execute = remote?.commands?.execute
      if (typeof execute !== 'function') return { ok: false, text: 'no-remote' }
      let result
      try {
        result = await execute(sessionId, line, [])
      } catch (error) {
        return { ok: false, text: describeError(error) }
      }
      if (result === null || result === undefined) return { ok: false, text: 'no-result' }
      if (typeof result === 'string') return { ok: true, text: result }
      if (result.ok === false) {
        const error = result.error
        const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : ''
        const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : ''
        return { ok: false, text: message.length > 0 ? message : (code || 'transport') }
      }
      const value = result.ok === true && 'value' in result ? result.value : result
      if (value === null || value === undefined) return { ok: false, text: 'no-result' }
      if (typeof value === 'string') return { ok: true, text: value }
      // 真实 remote.commands.execute 返回 CommandExecution { commandId, result: { kind, text } }；
      // 旧代码只读 value.text，text 落在 value.result.text，于是所有按钮都显示“已更新”。
      const payload = value.result !== null && typeof value.result === 'object' ? value.result : value
      const text = typeof payload.text === 'string'
        ? payload.text
        : (typeof payload.message === 'string' ? payload.message : '')
      return { ok: payload.kind !== 'error', text }
    }

    /** 投影里的会话控制（缺字段一律按默认全开，绝不因坏形状崩）。 */
    function controlOfStatus(status) {
      const overrides = Object.fromEntries(SESSION_OVERRIDE_FIELDS.map((field) => [field.key, null]))
      const out = { enabled: true, recall: true, overrides, error: null }
      const raw = status !== null && typeof status === 'object' ? status.control : undefined
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
      for (const key of ['enabled', 'recall']) {
        if (typeof raw[key] === 'boolean') out[key] = raw[key]
      }
      if (raw.overrides !== null && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides)) {
        for (const field of SESSION_OVERRIDE_FIELDS) {
          const value = raw.overrides[field.key]
          if (typeof value === 'number' && Number.isFinite(value)) out.overrides[field.key] = value
        }
      }
      if (typeof raw.error === 'string' && raw.error.length > 0) out.error = raw.error
      return out
    }

    /** 投影状态 → 弹层里的几行文案。任何未知形状都落到「状态未知」，不抛错。 */
    function statusLines(status, t) {
      if (status === null || typeof status !== 'object') return [t('statusUnknown')]
      const modeLabel = status.mode === 'full-history'
        ? t('modeFullHistory')
        : status.mode === 'cooling' ? t('modeCooling') : t('modeRecallOnly')
      const prefix = [t('statusMode', { mode: modeLabel })]
      if (status.planFirst === true) prefix.push(t('statusPlanFirst'))
      if (Number.isInteger(status.surface?.lastArchiveEndSeq) && status.surface.lastArchiveEndSeq >= 0) {
        prefix.push(t('statusArchived', { seq: status.surface.lastArchiveEndSeq }))
      } else if (typeof status.surface?.lastArchiveAt === 'number' && status.surface.lastArchiveAt > 0) {
        // B3-18（AUD50-06-07）：cooling（按步归档）不推进 lastArchiveEndSeq——只认它会让
        // 整个按步模式在弹层里「没有归档事实」。lastArchiveAt 两种模式都推进。
        prefix.push(t('statusArchivedAt', { time: new Date(status.surface.lastArchiveAt).toLocaleString() }))
      }
      if (typeof status.stateError === 'string' && status.stateError.length > 0) {
        // B3-18：状态文件异常（state.json 损坏/不可读）必须可见，不能静默显示默认值
        prefix.push(t('statusStateError', { code: status.stateError }))
      }
      const withPrefix = (lines) => [...prefix, ...lines]
      const injected = Number.isInteger(status.injected) && status.injected >= 0 ? status.injected : 0
      if (status.state === 'ready') {
        const ingested = Number.isInteger(status.ingested) && status.ingested >= 0 ? status.ingested : null
        const searchable = Number.isInteger(status.searchable) && status.searchable >= 0 ? status.searchable : null
        // 三个数分别可读：已摄入 / 可检索 / 回注。索引读不到时显示「未知」，不写成 0。
        const lines = [ingested !== null
          ? (searchable !== null
            ? t('statusReady', { ingested, searchable, injected })
            : t('statusReadyNoSearchable', { ingested, injected }))
          : (searchable !== null
            ? t('statusSearchableOnly', { searchable, injected })
            : t('statusReadyUnknownCount', { injected }))]
        if (typeof status.lastStatus === 'string' && status.lastStatus.length > 0) {
          lines.push(t('statusLast', { status: status.lastStatus }))
        }
        const attempted = Number.isInteger(status.attempted) && status.attempted >= 0 ? status.attempted : 0
        if (attempted > 0) {
          lines.push(t('statusAttempted', {
            attempted,
            skipped: Number.isInteger(status.skipped) ? status.skipped : 0,
            failed: Number.isInteger(status.failed) ? status.failed : 0,
          }))
        }
        if (status.ingesting === true) lines.push(t('statusIngesting'))
        return withPrefix(lines)
      }
      if (status.state === 'pending') return withPrefix([t('statusPending')])
      if (status.state === 'absent') return withPrefix([t('statusAbsent')])
      if (status.state === 'failed') {
        const code = typeof status.errorCode === 'string' && status.errorCode.length > 0 ? status.errorCode : 'EUNKNOWN'
        const lines = [t('statusFailed', { code })]
        if (typeof status.lastStatus === 'string' && status.lastStatus.length > 0) {
          lines.push(t('statusLast', { status: status.lastStatus }))
        }
        return withPrefix(lines)
      }
      return withPrefix([t('statusUnknown')])
    }

    /**
     * composer 工具行里的 chip（沿用 v1/v2 的位置与形态）。
     * 点开是锚定在 chip 上的向上弹层；收起即卸载。
     */
    function MemoryChip(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const sessionId = props.sessionId
      const [open, setOpen] = React.useState(false)
      const status = typeof props.useProjection === 'function' ? props.useProjection(PROJECTION_KEY) : undefined
      // 宿主计划模式（@deepseek-ai/dsh-plan-mode 的 `plan` 投影）与插件的「计划先行」不是
      // 同一个开关：插件只暂停归档与回注，宿主计划模式由「计划」按钮 / `/plan off` 控制。
      // 读不到投影就当未知（不渲染提示），投影缺失绝不能影响 chip 本身。
      let hostPlan = null
      if (typeof props.useProjection === 'function') {
        try { hostPlan = props.useProjection('plan') } catch { hostPlan = null }
      }
      const hostPlanActive = hostPlan !== null && typeof hostPlan === 'object' && hostPlan.active === true
      const control = controlOfStatus(status)
      const count = status !== null && typeof status === 'object'
        && status.state === 'ready'
        && Number.isInteger(status.ingested)
        && status.ingested >= 0
        ? status.ingested
        : null
      // chip 显示「可检索」而不是「已摄入」：两者不是一回事（metadata-only 可对账但不进索引）。
      // 索引未知时退回已摄入数，不让 chip 空白；弹出层会同时给出两个数。
      const searchable = status !== null && typeof status === 'object'
        && Number.isInteger(status.searchable)
        && status.searchable >= 0
        ? status.searchable
        : null
      const label = searchable !== null
        ? t('chipLabelCoverage', { count: searchable })
        : (count === null ? t('chipLabel') : t('chipLabelCount', { count }))
      const active = control.enabled && control.recall

      const onKeyDown = (event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
      }

      return React.createElement(React.Fragment, null,
        React.createElement(StyleTag, { key: 'style' }),
        open ? React.createElement('div', {
          className: 'mcl-veil',
          key: 'veil',
          'aria-hidden': 'true',
          onClick: () => setOpen(false),
        }) : null,
        React.createElement('span', {
          className: 'mcl-wrap',
          key: 'chip',
          onKeyDown,
        },
          React.createElement('button', {
            type: 'button',
            className: 'mcl-chip',
            'data-on': active ? 'true' : undefined,
            'data-open': open ? 'true' : undefined,
            'aria-expanded': open,
            'aria-haspopup': 'dialog',
            'aria-label': t('chipAria'),
            title: t('chipTitle'),
            onClick: () => setOpen((value) => !value),
          },
            React.createElement('span', { className: 'mcl-chip-label', key: 'label' }, label),
            React.createElement('span', { className: 'mcl-chip-chevron', 'aria-hidden': 'true', key: 'chevron' },
              React.createElement('svg', {
                viewBox: '0 0 16 16',
                width: 14,
                height: 14,
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.5,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }, React.createElement('path', { d: 'M4 6.5 8 10.5 12 6.5' })))),
          open ? React.createElement(MemoryPopover, { key: 'pop', t, status, sessionId, hostPlanActive }) : null))
    }

    /**
     * 弹层：本对话控制 + 状态。
     *
     * 只改**本对话**：启用 / 自动回注 + 回注条数；
     * 全局默认仍在插件设置页。写入走 `/memory-lab on|off|inject|set limit|unset limit`
     * 命令（`ctx.remote.commands.execute`，与 ui-plan 同一前台通道），不直连文件、不直写配置。
     */
    function MemoryPopover(props) {
      const t = props.t
      const status = props.status
      const sessionId = props.sessionId
      const control = controlOfStatus(status)
      // 只读提示：宿主计划模式开着时说明它和插件的计划先行不是一回事（否则用户会以为插件
      // 擅自开了计划模式）。不提供切换按钮——计划模式归宿主，`/plan off` 是唯一出口。
      const hostPlanActive = props.hostPlanActive === true
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)
      // 计划开关先本地翻转：命令执行后投影不一定立刻重算，等 status 回来再对齐。
      const [planFirstLocal, setPlanFirstLocal] = React.useState(null)
      // 模式选择同样先落到本地（等投影刷新），失败必须回滚——不让选择器谎报已生效。
      const [modeLocal, setModeLocal] = React.useState(null)
      const [pendingMode, setPendingMode] = React.useState(null)
      const signature = JSON.stringify(control)
      React.useEffect(() => {
        setDraft({})
        setOutcome(null)
        setPlanFirstLocal(null)
        setModeLocal(null)
        setPendingMode(null)
      }, [signature, status?.planFirst, status?.mode])
      const remoteAvailable = remoteOf(hostCtx) !== null
      const workspace = uiWorkspaceOf(hostCtx)
      const canEdit = typeof sessionId === 'string' && sessionId.length > 0 && remoteAvailable && !busy
      const canFork = canEdit && workspace !== null

      const run = async (line) => {
        if (!canEdit) return null
        setBusy(true)
        setOutcome(null)
        const result = await runLine(hostCtx, sessionId, line)
        setBusy(false)
        setOutcome(result.ok
          ? { kind: 'saved', text: result.text || t('commandDone') }
          : { kind: 'failed', text: result.text || t('remoteUnavailable') })
        return result
      }

      const forkMemory = async () => {
        if (!canFork) return
        setBusy(true)
        setOutcome(null)
        try {
          // fork 复制的是 DSH 会话日志；v3 会按子会话日志重新摄入、重建记忆。
          // 不再跑 adopt-from：子会话一旦 pre-step 就非空，adopt-from 会按设计拒绝。
          await workspace.forkSession(sessionId)
          setOutcome({ kind: 'saved', text: t('forkDone') })
        } catch (error) {
          setOutcome({ kind: 'failed', text: describeError(error) })
        } finally {
          setBusy(false)
        }
      }

      const switchNode = (label, checked, command, forceDisabled = false, onToggle = null) => React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': t(label),
        className: 'mcl-switch',
        disabled: !canEdit || forceDisabled,
        onClick: () => { if (typeof onToggle === 'function') onToggle(); else void run(command) },
      }, React.createElement('span', { className: 'mcl-thumb', 'aria-hidden': 'true' }))

      const rows = [
        ['sessionEnable', 'session.enabled', control.enabled, control.enabled ? '/memory-lab off' : '/memory-lab on'],
        ['sessionRecall', 'session.recall', control.recall, control.recall ? '/memory-lab inject off' : '/memory-lab inject on'],
      ].map(([label, field, checked, command]) => React.createElement('div', {
        className: 'mcl-row',
        key: field,
        'data-mcl-field': field,
      }, [
        React.createElement('span', { className: 'mcl-label', key: 'label' }, t(label)),
        React.createElement('span', { className: 'mcl-field', key: 'control' }, switchNode(label, checked, command, field === 'session.recall' && !control.enabled)),
      ]))

      // 计划先行：布尔开关 + 「批准计划」动作。批准不是纯布尔——它要写冻结边界，
      // 所以开关旁边单独给按钮（只有开启时才出现）。
      const planFirst = planFirstLocal === null
        ? (status !== null && typeof status === 'object' && status.planFirst === true)
        : planFirstLocal
      const togglePlanFirst = async () => {
        const next = !planFirst
        setPlanFirstLocal(next)
        const result = await run(next ? '/memory-lab planfirst on' : '/memory-lab planfirst off')
        // 失败（或命令通道不可用）时回到原状态，不让开关谎报已生效。
        if (result === null || result.ok !== true) setPlanFirstLocal(!next)
      }
      rows.splice(2, 0, React.createElement('div', {
        className: 'mcl-row',
        key: 'session.planfirst',
        'data-mcl-field': 'session.planfirst',
      }, [
        React.createElement('span', { className: 'mcl-label', key: 'label' }, t('sessionPlanFirst')),
        React.createElement('span', { className: 'mcl-field', key: 'control' }, [
          switchNode('sessionPlanFirst', planFirst, planFirst ? '/memory-lab planfirst off' : '/memory-lab planfirst on', !control.enabled, () => { void togglePlanFirst() }),
          planFirst ? React.createElement('button', {
            type: 'button',
            className: 'mcl-btn',
            key: 'approve',
            disabled: !canEdit,
            onClick: () => { void run('/memory-lab planfirst approve') },
          }, t('approvePlan')) : null,
        ]),
      ]))

      // 本对话模式（P1）：旧会话迁移成 recall-only 后，这里给出切回 full-history 的入口。
      // 切换先弹确认（归档会改变模型可见表面，可用 /memory-lab restore all 还原），
      // 写入仍走 /memory-lab mode …，不直写 state。
      const projectedMode = status !== null && typeof status === 'object'
        && (status.mode === 'full-history' || status.mode === 'cooling' || status.mode === 'recall-only')
        ? status.mode
        : 'recall-only'
      const mode = modeLocal ?? projectedMode
      const modeOptions = [
        ['full-history', 'modeFullHistory'],
        ['cooling', 'modeCooling'],
        ['recall-only', 'modeRecallOnly'],
      ]
      // 只有「已经压过历史」时才需要确认：切换只改变之后的归档时机，不撤销已归档内容。
      // lastArchiveEndSeq 是回合级位点（按步归档不推进）；lastArchiveAt 两种模式都推进。
      const hasArchived = status !== null && typeof status === 'object'
        && ((Number.isInteger(status.surface?.lastArchiveEndSeq) && status.surface.lastArchiveEndSeq >= 0)
          || (typeof status.surface?.lastArchiveAt === 'number' && status.surface.lastArchiveAt > 0))
      const applyMode = async (next) => {
        setPendingMode(null)
        setModeLocal(next)
        const result = await run('/memory-lab mode ' + next)
        // 失败（含命令通道不可用）：回到投影模式，并保留 run 写入的失败文案。
        if (result === null || result.ok !== true) setModeLocal(null)
      }
      const chooseMode = (event) => {
        const next = event?.target?.value
        if (next === mode || (next !== 'full-history' && next !== 'cooling' && next !== 'recall-only')) return
        if (!hasArchived) { void applyMode(next); return }
        setPendingMode(next)
      }
      const confirmMode = async () => {
        if (pendingMode === null || !canEdit) return
        await applyMode(pendingMode)
      }
      rows.splice(3, 0, React.createElement('div', {
        className: 'mcl-row',
        key: 'session.mode',
        'data-mcl-field': 'session.mode',
      }, [
        React.createElement('span', { className: 'mcl-label', key: 'label' }, t('sessionMode')),
        React.createElement('span', { className: 'mcl-field', key: 'control' }, React.createElement('select', {
          className: 'mcl-select mcl-mode-select',
          value: mode,
          disabled: !canEdit,
          'aria-label': t('sessionMode'),
          'data-mcl-mode': true,
          onChange: chooseMode,
        }, modeOptions.map(([value, label]) => React.createElement('option', { key: value, value }, t(label))))),
      ]))
      if (pendingMode !== null) {
        rows.splice(4, 0, React.createElement('div', {
          className: 'mcl-mode-confirm',
          key: 'session.mode.confirm',
          'data-mcl-field': 'session.mode.confirm',
        }, [
          React.createElement('div', { className: 'mcl-hint', key: 'warn' }, t('modeWarning')),
          React.createElement('div', { className: 'mcl-actions', key: 'actions' }, [
            React.createElement('button', {
              type: 'button',
              className: 'mcl-btn',
              key: 'confirm',
              disabled: !canEdit,
              'data-mcl-mode-confirm': true,
              onClick: () => { void confirmMode() },
            }, t('modeConfirm')),
            React.createElement('button', {
              type: 'button',
              className: 'mcl-btn',
              key: 'cancel',
              'data-mcl-mode-cancel': true,
              onClick: () => setPendingMode(null),
            }, t('modeCancel')),
          ]),
        ]))
      }

      const commit = (field) => {
        if (!canEdit) return
        if (!Object.hasOwn(draft, field.key)) return
        const text = String(draft[field.key]).trim()
        if (text === '') {
          void run('/memory-lab unset ' + field.key)
          return
        }
        if (!/^\d+$/.test(text)) {
          setOutcome({ kind: 'invalid', field: field.key })
          return
        }
        const number = Number(text)
        if (!Number.isSafeInteger(number) || number < field.min || number > field.max) {
          setOutcome({ kind: 'invalid', field: field.key })
          return
        }
        void run('/memory-lab set ' + field.key + ' ' + number)
      }

      for (const field of SESSION_OVERRIDE_FIELDS) {
        // onlyWhen：闸门只在「按步归档」下出现（别的模式里它不生效，显示就是噪音）。
        if (field.onlyWhen !== undefined && status?.mode !== field.onlyWhen) continue
        const current = Object.hasOwn(draft, field.key)
          ? draft[field.key]
          : (control.overrides[field.key] === null || control.overrides[field.key] === undefined
            ? ''
            : String(control.overrides[field.key]))
        const invalid = outcome !== null && outcome.kind === 'invalid' && outcome.field === field.key
        const input = React.createElement('input', {
          id: 'mcl-override-' + field.key,
          type: 'number',
          min: field.min,
          max: field.max,
          step: field.step,
          value: current,
          placeholder: t('overridePlaceholder'),
          disabled: !canEdit,
          className: 'mcl-input',
          'aria-label': t(field.label),
          'data-mcl-override': field.key,
          onChange: (event) => setDraft((previous) => ({ ...previous, [field.key]: event.target.value })),
          onBlur: () => commit(field),
          onKeyDown: (event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit(field)
          },
        })
        rows.push(React.createElement('div', {
          className: 'mcl-row',
          key: 'override.' + field.key,
          'data-mcl-field': 'override.' + field.key,
        }, [
          React.createElement('label', {
            className: 'mcl-label',
            key: 'label',
            htmlFor: 'mcl-override-' + field.key,
            title: t(field.hint),
          }, t(field.label)),
          React.createElement('span', { className: 'mcl-field', key: 'control' }, [
            input,
            invalid ? React.createElement('span', { key: 'bad', className: 'mcl-hint' }, '!') : null,
          ]),
        ]))
      }

      const outcomeText = outcome === null
        ? null
        : outcome.kind === 'invalid'
          ? (() => {
            const field = SESSION_OVERRIDE_FIELDS.find((row) => row.key === outcome.field)
            return t('invalid', { min: String(field.min), max: String(field.max) })
          })()
          : outcome.kind === 'failed'
            ? t('commandFailed', { message: outcome.text })
            : t('commandDone')

      return React.createElement('div', {
        className: 'mcl-pop',
        role: 'dialog',
        'aria-label': t('panelTitle'),
        key: 'pop',
      }, [
        React.createElement('div', { className: 'mcl-title', key: 'title' }, t('panelTitle')),
        React.createElement('div', { className: 'mcl-status', key: 'status' },
          statusLines(status, t).map((line, index) => React.createElement('div', { key: index }, line))),
        hostPlanActive ? React.createElement('div', {
          className: 'mcl-hint',
          key: 'host-plan',
          'data-mcl-field': 'host.plan',
        }, t('hostPlanOn')) : null,
        React.createElement('div', { className: 'mcl-section', key: 'session' }, [
          React.createElement('div', { className: 'mcl-title', key: 'session-title' }, t('sessionControls')),
          ...rows,
          control.error === null ? null : React.createElement('div', {
            className: 'mcl-error',
            key: 'control-error',
          }, 'session control: ' + control.error),
          remoteAvailable ? null : React.createElement('div', {
            className: 'mcl-hint',
            key: 'remote-unavailable',
          }, t('remoteUnavailable')),
          React.createElement('div', { className: 'mcl-row', key: 'fork' }, [
            React.createElement('span', { className: 'mcl-label', key: 'label' }, t('forkMemory')),
            React.createElement('span', { className: 'mcl-field', key: 'control' }, React.createElement('button', {
              type: 'button',
              className: 'mcl-btn',
              disabled: !canFork,
              onClick: () => { void forkMemory() },
            }, busy ? t('forkBusy') : t('forkAction'))),
          ]),
        ]),
        outcomeText === null ? null : React.createElement('div', {
          className: outcome.kind === 'saved' ? 'mcl-ok' : 'mcl-error',
          key: 'outcome',
          role: outcome.kind === 'failed' ? 'alert' : undefined,
        }, outcomeText),
      ])
    }

    function panelT() {
      try {
        return typeof hostCtx?.locale?.bind === 'function' ? hostCtx.locale.bind(LOCALE_NS) : (key) => key
      } catch {
        return (key) => key
      }
    }

    /** 侧栏图标：只占一个方块，不引入新图依赖。 */
    function LabIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 20
      return React.createElement('span', {
        className: 'mcl-panel-icon',
        style: { width: size, height: size, fontSize: Math.round(size * 0.5) },
        'aria-hidden': 'true',
      }, 'M')
    }

    /**
     * 侧栏主面板（M6 UI 的最小完整面）：会话选择 + 状态/压缩/导出/历史/fork。
     * 只走命令通道与 uiWorkspace；不直读文件、不直写设置。
     */
    function LabPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : panelT()
      const useSessions = props.useSessions
      const ids = typeof useSessions === 'function' ? useSessions((state) => (Array.isArray(state?.ids) ? state.ids : [])) : []
      const byId = typeof useSessions === 'function' ? useSessions((state) => state?.byId ?? {}) : {}
      const [selected, setSelected] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [outcome, setOutcome] = React.useState(null)
      React.useEffect(() => {
        if (selected === null || !ids.includes(selected)) setSelected(ids[0] ?? null)
      }, [ids, selected])
      const remoteAvailable = remoteOf(hostCtx) !== null
      const workspace = uiWorkspaceOf(hostCtx)
      const canRun = typeof selected === 'string' && selected.length > 0 && remoteAvailable && !busy
      const run = async (line) => {
        if (!canRun) return
        setBusy(true)
        setOutcome(null)
        try {
          const result = await runLine(hostCtx, selected, line)
          setOutcome({ ok: result.ok, text: result.text || (result.ok ? t('commandDone') : t('remoteUnavailable')) })
        } catch (error) {
          setOutcome({ ok: false, text: describeError(error) })
        } finally {
          setBusy(false)
        }
      }
      const fork = async () => {
        if (!canRun || workspace === null) return
        setBusy(true)
        setOutcome(null)
        try {
          await workspace.forkSession(selected)
          setOutcome({ ok: true, text: t('forkDone') })
        } catch (error) {
          setOutcome({ ok: false, text: describeError(error) })
        } finally {
          setBusy(false)
        }
      }
      const button = (label, line) => React.createElement('button', {
        type: 'button',
        className: 'mcl-panel-btn',
        disabled: !canRun,
        onClick: () => { void run(line) },
      }, label)
      const options = ids.map((id) => React.createElement('option', { key: id, value: id },
        (byId[id]?.title ?? byId[id]?.name ?? id)))
      return React.createElement('div', { className: 'mcl-panel' }, [
        React.createElement(StyleTag, { key: 'style' }),
        React.createElement('h2', { className: 'mcl-panel-title', key: 'title' }, t('panelTitle')),
        ids.length === 0
          ? React.createElement('div', { className: 'mcl-hint', key: 'empty' }, t('panelNoSessions'))
          : React.createElement('select', {
            className: 'mcl-select',
            key: 'session',
            value: selected ?? '',
            'aria-label': t('panelSession'),
            onChange: (event) => setSelected(event.target.value || null),
          }, options),
        React.createElement('div', { className: 'mcl-panel-row', key: 'actions' }, [
          button(t('panelStatus'), '/memory-lab status'),
          button(t('panelCompact'), '/memory-lab compact'),
          button(t('panelHistory'), '/memory-lab history'),
          button(t('panelExport'), '/memory-lab export'),
          workspace === null ? null : React.createElement('button', {
            type: 'button',
            className: 'mcl-panel-btn',
            key: 'fork',
            disabled: !canRun,
            onClick: () => { void fork() },
          }, t('forkAction')),
        ]),
        remoteAvailable ? null : React.createElement('div', { className: 'mcl-hint', key: 'remote' }, t('remoteUnavailable')),
        outcome === null ? null : React.createElement('div', {
          key: 'outcome',
          className: outcome.ok ? 'mcl-ok' : 'mcl-error',
          role: outcome.ok ? undefined : 'alert',
        }, outcome.text),
        React.createElement('div', { className: 'mcl-hint', key: 'hint' }, t('panelHint')),
      ])
    }

    /**
     * 浏览器半的**服务声明**（不是 `package.json` 的 `dsh.client.inject` 图依赖）。
     *
     * `remote.commands` 必须显式声明：客户端动态门面按 `inject` 判权，未声明时
     * `ctx.remote.commands` 会在代理 `get` 陷阱里抛错（H-103 的真机错误原文：
     * `cannot get property "remote.commands" without inject`）。声明后弹层才拿得到
     * 命令通道；通道本身不可用时 `remoteOf` 仍回 null，控件禁用并说明。
     *
     * slots / locale 仍是硬依赖；configForms 继续走 `ctx.inject` 可选接入。
     */
    const inject = ['slots', 'locale', 'remote', 'remote.commands', 'uiWorkspace']

    /**
     * 挂载两个面：① composer 的 chip + 弹层（无条件，等槽位出现）；② 设置表单（命名空间被服务时才注册）。
     * @param ctx - 浏览器插件上下文。
     */
    function apply(ctx) {
      hostCtx = ctx
      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'memory-context-lab: dictionaries')

      // chip 在 composer 工具行左侧；conversation.input.left 在 hero 与 composer 变体都存在。
      ctx.slots.inject(CHIP_SLOT, () => ctx.slots.register({
        name: CHIP_SLOT,
        id: CHIP_ID,
        order: CHIP_ORDER,
        locale: LOCALE_NS,
      }, MemoryChip))

      // M6 侧栏面板：list id 与 main key 同名，侧栏按钮点开就是本面板。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'memory-context-lab',
        order: 30,
        label: () => panelT()('panelTitle'),
        locale: LOCALE_NS,
      }, LabIcon))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'memory-context-lab',
      }, LabPanel))

      // 可选依赖：settings 服务缺席时这一段不启动，chip 只显示状态。
      ctx.inject(['configForms'], (settingsCtx) => {
        // 提供方（@deepseek-ai/dsh-client-ui-settings）拥有并缓存这张表；这里不 dispose，
        // 否则同一页面里插件行关掉再打开会拿到已废弃实例，配置永远停在 loading。
        publishScope(settingsCtx.configForms.get(NS))

        settingsCtx.effect(() => settingsCtx.configForms.whileServed([NS], () => {
          const disposers = [
            settingsCtx.slots.register({ name: 'plugins.bundle.config', key: BUNDLE, locale: LOCALE_NS }, Card),
            settingsCtx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: LOCALE_NS }, Card),
          ]
          return () => {
            for (const dispose of disposers.reverse()) dispose()
          }
        }), 'memory-context-lab: settings page')
      })
    }

    const module = { exports: {} }
    module.exports.NS = NS
    module.exports.BUNDLE = BUNDLE
    module.exports.ROW_KEY = ROW_KEY
    module.exports.FIELDS = FIELDS
    module.exports.SESSION_OVERRIDE_FIELDS = SESSION_OVERRIDE_FIELDS
    module.exports.DEFAULTS = DEFAULTS
    module.exports.CHIP_SLOT = CHIP_SLOT
    module.exports.CHIP_ID = CHIP_ID
    module.exports.CHIP_ORDER = CHIP_ORDER
    module.exports.PROJECTION_KEY = PROJECTION_KEY
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
/**
 * dsh-memory-context-lab —— 浏览器端（Client）半侧。
 *
 * 纯 JS，无构建步骤：以 `window.__ModuleLoader__.load({ id, factory })` 注册一个惰性
 * factory，id 必须等于包名 `dsh-memory-context-lab`。React 走模块表的 `require('react')`；
 * **不** require 任何宿主 Client 包（`@deepseek-ai/dsh-client-ui-primitives` 等一律禁止），
 * 控件按宿主 ui-primitives 的 markup / CSS / 行为自绘，只共用 `--dsw-*` 主题 token。
 *
 * 一个座位（靠模块级极小 store 共享展开状态与最近一次命令输出）：
 *   - `conversation.input.left`（list，order 20）：composer 工具行里的「降温」触发器，
 *     紧邻权限控件（`conversation.input.permission` 单实例座位）右侧。**无外框**，
 *     样式照权限选择器的 trigger（`ui-permission-presets/src/client/PermissionSelect.module.css`）：
 *     透明底、无边框、28px 高、label-secondary 文字、hover 铺底、focus 用 box-shadow 环。
 *     设置面板是**锚定在该触发器上的弹层**（`.mcl-pop`，向上展开），收起即卸载。
 *
 * 为什么不用 `conversation.composer.dock`：宿主只在 `variant === "composer"` 时渲染
 * 该座位，而全新对话处于 hero 变体（`sessionId` 已存在、`shellPhase === "blank"`），
 * dock 整块不渲染——那会让「新对话里点按钮没反应」。chip 所在的 `input.left`
 * 两种变体都渲染，弹层挂这里才能在两种状态下都打开。
 *
 * 数据面：会话投影 `memoryContextLab`（经标准 prop `useProjection('memoryContextLab')`
 * 读取；键从未有过值时返回 `undefined`，见 ProjectionValueStore.faceOf 的注释）。
 * 操作面：座位 `inject: (sessionId) => ({ run })`，内部走
 * `ctx.remote.commands.execute(sessionId, line, [])`（同 ui-plan 的 exitPlanMode）。
 *
 * 防御式约定（组件抛异常会让整个 slot 条目空白）：
 *   - 投影为 undefined / 字段缺失 / 类型不对，一律走兜底默认值；
 *   - `run` 缺失、抛错、返回形状不认识，都映射成面板底部一行内联错误；
 *   - locale 服务缺失时退回内置 zh 字典，绝不显示裸 key；
 *   - 不用 setInterval；关闭面板即卸载，不残留定时器。
 */

window.__ModuleLoader__.load({
  id: 'dsh-memory-context-lab',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    var h = React.createElement;

    /** locale 命名空间（与宿主投影同名，但两者互不相干）。 */
    var NS = 'memoryContextLab';
    /** 宿主注册的会话投影键。 */
    var PROJECTION_KEY = 'memoryContextLab';
    /** 两个 list 座位的 cell key；用自有 id，不覆盖宿主条目。 */
    var SLOT_ID = 'memory-context-lab';
    var SLOT_ORDER = 20;

    //#region 文案字典
    /**
     * 简体中文（键集的事实来源）。
     * 英文表必须与之逐键一致——宿主 `ctx.locale.register(ns, { zh, en })` 要求两套内置
     * locale 齐全，缺键在编译期就会报错。
     */
    var zh = {
      'chip.label': '降温',
      'chip.labelOn': '降温 · {count}',
      'chip.aria': '上下文降温面板',
      'chip.titleOff': '打开上下文降温面板（/memory-lab）',
      'chip.titleOn': '已启用上下文降温，已归档 {count} 条 — 点击打开面板',

      'panel.enable': '启用降温',
      'panel.status.off': '未启用',
      'panel.status.on': '已启用',
      'panel.status.auto': '自动',
      'panel.status.manual': '手动',
      'panel.status.archived': '归档 {count}',

      'field.retain': '保留最近操作',
      'field.batch': '攒够几个再归档',
      'field.auto': '自动降温',
      'field.recall': '自动回注',
      'field.autorestore': '停用时恢复原文',
      'field.fullHistory': '全历史记忆上下文',
      'field.fullHistoryHint': '开启后除必要历史（系统头、人类消息、计划工件）外全部退热入本会话隔离灵枢临时记忆，只留不可压缩凭证；「保留最近操作」随之失效，去留由证据保护层自动裁决',
      'field.planFirst': '新会话计划先行',
      'field.planFirstHint': '开启后：全新对话第一条消息即自动进入宿主「计划模式」（经 plan/mode 日志落账），计划期间降温/回注挂起；用户批准计划后自动启用上下文降温，计划全文作为指引常驻、全程不归档',
  'field.compressModel': '层级压缩模型模式',
  'field.compressModelHint': '层级压缩的阶段摘要改由模型生成：每个结论必须能对回 L0 精确值，校不过或模型不可用时自动落回程序摘要（默认关）',
'field.compressModel': '层级压缩模型模式',
'field.compressModelHint': '层级压缩（/memory-lab2 compress）启用时，聚合摘要先经注入的 LLM 改写并逐条对回 L0 校验；无模型、鉴权失败、限流、超时、超预算或校验不过时自动落回程序摘要，取消/关闭/阶段重开/来源过期是任务撤销',
      'field.retainDisabled': '全历史记忆上下文开启中：保留窗口失效（去留由证据保护层裁决）',

      'panel.status.v2': 'v2 引擎',
      'panel.status.planActive': '计划模式',

      'action.now': '立即降温',
      'action.dryRun': '预演',
      'action.restore': '恢复原文',
      'action.clean': '清理',
      'action.cleanConfirm': '确认清理',

      'output.title': '状态与最近一次命令输出',
      'output.empty': '暂无输出',

      'error.noSession': '当前会话不可用，无法执行命令',
      'error.noRemote': '命令通道尚未就绪，请稍后重试',
      'error.empty': '命令没有返回结果',
      'error.unknownCommand': '命令没有返回结果（可能是未知命令）',
      'error.transport': '执行失败：{message}',

      'preset.label': '预设',
      'preset.global': '全局预设',
      'preset.modified': '已调整',
      'preset.unavailable': '预设列表加载失败，仅显示全局预设'
    };

    /** English dictionary, checked complete against the zh key set. */
    var en = {
      'chip.label': 'Cooling',
      'chip.labelOn': 'Cooling · {count}',
      'chip.aria': 'Context cooling panel',
      'chip.titleOff': 'Open the context cooling panel (/memory-lab)',
      'chip.titleOn': 'Context cooling is on, {count} archived — click to open the panel',

      'panel.enable': 'Enable cooling',
      'panel.status.off': 'Off',
      'panel.status.on': 'On',
      'panel.status.auto': 'Auto',
      'panel.status.manual': 'Manual',
      'panel.status.archived': '{count} archived',

      'field.retain': 'Keep recent operations',
      'field.batch': 'Archive after N pile up',
      'field.auto': 'Auto cooling',
      'field.recall': 'Auto recall',
      'field.autorestore': 'Restore text when stopping',
      'field.fullHistory': 'Full-history memory context',
      'field.fullHistoryHint': 'When on, everything except essentials (system head, human messages, plan artifacts) cools into this session\u2019s isolated Lingshu scratch memory, leaving only incompressible vouchers; \u201ckeep recent operations\u201d is disabled and evidence protection decides what stays',
      'field.planFirst': 'Plan first in new sessions',
'field.compressModel': 'Hierarchy compression model mode',
'field.compressModelHint': 'When hierarchy compression (/memory-lab2 compress) is on, aggregate summaries are rewritten by the injected LLM and verified line-by-line against L0; missing model, auth failure, rate limit, timeout, over-budget or failed verification falls back to the program summary; cancel/off/stage-restart/stale-source cancels the task',
      'field.compressModel': 'Hierarchy compression model mode',
  'field.compressModelHint': 'Phase summaries are generated by the model: every claim must trace back to exact L0 values; falls back to program summaries when unverified or unavailable (default off)',
  'field.planFirstHint': 'When on, the first message of a brand-new conversation automatically enters host plan mode (via plan/mode log commit); cooling/recall pause while planning, and context cooling auto-enables once the plan is approved, with the plan text kept resident as guidance and never archived',
      'field.retainDisabled': 'Full-history mode is on: the keep-recent window is disabled (evidence protection decides)',

      'panel.status.v2': 'v2 engine',
      'panel.status.planActive': 'Plan mode',

      'action.now': 'Cool now',
      'action.dryRun': 'Dry run',
      'action.restore': 'Restore text',
      'action.clean': 'Clean up',
      'action.cleanConfirm': 'Confirm cleanup',

      'output.title': 'Status and last command output',
      'output.empty': 'No output yet',

      'error.noSession': 'No usable session for this command',
      'error.noRemote': 'The command channel is not ready yet, try again shortly',
      'error.empty': 'The command returned no result',
      'error.unknownCommand': 'The command returned no result (unknown command?)',
      'error.transport': 'Command failed: {message}',

      'preset.label': 'Preset',
      'preset.global': 'Global preset',
      'preset.modified': 'adjusted',
      'preset.unavailable': 'Preset list unavailable, showing global preset only'
    };
    //#endregion

    //#region 全局配置（设置页）读取
    /**
     * 宿主设置域（settings）与配置表单（configForms）的只读辅助。
     * 两者都按「可选能力」对待：拿不到时降温 chip 与命令照常工作，
     * 仅弹层的预设列表退化为只有「全局预设」、设置页卡片不注册。
     */
    var CONFIG_NS = 'memory-context-lab';
    var SETTINGS_CARD_KEY = 'dsh-memory-context-lab#' + CONFIG_NS;

    function optionalService(ctx, id) {
      if (ctx && typeof ctx[id] !== 'undefined') return ctx[id]
      try {
        return typeof ctx.get === 'function' ? ctx.get(id) : null
      } catch (error) {
        return null
      }
    }

    function configFormsOf(ctx) {
      var service = optionalService(ctx, 'configForms');
      return service && typeof service.get === 'function' ? service : null;
    }

    /** 读取本插件 Config 命名空间当前生效值；未就绪/不可用时返回 null。 */
    function readConfigValue(ctx) {
      var forms = configFormsOf(ctx);
      if (!forms) return null;
      try {
        var form = forms.get(CONFIG_NS);
        var snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : null;
        var value = snapshot && snapshot.value;
        return value && typeof value === 'object' ? value : null;
      } catch (error) {
        return null;
      }
    }

    /** 归一化预设行列表：只要 id + name + 5 个数值/开关字段。 */
    function presetRowsOf(configValue) {
      var raw = configValue && Array.isArray(configValue.presets) ? configValue.presets : [];
      var rows = [];
      raw.forEach(function (entry, index) {
        if (!entry || typeof entry !== 'object') return;
        var settings = entry.settings && typeof entry.settings === 'object' ? entry.settings : entry;
        rows.push({
          id: typeof entry.id === 'string' && entry.id ? entry.id : 'preset-' + (index + 1),
          name: typeof entry.name === 'string' && entry.name ? entry.name : '预设 ' + (index + 1),
          settings: {
            retainOperations: Number(settings.retainOperations),
            archiveBatchSize: Number(settings.archiveBatchSize),
            auto: settings.auto !== false,
            autoRecall: settings.autoRecall !== false,
            autoRestore: settings.autoRestore !== false
          }
        });
      });
      return rows;
    }

    function presetNameOf(rows, id) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === id) return rows[i].name;
      }
      return '';
    }
    //#endregion

    //#region 样式
    /**
     * 组件内联 `<style>` React 元素（卸载即移除，不往 document.head 里塞东西，
     * 也不写 document.body / 不注册 window 事件）。
     *
     * 只引用主题 token：`--dsw-alias-*` / `--dsw-radius-*` / `--dsw-focus-ring-*`，
     * 无硬编码颜色。开关与按钮的几何直接照抄宿主 ui-primitives 的 `.switch` / `.button`
     * （36×20 轨道 + 16px 滑块、28px 高 sm 按钮、`--dsw-alias-switch-thumb`），
     * 类名统一加 `mcl-` 前缀。
     */
    var CSS =
      // 触发器与 composer 里的权限选择器同形：透明底、无边框、28px 高、
      // label-secondary 文字、hover 才铺底色、focus 用 box-shadow 环。
      // 状态只靠文字色表达，不加外框——外框会与相邻的权限控件视觉冲突。
      '.mcl-wrap{position:relative;align-items:center;display:inline-flex}'
      + '.mcl-chip{box-sizing:border-box;border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;font-weight:500;line-height:20px;display:inline-flex;white-space:nowrap}'
      + '.mcl-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}'
      + '.mcl-chip:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}'
      + '.mcl-chip:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}'
      + ".mcl-chip[data-on='true']{color:var(--dsw-alias-state-business-primary)}"
      + '.mcl-chip-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.mcl-chip-chevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform 120ms;display:inline-flex}'
      + ".mcl-chip[data-open='true'] .mcl-chip-chevron{transform:rotate(180deg)}"
      // 弹层锚定 chip 并向上展开。客户端半侧拿不到 portal，所以用绝对定位；
      // 祖先链（.tools/.row/.card）无 paint containment，不会被裁剪。
      // 上限高度用 vh 兜住矮窗口，超出时弹层内部滚动，而不是顶出视口。
      // 外点关闭走 veil：全屏透明层压在弹层之下（z-index 39 < 40），点在弹层
      // 之外的任何位置都落在 veil 上并收起；客户端不注册 window/document 事件。
      + '.mcl-veil{position:fixed;inset:0;z-index:39;background:transparent;border:0;padding:0;}'
      + '.mcl-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;box-sizing:border-box;width:320px;max-height:min(420px,60vh);overflow-y:auto;overflow-x:hidden;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-lg);padding:12px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}'
      + '.mcl-row{display:flex;align-items:center;gap:8px;min-height:28px;min-width:0}'
      // rc.5：label 永不竖排——长文本收缩到省略号（title 提示保留全文），
      // 不再把行 min-content 撑破弹层宽度把「启用降温」挤成一字一行。
      + '.mcl-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.mcl-field{flex:none;display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}'
      + '.mcl-input{box-sizing:border-box;width:72px;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right}'
      + '.mcl-input:disabled{cursor:not-allowed;opacity:.5}'
      + '.mcl-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}'
      + '.mcl-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer}'
      + ".mcl-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}"
      + '.mcl-switch:disabled{cursor:default;opacity:.5}'
      + '.mcl-switch:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}'
      + '.mcl-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);transition:transform 120ms ease}'
      + ".mcl-switch[aria-checked='false'] .mcl-thumb{background:var(--dsw-alias-switch-thumb)}"
      + ".mcl-switch[aria-checked='true'] .mcl-thumb{transform:translateX(16px)}"
      + '.mcl-actions{display:flex;flex-wrap:wrap;gap:8px}'
      + '.mcl-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}'
      + '.mcl-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}'
      + '.mcl-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}'
      + '.mcl-button:disabled{cursor:not-allowed;opacity:.4}'
      + ".mcl-button[data-danger='true']{border-color:var(--dsw-alias-state-error-secondary);color:var(--dsw-alias-state-error-primary)}"
      + '.mcl-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-line;word-break:break-word}'
      + '.mcl-output{box-sizing:border-box;max-height:96px;overflow:auto;margin:0;padding:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}'
      + '.mcl-select{box-sizing:border-box;max-width:220px;height:28px;padding:0 4px 0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}'
      + '.mcl-select:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}'
      + '.mcl-select:disabled{cursor:not-allowed;opacity:.5}'
      + '.mcl-input{box-sizing:border-box;max-width:72px;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}'
      + '.mcl-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}'
      + '.mcl-input:disabled{opacity:.5;cursor:not-allowed}'
      + '.mcl-name{box-sizing:border-box;width:150px;height:28px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}'
      + '.mcl-name:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}'
      + '.mcl-card{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}'
      + '.mcl-card-block{display:flex;flex-direction:column;gap:6px;padding:10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}'
      + '.mcl-card-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-height:28px}'
      + '.mcl-card-title{margin:0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}'
      + '.mcl-card-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}'
      + '.mcl-card-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;font-style:italic}'
      + '.mcl-check{display:inline-flex;align-items:center;gap:4px;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer}'
      + '.mcl-check input{accent-color:var(--dsw-alias-state-business-primary);margin:0;cursor:pointer}'
      + '.mcl-check input:disabled{cursor:not-allowed}';

    /** 随组件挂载 / 卸载的样式节点（两个组件各带一份，重复应用无副作用）。 */
    function StyleTag() {
      return h('style', { 'data-plugin-css': 'dsh-memory-context-lab/client.css' }, CSS);
    }
    //#endregion

    //#region 模块级极小 store（不引 store 库）
    /**
     * chip 与 panel 共享的极小状态：展开开关、最近一次命令输出、在途标志。
     * 只用「替换 + 通知 + 订阅」三件事；`useStore` 用一个自增计数器强制重渲染。
     */
    var store = {
      open: false,
      status: null,
      error: null,
      busy: false,
      listeners: [],
      subscribe: function (fn) {
        var list = store.listeners;
        list.push(fn);
        return function () {
          var at = list.indexOf(fn);
          if (at !== -1) list.splice(at, 1);
        };
      },
      emit: function () {
        var list = store.listeners.slice();
        for (var i = 0; i < list.length; i += 1) {
          // 单个订阅者异常不影响另一侧（chip / panel 必须各自独立存活）
          try { list[i](); } catch (e) { /* ignore */ }
        }
      },
      set: function (patch) {
        if (patch == null) return;
        var changed = false;
        for (var key in patch) {
          if (Object.prototype.hasOwnProperty.call(patch, key) && store[key] !== patch[key]) {
            store[key] = patch[key];
            changed = true;
          }
        }
        if (changed) store.emit();
      }
    };

    /** 订阅 store 变更；返回同一个 store 对象（调用方每次渲染直接读字段）。 */
    function useStore() {
      var pair = React.useState(0);
      var bump = pair[1];
      React.useEffect(function () {
        return store.subscribe(function () {
          bump(function (n) { return n + 1; });
        });
      }, []);
      return store;
    }
    //#endregion

    //#region 读取 / 兜底
    /** 投影视图（`undefined` = 尚无会话或投影未注册）。 */
    function useView(props) {
      var useProjection = props != null ? props.useProjection : null;
      if (typeof useProjection !== 'function') return undefined;
      var view;
      try {
        view = useProjection(PROJECTION_KEY);
      } catch (e) {
        return undefined;
      }
      return view != null && typeof view === 'object' ? view : undefined;
    }

    function boolOf(value, fallback) {
      return typeof value === 'boolean' ? value : fallback;
    }

    function numOf(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? value : fallback;
    }

    function countOf(value) {
      var n = numOf(value, 0);
      return n > 0 ? Math.round(n) : 0;
    }

    /** 非负整数；非法输入返回 null。 */
    function parseCount(text) {
      if (typeof text !== 'string') return null;
      var raw = text.trim();
      if (raw.length === 0) return null;
      var value = Number(raw);
      if (!isFinite(value) || Math.floor(value) !== value || value < 0) return null;
      return value;
    }

    function describeError(e) {
      if (e == null) return 'unknown';
      if (typeof e === 'string') return e.length > 0 ? e : 'unknown';
      if (typeof e.message === 'string' && e.message.length > 0) return e.message;
      if (typeof e.code === 'string' && e.code.length > 0) return e.code;
      try { return String(e); } catch (x) { return 'unknown'; }
    }

    /** 本地化文案兜底：locale 服务不可用时退回内置 zh 字典，绝不显示裸 key。 */
    function fallbackText(key, params) {
      var raw = Object.prototype.hasOwnProperty.call(zh, key) ? zh[key] : key;
      if (params == null) return raw;
      return raw.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] == null ? match : String(params[name]);
      });
    }

    /** 座位注册带 `locale: NS` 时宿主会注入 `t`；缺失 / 抛错时退回兜底字典。 */
    function translatorOf(props) {
      var t = props != null ? props.t : null;
      if (typeof t !== 'function') {
        return function (key, params) { return fallbackText(key, params); };
      }
      return function (key, params) {
        try {
          var text = t(key, params);
          if (typeof text === 'string' && text.length > 0) return text;
        } catch (e) { /* fall through */ }
        return fallbackText(key, params);
      };
    }
    //#endregion

    //#region 命令面
    /** apply 时捕获的插件 ctx（`run` 在调用期解析 remote，避免注入早于挂载）。 */
    var hostCtx = null;

    /** 解析 remote 门面：`ctx.get('remote')` 优先，退回 `ctx.remote`。 */
    function remoteOf(ctx) {
      if (ctx == null) return null;
      try {
        if (typeof ctx.get === 'function') {
          var viaGet = ctx.get('remote');
          if (viaGet != null) return viaGet;
        }
      } catch (e) { /* ignore */ }
      try {
        if (ctx.remote != null) return ctx.remote;
      } catch (e) { /* ignore */ }
      return null;
    }

    /** 结果码 → locale key（错误文案由组件侧翻译）。 */
    var CODE_KEYS = {
      'no-session': 'error.noSession',
      'no-remote': 'error.noRemote',
      'no-result': 'error.empty',
      'unknown-command': 'error.unknownCommand',
      'transport': 'error.transport'
    };

    /**
     * 执行一条完整斜杠命令。
     *
     * `ctx.remote.commands.execute(sessionId, line, [])` 的信封是
     * `{ ok: true, value: { kind: 'success'|'error', text } }` 或
     * `{ ok: false, error: { code, message } }`；这里归一成 `{ ok, text?, code? }`，
     * 让组件只面对一种形状（同时也容忍宿主将来直接返回裸 value）。
     *
     * @returns {Promise<{ok: boolean, text?: string, code?: string}>} 永不 reject。
     */
    function runLine(ctx, sessionId, line) {
      if (typeof line !== 'string' || line.length === 0) {
        return Promise.resolve({ ok: false, code: 'unknown-command' });
      }
      if (sessionId == null) {
        return Promise.resolve({ ok: false, code: 'no-session' });
      }
      var remote = remoteOf(ctx);
      var commands = remote != null ? remote.commands : null;
      var execute = commands != null && typeof commands.execute === 'function' ? commands.execute : null;
      if (execute == null) {
        return Promise.resolve({ ok: false, code: 'no-remote' });
      }
      var call;
      try {
        call = execute(sessionId, line, []);
      } catch (e) {
        return Promise.resolve({ ok: false, code: 'transport', text: describeError(e) });
      }
      return Promise.resolve(call).then(function (result) {
        if (result == null) return { ok: false, code: 'no-result' };
        if (typeof result !== 'object') return { ok: true, text: String(result) };
        if (result.ok === false) {
          var error = result.error;
          var message = error != null && typeof error.message === 'string' ? error.message : '';
          var code = error != null && typeof error.code === 'string' ? error.code : '';
          var text = message;
          if (code.length > 0) text = text.length > 0 ? text + ' (' + code + ')' : code;
          return { ok: false, code: 'transport', text: text };
        }
        // 信封里取 value；宿主将来直接返回值时原样透传，避免把正常结果吃掉。
        var value = result.ok === true && 'value' in result ? result.value : result;
        if (value == null) return { ok: false, code: 'unknown-command' };
        if (typeof value === 'string') return { ok: true, text: value };
        if (typeof value !== 'object') return { ok: true, text: String(value) };
        var kind = typeof value.kind === 'string' ? value.kind : 'success';
        var out = typeof value.text === 'string' ? value.text : '';
        if (out.length === 0 && typeof value.message === 'string') out = value.message;
        return { ok: kind !== 'error', text: out };
      }, function (e) {
        return { ok: false, code: 'transport', text: describeError(e) };
      });
    }

    /** 把 `run` 的返回值（归一形状或裸信封）翻成 `{ ok, text }`。 */
    function interpret(result, t) {
      if (result == null) return { ok: false, text: t('error.empty') };
      if (typeof result === 'string') return { ok: true, text: result };
      if (typeof result !== 'object') return { ok: true, text: String(result) };
      var ok = result.ok === true;
      var text = typeof result.text === 'string' ? result.text : '';
      if (text.length === 0 && typeof result.message === 'string') text = result.message;
      if (text.length === 0 && result.code != null) {
        var key = CODE_KEYS[String(result.code)];
        if (key != null) text = t(key, { message: String(result.code) });
      }
      if (text.length === 0) text = t(ok ? 'output.empty' : 'error.empty');
      return { ok: ok, text: text };
    }

    /**
     * 执行一次命令并把结果写进共享 store。
     * `run` 缺失、同步抛错、返回 rejected promise 都收敛成底部一行内联错误。
     */
    function callCommand(props, line, t) {
      var run = props != null && typeof props.run === 'function' ? props.run : null;
      if (run == null) {
        var missing = t('error.noSession');
        store.set({ busy: false, error: missing, status: missing });
        return Promise.resolve();
      }
      store.set({ busy: true, error: null });
      var pending;
      try {
        pending = Promise.resolve(run(line));
      } catch (e) {
        pending = Promise.reject(e);
      }
      return pending.then(function (result) {
        var outcome = interpret(result, t);
        store.set({ status: outcome.text, error: outcome.ok ? null : outcome.text });
      }, function (e) {
        var failed = t('error.transport', { message: describeError(e) });
        store.set({ status: failed, error: failed });
      }).then(function () {
        store.set({ busy: false });
      });
    }
    //#endregion

    //#region chip + popover（conversation.input.left）
    /**
     * composer 工具行里的「降温」触发器，与相邻的权限选择器同形：透明底、无边框，
     * 状态只由文字色与 chevron 表达。点击切换下方弹层的展开状态。
     *
     * 设置面板是**锚定在触发器上的弹层**，而不是 `composer.dock` 的座位。宿主只在
     * `variant === "composer"` 时渲染 dock，而全新对话处于 hero 变体（`sessionId`
     * 已存在、`shellPhase === "blank"`，见 ui-conversation 的 InputBar），dock 整块
     * 不渲染——这正是「新对话里按钮点了没反应」的成因。chip 所在的
     * `conversation.input.left` 在两种变体下都渲染，因此弹层必须挂在这里。
     */
    function MemoryChip(props) {
      useStore();
      var t = translatorOf(props);
      var view = useView(props);

      var enabled = boolOf(view != null ? view.enabled : undefined, false);
      var archived = countOf(view != null ? view.archived : undefined);
      var open = store.open;

      var label = enabled ? t('chip.labelOn', { count: archived }) : t('chip.label');
      var title = enabled
        ? t('chip.titleOn', { count: archived })
        : t('chip.titleOff');

      function close() {
        if (store.open) store.set({ open: false });
      }

      /**
       * 外点关闭：open 时渲染一块全屏透明 veil（z-index 低于弹层），点在弹层外
       * 的任何位置都落在 veil 上并收起。不用 blur 判定——弹层内控件在 busy 时
       * 会被 disabled，焦点跌回 body 触发 relatedTarget=null 的 blur，旧实现
       * 每次点击一个设置就整层缩回（本会话实测反馈）。不监听 document/window
       * （沙箱契约：不直接触 DOM 全局），Escape 仍可关闭。
       */
      function onKeyDown(event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        close();
      }

      var button = h('button', {
        type: 'button',
        className: 'mcl-chip',
        'data-on': enabled ? 'true' : undefined,
        'data-open': open ? 'true' : undefined,
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        'aria-label': t('chip.aria'),
        title: title,
        onClick: function () { store.set({ open: !store.open }); }
      },
        h('span', { className: 'mcl-chip-label', key: 'label' }, label),
        h('span', { className: 'mcl-chip-chevron', 'aria-hidden': 'true', key: 'chevron' },
          h('svg', {
            viewBox: '0 0 16 16',
            width: 14,
            height: 14,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            strokeLinecap: 'round',
            strokeLinejoin: 'round'
          }, h('path', { d: 'M4 6.5 8 10.5 12 6.5' }))));

      return h(React.Fragment, null,
        h(StyleTag, { key: 'style' }),
        open ? h('div', {
          className: 'mcl-veil',
          key: 'veil',
          'aria-hidden': 'true',
          onClick: close
        }) : null,
        h('span', {
          className: 'mcl-wrap',
          key: 'chip',
          onKeyDown: onKeyDown
        },
          button,
          open ? h(MemoryPopover, { key: 'pop', t: t, view: view, props: props }) : null));
    }
    //#endregion

    //#region 设置弹层
    /** 自绘开关（照宿主 ui-primitives 的 Switch：role=switch + aria-checked + 滑块）。 */
    function switchNode(checked, label, disabled, onToggle) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: label,
        disabled: disabled === true,
        className: 'mcl-switch',
        onClick: function () { onToggle(!checked); }
      }, h('span', { className: 'mcl-thumb', 'aria-hidden': 'true' }));
    }

    function secondaryButton(label, disabled, danger, onClick) {
      return h('button', {
        type: 'button',
        className: 'mcl-button',
        'data-danger': danger === true ? 'true' : undefined,
        disabled: disabled === true,
        onClick: onClick
      }, label);
    }

    /**
     * 设置弹层。只在展开时挂载，因此收起即卸载，不残留草稿或订阅。
     *
     * 数值输入用本地草稿，失焦或回车时提交对应的 `/memory-lab set ...`；
     * 提交期间禁用全部控件，失败在底部显示一行红字。
     */
    function MemoryPopover(input) {
      useStore();
      var t = input.t;
      var view = input.view;
      var props = input.props;

      var enabled = boolOf(view != null ? view.enabled : undefined, false);
      var auto = boolOf(view != null ? view.auto : undefined, false);
      var autoRecall = boolOf(view != null ? view.autoRecall : undefined, false);
      var autoRestore = boolOf(view != null ? view.autoRestore : undefined, true);
      var retain = countOf(view != null ? view.retainOperations : undefined);
      var batch = countOf(view != null ? view.archiveBatchSize : undefined);
      var archived = countOf(view != null ? view.archived : undefined);
      var engine = view != null && typeof view.engine === 'string' ? view.engine : '';
      var fullHistory = boolOf(view != null ? view.fullHistory : undefined, false);
      var planFirst = boolOf(view != null ? view.planFirst : undefined, false);
      var compressModel = boolOf(view != null ? view.compressModel : undefined, false);
      var compressOn = boolOf(view != null ? view.hierarchyCompress : undefined, false);
      var planActive = boolOf(view != null ? view.planActive : undefined, false);

      var retainPair = React.useState(String(retain));
      var retainDraft = retainPair[0];
      var setRetainDraft = retainPair[1];
      var batchPair = React.useState(String(batch));
      var batchDraft = batchPair[0];
      var setBatchDraft = batchPair[1];
      var cleanPair = React.useState(false);
      var cleanArmed = cleanPair[0];
      var setCleanArmed = cleanPair[1];

      // 预设列表：打开弹层时从宿主 Config 命名空间拉一次（+订阅变更）。
      // 拿不到 configForms 时退化为只显示「全局预设」，不影响其余控件。
      var presetPair = React.useState(function () {
        var value = readConfigValue(hostCtx);
        return value == null ? null : presetRowsOf(value);
      });
      var presetRows = presetPair[0];
      var setPresetRows = presetPair[1];
      React.useEffect(function () {
        var ctx = hostCtx;
        var forms = configFormsOf(ctx);
        if (!forms) return undefined;
        var form = null;
        try {
          form = forms.get(CONFIG_NS);
        } catch (error) {
          return undefined;
        }
        if (!form || typeof form.subscribe !== 'function') return undefined;
        var sync = function () {
          var value = readConfigValue(ctx);
          setPresetRows(value == null ? null : presetRowsOf(value));
        };
        sync();
        return form.subscribe(sync);
      }, []);

      // 投影值真正变化时（一次成功提交之后）回灌草稿；依赖是原始值，
      // 因此宿主每帧推新对象也不会把用户正在输入的内容冲掉。
      React.useEffect(function () {
        setRetainDraft(String(retain));
      }, [retain]);
      React.useEffect(function () {
        setBatchDraft(String(batch));
      }, [batch]);

      if (!store.open) return null;

      var busy = store.busy === true;

      function run(line) {
        callCommand(props, line, t);
      }

      /**
       * 顺序执行一组命令（前一条落定才发下一条）。
       * 全历史开关涉及「停 v1 → 启 v2 → set」三步，乱序会读到中间态；
       * 任一步失败即停，失败文案留在 store（callCommand 已写入）。
       */
      function runSequence(lines) {
        var promise = Promise.resolve({ ok: true });
        lines.forEach(function (line) {
          promise = promise.then(function (prev) {
            if (prev && prev.ok === false) return prev;
            return callCommand(props, line, t).then(function () {
              return store.error != null ? { ok: false } : { ok: true };
            });
          });
        });
        return promise;
      }

      function commitRetain() {
        var parsed = parseCount(retainDraft);
        if (parsed == null) {
          setRetainDraft(String(retain));
          return;
        }
        if (parsed === retain) return;
        run('/memory-lab set retain ' + String(parsed));
      }

      function commitBatch() {
        var parsed = parseCount(batchDraft);
        if (parsed == null) {
          setBatchDraft(String(batch));
          return;
        }
        if (parsed === batch) return;
        run('/memory-lab set batch ' + String(parsed));
      }

      function onEnter(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        var el = event.target;
        if (el != null && typeof el.blur === 'function') el.blur();
      }

      var statusText = enabled
        ? t('panel.status.on') + (engine === 'v2' ? ' · ' + t('panel.status.v2') : '')
          + ' · ' + (auto ? t('panel.status.auto') : t('panel.status.manual'))
          + ' · ' + t('panel.status.archived', { count: archived })
          + (planActive ? ' · ' + t('panel.status.planActive') : '')
        : t('panel.status.off');

      // rc.5：状态信息从开关后移到底部输出框（原「暂无输出」位）。
      // 摘要恒显：降温状态行 + 全历史行 + 计划先行行；最近一次命令输出追加其下。
      var statusSummary = [
        statusText,
        (fullHistory ? t('panel.status.on') : t('panel.status.off')) + ' · ' + t('field.fullHistory'),
        planFirst
          ? (planActive ? t('panel.status.planActive') : t('panel.status.on')) + ' · ' + t('field.planFirst')
          : t('panel.status.off') + ' · ' + t('field.planFirst')
      ].join('\n');

      // 当前会话生效的预设：投影折叠出 preset.id/label；没选过或全局默认 → 「全局预设」。
      var presetId = view != null && typeof view.preset === 'object' && view.preset != null
        ? String(view.preset.id || '')
        : '';
      var presetModified = view != null && typeof view.preset === 'object' && view.preset != null
        ? view.preset.modified === true
        : false;
      var presetOptions = [{ id: '', name: t('preset.global') }].concat(presetRows || []);
      var presetKnown = presetId === '' || presetOptions.some(function (row) { return row.id === presetId; });
      if (presetId !== '' && !presetKnown) {
        presetOptions.push({
          id: presetId,
          name: (view.preset && view.preset.label) || presetId
        });
      }

      var rows = [];

      rows.push(h('div', { className: 'mcl-row', key: 'preset' },
        h('span', { className: 'mcl-label' }, t('preset.label')),
        h('select', {
          className: 'mcl-select',
          value: presetId,
          disabled: busy || presetRows == null && presetId === '',
          'aria-label': t('preset.label'),
          title: presetRows == null ? t('preset.unavailable') : t('preset.label'),
          onChange: function (event) {
            var next = event.target.value;
            run(next === '' ? '/memory-lab preset reset' : '/memory-lab preset ' + next);
          }
        }, presetOptions.map(function (row) {
          var name = row.id === presetId && presetModified ? row.name + ' · ' + t('preset.modified') : row.name;
          return h('option', { key: row.id, value: row.id }, name);
        }))));

      rows.push(h('div', { className: 'mcl-row', key: 'enable' },
        h('span', { className: 'mcl-label' }, t('panel.enable')),
        switchNode(enabled, t('panel.enable'), busy, function (next) {
          run(next ? '/memory-lab on' : '/memory-lab off');
        })));

      rows.push(h('div', { className: 'mcl-row', key: 'retain' },
        h('span', { className: 'mcl-label', title: fullHistory ? t('field.retainDisabled') : t('field.retain') }, t('field.retain')),
        h('span', { className: 'mcl-field' },
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            autoComplete: 'off',
            className: 'mcl-input',
            value: retainDraft,
            disabled: busy || fullHistory,
            'aria-label': t('field.retain'),
            title: fullHistory ? t('field.retainDisabled') : t('field.retain'),
            onChange: function (event) { setRetainDraft(event.target.value); },
            onBlur: commitRetain,
            onKeyDown: onEnter
          }))));

      // 全历史记忆上下文（v2 引擎专属模式）。开启路径按当前引擎分流：
      // - v1 启用中：先停 v1（恢复原文），再启 v2，最后写入开关；
      // - v2 启用中 / 未启用任何引擎：直接「启用 v2 + 写开关」（set 需要 v2 账本在场）。
      // 关闭路径无条件发 `set fullhistory off`（B1 修复）：投影折叠可能停在 v2
      // 停用后的残留态（enabled=false、engine 为空而 fullHistory 仍为 true），
      // 按引擎条件分流会让「关闭」一条命令都不发、开关永远关不掉。v2 未启用时
      // 该命令返回「v2 引擎未启用」，属可接受的空操作。
      rows.push(h('div', { className: 'mcl-row', key: 'fullHistory' },
        h('span', { className: 'mcl-label', title: t('field.fullHistoryHint') }, t('field.fullHistory')),
        switchNode(fullHistory, t('field.fullHistory'), busy, function (next) {
          if (next) {
            if (enabled && engine !== 'v2') {
              runSequence(['/memory-lab off', '/memory-lab2 on', '/memory-lab2 set fullhistory on']);
            } else if (enabled && engine === 'v2') {
              run('/memory-lab2 set fullhistory on');
            } else {
              runSequence(['/memory-lab2 on', '/memory-lab2 set fullhistory on']);
            }
          } else {
            run('/memory-lab2 set fullhistory off');
          }
        })));

      // 新会话计划先行：插件级开关（从会话日志折叠，两个引擎通用）。
      // 「on」由宿主侧联动进入计划模式（仅全新会话；非全新会话由命令输出提示）。
      rows.push(h('div', { className: 'mcl-row', key: 'planFirst' },
        h('span', { className: 'mcl-label', title: t('field.planFirstHint') }, t('field.planFirst')),
        switchNode(planFirst, t('field.planFirst'), busy, function (next) {
          run('/memory-lab set planfirst ' + (next ? 'on' : 'off'));
        })));

      // 层级压缩模型模式（P4）：仅 v2 会话显示；只发偏好命令，模型不可用时
      // 由失败关闭阶梯落回程序摘要，面板不预判宿主契约。
      if (engine === 'v2' && compressOn) {
        rows.push(h('div', { className: 'mcl-row', key: 'compressModel' },
          h('span', { className: 'mcl-label', title: t('field.compressModelHint') }, t('field.compressModel')),
          switchNode(compressModel, t('field.compressModel'), busy, function (next) {
            run('/memory-lab2 set compressmodel ' + (next ? 'on' : 'off'));
          })));
      }

      rows.push(h('div', { className: 'mcl-row', key: 'batch' },
        h('span', { className: 'mcl-label' }, t('field.batch')),
        h('span', { className: 'mcl-field' },
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            autoComplete: 'off',
            className: 'mcl-input',
            value: batchDraft,
            disabled: busy,
            'aria-label': t('field.batch'),
            title: t('field.batch'),
            onChange: function (event) { setBatchDraft(event.target.value); },
            onBlur: commitBatch,
            onKeyDown: onEnter
          }))));

      rows.push(h('div', { className: 'mcl-row', key: 'auto' },
        h('span', { className: 'mcl-label' }, t('field.auto')),
        switchNode(auto, t('field.auto'), busy, function (next) {
          run('/memory-lab set auto ' + (next ? 'on' : 'off'));
        })));

      rows.push(h('div', { className: 'mcl-row', key: 'recall' },
        h('span', { className: 'mcl-label' }, t('field.recall')),
        switchNode(autoRecall, t('field.recall'), busy, function (next) {
          run('/memory-lab set recall ' + (next ? 'on' : 'off'));
        })));

      rows.push(h('div', { className: 'mcl-row', key: 'autorestore' },
        h('span', { className: 'mcl-label' }, t('field.autorestore')),
        switchNode(autoRestore, t('field.autorestore'), busy, function (next) {
          run('/memory-lab set autorestore ' + (next ? 'on' : 'off'));
        })));

      // B2：维护动作按当前引擎分流。v2 会话改发 v2 同名命令（now/dry-run/restore
      // 在 v2 侧等价存在），不再硬编码 v1——否则 v2 会话点「恢复原文」会走 v1 入口
      // 被误报「未启用」（会话 c896f803）。「清理」保持 v1 入口：v2 停用后数据按
      // 只读保留，没有 v2 等价的删除面，v1 入口自会按引擎说明实际状态。
      rows.push(h('div', { className: 'mcl-actions', key: 'actions' },
        secondaryButton(t('action.now'), busy, false, function () { run(engine === 'v2' ? '/memory-lab2 now' : '/memory-lab now'); }),
        secondaryButton(t('action.dryRun'), busy, false, function () { run(engine === 'v2' ? '/memory-lab2 dry-run' : '/memory-lab dry-run'); }),
        secondaryButton(t('action.restore'), busy, false, function () { run(engine === 'v2' ? '/memory-lab2 restore' : '/memory-lab restore'); }),
        secondaryButton(cleanArmed ? t('action.cleanConfirm') : t('action.clean'), busy, cleanArmed, function () {
          // 二次确认：第一次点击只是把按钮变成「确认清理」。
          if (!cleanArmed) {
            setCleanArmed(true);
            return;
          }
          setCleanArmed(false);
          run('/memory-lab clean');
        })));

      if (store.error != null) {
        rows.push(h('p', { className: 'mcl-error', role: 'alert', key: 'error' }, store.error));
      }

      rows.push(h('pre', {
        className: 'mcl-output',
        role: 'status',
        'aria-label': t('output.title'),
        title: t('output.title'),
        key: 'output'
      }, statusSummary + (store.status != null ? '\n\n' + store.status : '')));

      return h('div', { className: 'mcl-pop', key: 'pop' }, rows);
    }
    //#endregion

    //#region 插件设置页卡片（Settings → 插件 → 上下文降温）
    var CARD_HINT_TEXT = '降温 = 把已完成的工具操作换成小回执，保住前缀缓存。全局默认作用于新会话；预设可按模型一键套用。';

    function clampInt(value, min, max, fallback) {
      var n = Math.round(Number(value));
      if (!isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, n));
    }

    /** 把任意配置片段收敛成设置值（5 个降温字段 + 2 个开关位）。 */
    function settingsValueOf(entry) {
      var source = entry && typeof entry === 'object' ? entry : {};
      var inner = source.settings && typeof source.settings === 'object' ? source.settings : source;
      // 兜底字面量与 src/core.mjs 的 DEFAULT_SETTINGS 对齐（独立 bundle 无法 import
      // 后端模块，由 config-contract 测试守卫防止两处漂移）：retain=5，batch=10。
      return {
        retainOperations: clampInt(inner.retainOperations, 0, 200, 5),
        archiveBatchSize: clampInt(inner.archiveBatchSize, 1, 200, 10),
        auto: inner.auto !== false,
        autoRecall: inner.autoRecall !== false,
        autoRestore: inner.autoRestore !== false,
        // 开关位：缺省 false（与投影初始值一致，避免「卡片显示开、会话显示关」）。
        fullHistory: inner.fullHistory === true,
        planFirst: inner.planFirst === true,
        // 层级压缩模型模式默认（P4）：只作 v2 新账本播种值，会话内开关以命令为准。
        compressModelDefault: inner.compressModelDefault === true
      };
    }

    /** 把 Config 值收敛成卡片草稿：{ defaults, presets: [{id, name, settings}] }。 */
    function draftFromValue(value) {
      var source = value && typeof value === 'object' ? value : {};
      var presets = Array.isArray(source.presets) ? source.presets : [];
      return {
        defaults: settingsValueOf(source.defaults),
        presets: presets.map(function (entry, index) {
          var safe = entry && typeof entry === 'object' ? entry : {};
          return {
            id: typeof safe.id === 'string' && safe.id ? safe.id : 'preset-' + (index + 1),
            name: typeof safe.name === 'string' && safe.name ? safe.name : '预设 ' + (index + 1),
            settings: settingsValueOf(safe)
          };
        })
      };
    }

    function sameDraft(a, b) {
      return JSON.stringify(a) === JSON.stringify(b);
    }

    function configSnapshotOf(form) {
      try {
        var snapshot = form.getSnapshot();
        if (snapshot && typeof snapshot === 'object' && snapshot.value && typeof snapshot.value === 'object') {
          return snapshot;
        }
      } catch (error) { /* 读取失败按未就绪处理 */ }
      return null;
    }

    /** 数字输入组件：失焦/回车时把合法值写回草稿，非法时回落原值。
     *  必须以组件方式挂载（h(NumberInput, ...)）：内部持有 useState，普通函数
     *  调用会破坏 Rules of Hooks（0.9.0-rc.1 审计 H1）。 */
    function NumberInput(props) {
      var value = props.value;
      var min = props.min;
      var max = props.max;
      var pair = React.useState(String(value));
      var text = pair[0];
      var setText = pair[1];
      var commit = function () {
        var n = Math.round(Number(text));
        if (isFinite(n)) props.onCommit(clampInt(n, min, max, value));
        else setText(String(value));
      };
      return h('input', {
        className: 'mcl-input',
        type: 'number',
        min: min,
        max: max,
        step: 1,
        disabled: props.disabled,
        value: text,
        onChange: function (e) { setText(e.target.value); },
        onBlur: commit,
        onKeyDown: function (e) { if (e.key === 'Enter') commit(); }
      });
    }

    function numberInputNode(value, min, max, disabled, onCommit) {
      return h(NumberInput, { value: value, min: min, max: max, disabled: disabled, onCommit: onCommit });
    }

    /** 开关：checkbox + 文案。 */
    function checkNode(checked, label, disabled, onToggle) {
      return h('label', { className: 'mcl-check' },
        h('input', {
          type: 'checkbox',
          disabled: disabled,
          checked: checked,
          onChange: function (e) { onToggle(e.target.checked); }
        }),
        label);
    }

    /** 单个预设的编辑行（改名 + 五个字段 + 删除）。 */
    function presetRowNode(row, index, total, disabled, onChange) {
      var patch = function (partial) {
        onChange(function (prev) {
          var next = prev.slice();
          next[index] = Object.assign({}, prev[index], partial);
          return next;
        });
      };
      var patchSettings = function (partial) {
        patch({ settings: Object.assign({}, row.settings, partial) });
      };
      var remove = function () {
        onChange(function (prev) {
          var next = prev.slice();
          next.splice(index, 1);
          return next;
        });
      };
      return h('div', { className: 'mcl-card-row', key: row.id + '#' + index },
        h('input', {
          className: 'mcl-name',
          type: 'text',
          value: row.name,
          disabled: disabled,
          title: '预设名称（可改名，会话内按名称或 id 引用）',
          onChange: function (e) { patch({ name: e.target.value }); }
        }),
        numberInputNode(row.settings.retainOperations, 0, 200, disabled, function (v) {
          patchSettings({ retainOperations: v });
        }),
        numberInputNode(row.settings.archiveBatchSize, 1, 200, disabled, function (v) {
          patchSettings({ archiveBatchSize: v });
        }),
        checkNode(row.settings.auto, '自动', disabled, function (v) { patchSettings({ auto: v }); }),
        checkNode(row.settings.autoRecall, '回注', disabled, function (v) { patchSettings({ autoRecall: v }); }),
        checkNode(row.settings.autoRestore, '恢复', disabled, function (v) { patchSettings({ autoRestore: v }); }),
        total > 1 ? h('button', {
          className: 'mcl-button',
          type: 'button',
          'data-danger': 'true',
          disabled: disabled,
          onClick: remove
        }, '删除') : null);
    }

    /**
     * 设置页卡片：读写本插件 Config 命名空间（defaults + presets）。
     * 数据面走 plugin-manager 注入的 form（settings 域 ConfigFormController），
     * 只在 view === 'page' 且 form 可用时渲染编辑器，其余视图渲染一行摘要。
     */
    /**
     * 归一化渲染器传入的 form 形态。
     * - 原始控制器（dsh-client-ui-settings 的 ConfigFormController）：getSnapshot / subscribe / mutate。
     * - v0.6.0 插件管理页薄面（dsh-client-ui-plugin-manager formFor）：{ state: <快照>, mutate }，
     *   渲染器每次页面渲染重新求值快照，不提供 subscribe。
     * 归一成 { getSnapshot, mutate, subscribe? }，没有的成员就不出现。
     */
    function normalizeFormFace(form) {
      if (!form || typeof form !== 'object') return null;
      if (typeof form.getSnapshot === 'function') return form;
      if (form.state && typeof form.mutate === 'function') {
        return {
          getSnapshot: function () { return form.state; },
          mutate: form.mutate
        };
      }
      return null;
    }

    function MemorySettingsCard(props) {
      var form = normalizeFormFace(props && props.form);
      var view = props && props.view ? props.view : 'page';
      // H1（0.9.0-rc.1 审计）：早返回必须放在全部 hooks 之后，否则视图切换
      // 会改变 hook 计数。下面先无条件执行 hooks，再按 view/form 分支渲染。
      var snapshot = configSnapshotOf(form);
      var revisionPair = React.useState(0);
      var force = revisionPair[1];
      var revision = snapshot ? snapshot.revision : null;

      var draftPair = React.useState(null);
      var draft = draftPair[0];
      var setDraft = draftPair[1];

      // 薄面 form（v0.6.0 插件管理页）没有 subscribe：保存成功后渲染器不一定立即
      // 重算快照，这里保留一份「刚保存值」做乐观视图，等渲染器带来新快照后自动对齐。
      var savedPair = React.useState(null);
      var saved = savedPair[0];
      var setSaved = savedPair[1];

      var errorPair = React.useState('');
      var error = errorPair[0];
      var setError = errorPair[1];

      var busyPair = React.useState(false);
      var busy = busyPair[0];
      var setBusy = busyPair[1];

      React.useEffect(function () {
        if (revision === null) return undefined;
        setDraft(null); // 草稿失效（外部保存/他端修改）→ 回到服务端值
        return undefined;
      }, [revision]);

      React.useEffect(function () {
        if (!form || typeof form.subscribe !== 'function') return undefined;
        return form.subscribe(function () { force(function (n) { return n + 1; }); });
      }, []);

      if (!snapshot) {
        return h('div', { className: 'mcl-card' },
          h(StyleTag, { key: 'style' }),
          h('p', { className: 'mcl-card-hint' }, '配置加载中…（宿主尚未服务本插件的设置命名空间）'));
      }

      var server = draftFromValue(snapshot.value);
      // 服务端快照一旦离开「刚保存值」（渲染器重算后的外部变更），放回服务端视图
      if (saved && server && !sameDraft(server, saved)) {
        setSaved(null);
      }
      var current = draft || saved || server;
      var dirty = !sameDraft(current, saved || server);

      var save = function () {
        if (!dirty || busy) return;
        var ops = [];
        if (!sameDraft(current.defaults, server.defaults)) {
          ops.push({ op: 'set', path: ['defaults'], value: current.defaults });
        }
        if (!sameDraft(current.presets, server.presets)) {
          ops.push({ op: 'set', path: ['presets'], value: current.presets });
        }
        if (ops.length === 0) return;
        setBusy(true);
        setError('');
        Promise.resolve(form.mutate(ops)).then(function () {
          setBusy(false);
          setSaved(current); // 乐观视图：渲染器重算快照前先显示刚提交的值
          setDraft(null);
        }, function (e) {
          setBusy(false);
          setError(e && e.message ? e.message : String(e));
        });
      };

      var discard = function () { setDraft(null); setError(''); };

      var wrapSet = function (updater) {
        setDraft(function (prev) {
          var base = prev || server;
          var next = typeof updater === 'function' ? updater(base) : updater;
          return next;
        });
      };

      return h('div', { className: 'mcl-card' },
        h(StyleTag, { key: 'style' }),
        h('p', { className: 'mcl-card-hint' }, CARD_HINT_TEXT),
        h('div', { className: 'mcl-card-block' },
          h('p', { className: 'mcl-card-title' }, '全局默认设置'),
          h('div', { className: 'mcl-card-row' },
            h('span', { className: 'mcl-card-hint' }, '保留最近操作'),
            numberInputNode(current.defaults.retainOperations, 0, 200, busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { retainOperations: v }) });
              });
            }),
            h('span', { className: 'mcl-card-hint' }, '归档批量'),
            numberInputNode(current.defaults.archiveBatchSize, 1, 200, busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { archiveBatchSize: v }) });
              });
            }),
            checkNode(current.defaults.auto, '自动降温', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { auto: v }) });
              });
            }),
            checkNode(current.defaults.autoRecall, '命中回注', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { autoRecall: v }) });
              });
            }),
            checkNode(current.defaults.autoRestore, '自动恢复', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { autoRestore: v }) });
              });
            }),
            checkNode(current.defaults.fullHistory, '全历史记忆上下文', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { fullHistory: v }) });
              });
            }),
            checkNode(current.defaults.planFirst, '新会话计划先行', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { planFirst: v }) });
              });
            }),
            checkNode(current.defaults.compressModelDefault, '层级压缩模型模式（默认关，LLM 失败自动落回程序摘要）', busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { compressModelDefault: v }) });
              });
            })),
          h('p', { className: 'mcl-card-hint' }, '新会话开启降温时未选预设即用此默认值（= 弹层里的「全局预设」）；全历史与计划先行只作 v2 新会话的初始开关位。')),
        h('div', { className: 'mcl-card-block' },
          h('div', { className: 'mcl-card-row' },
            h('p', { className: 'mcl-card-title' }, '预设'),
            h('button', {
              className: 'mcl-button',
              type: 'button',
              disabled: busy,
              onClick: function () {
                wrapSet(function (prev) {
                  var next = prev.presets.slice();
                  next.push({
                    id: 'preset-' + Date.now().toString(36),
                    name: '新预设 ' + (next.length + 1),
                    settings: Object.assign({}, prev.defaults)
                  });
                  return Object.assign({}, prev, { presets: next });
                });
              }
            }, '新增预设')),
          current.presets.length === 0
            ? h('p', { className: 'mcl-card-empty' }, '还没有预设；新增后可在会话弹层里一键切换。')
            : current.presets.map(function (row, index) {
              return presetRowNode(row, index, current.presets.length, busy, function (updater) {
                wrapSet(function (prev) {
                  return Object.assign({}, prev, { presets: updater(prev.presets) });
                });
              });
            }),
          h('p', { className: 'mcl-card-hint' }, '每行：名称 · 保留 · 批量 · 自动 · 回注 · 恢复')),
        dirty || error || busy
          ? h('div', { className: 'mcl-card-row' },
            h('button', { className: 'mcl-button', type: 'button', disabled: busy, onClick: save }, '保存更改'),
            dirty && !busy ? h('button', { className: 'mcl-button', type: 'button', onClick: discard }, '放弃更改') : null,
            dirty ? h('span', { className: 'mcl-card-hint' }, '保存立即生效（已启用会话的设置继续从会话日志折叠）') : null)
          : null,
        error ? h('p', { className: 'mcl-error', role: 'alert' }, error) : null);
    }
    //#endregion

    //#region 注册
    /**
     * 座位注入面：`run(line)` 走宿主 `ctx.remote.commands.execute`。
     * `hostCtx` 在调用期读取 remote，因此「注册早于 remote 挂载」不会把错误状态固化。
     */
    function injectFace(sessionId) {
      return {
        run: function (line) {
          return runLine(hostCtx, sessionId, line);
        }
      };
    }

    function apply(ctx) {
      hostCtx = ctx;

      // 1) 文案字典：UI 已挂载后再注册也能被拾取，无需重新挂载。
      //    locale 服务缺失时只退化为内置 zh 字典，不阻断座位注册。
      try {
        if (ctx != null && typeof ctx.effect === 'function' && ctx.locale != null
          && typeof ctx.locale.register === 'function') {
          ctx.effect(function () {
            return ctx.locale.register(NS, { zh: zh, en: en });
          }, 'dsh-memory-context-lab: dictionaries');
        }
      } catch (e) { /* ignore：兜底字典仍然保证界面有字 */ }

      // 2) 一个座位：chip 与其弹层同属一个组件，用 ctx.slots.inject 等待声明，
      //    并在 apply 的 effect 里成组清理。
      //    不注册 `conversation.composer.dock`：宿主只在 composer 变体渲染它，
      //    全新对话处于 hero 变体时该座位不存在，弹层会永远打不开。
      if (ctx == null || ctx.slots == null || typeof ctx.slots.inject !== 'function') return;
      if (typeof ctx.effect !== 'function') return;

      ctx.effect(function () {
        var disposers = [];

        disposers.push(ctx.slots.inject('conversation.input.left', function () {
          return ctx.slots.register({
            name: 'conversation.input.left',
            id: SLOT_ID,
            order: SLOT_ORDER,
            locale: NS,
            inject: injectFace
          }, MemoryChip);
        }));

        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            var dispose = disposers[i];
            if (typeof dispose === 'function') {
              try { dispose(); } catch (e) { /* ignore */ }
            }
          }
        };
      }, 'dsh-memory-context-lab: slots');

      // 3) 插件设置页卡片：仅在宿主设置域服务本插件命名空间（存在 Config schema）
      //    时挂到插件管理页的 plugins.row.config 座位。DSH 桌面 0.2.0-rc.2 / 插件运行时
      //    v0.6.0 核验：插件列表页每个组件行按 `<包名>#<组件 id>` 生成 key，名字可点、
      //    详情页设置区都由该座位驱动（renderer 传 { view: 'page', form }）。
      //    settings.plugins.tab（设置 → 插件 tab 条）在 v0.6.0 客户端不渲染第三方条目，
      //    不能作座位（2026-10-11 运行时 slot 树核验：注册后 children 仍为空）。
      //    configForms 缺失时整块跳过。
      var configForms = configFormsOf(ctx);
      if (configForms && typeof configForms.whileServed === 'function') {
        ctx.effect(function () {
          return configForms.whileServed([CONFIG_NS], function () {
            return ctx.slots.inject('plugins.row.config', function () {
              return ctx.slots.register({
                name: 'plugins.row.config',
                key: SETTINGS_CARD_KEY
              }, MemorySettingsCard);
            });
          });
        }, 'dsh-memory-context-lab: settings card');
      }
    }
    //#endregion

    exports.apply = apply;
    // `remote`/`remote.commands` 是宿主 Web 外壳的常驻服务（ui-plan 徽章同样声明它们），
    // 声明后激活顺序正确；组件仍在调用期解析，缺通道时显示一行可读错误而不是整块消失。
    exports.inject = ['slots', 'locale', 'remote', 'remote.commands', 'configForms'];
    return module.exports;
  }
});

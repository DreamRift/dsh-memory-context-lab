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

      'action.now': '立即降温',
      'action.dryRun': '预演',
      'action.restore': '恢复原文',
      'action.clean': '清理',
      'action.cleanConfirm': '确认清理',

      'output.title': '最近一次命令输出',
      'output.empty': '暂无输出',

      'error.noSession': '当前会话不可用，无法执行命令',
      'error.noRemote': '命令通道尚未就绪，请稍后重试',
      'error.empty': '命令没有返回结果',
      'error.unknownCommand': '命令没有返回结果（可能是未知命令）',
      'error.transport': '执行失败：{message}'
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

      'action.now': 'Cool now',
      'action.dryRun': 'Dry run',
      'action.restore': 'Restore text',
      'action.clean': 'Clean up',
      'action.cleanConfirm': 'Confirm cleanup',

      'output.title': 'Last command output',
      'output.empty': 'No output yet',

      'error.noSession': 'No usable session for this command',
      'error.noRemote': 'The command channel is not ready yet, try again shortly',
      'error.empty': 'The command returned no result',
      'error.unknownCommand': 'The command returned no result (unknown command?)',
      'error.transport': 'Command failed: {message}'
    };
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
      + '.mcl-pop{position:absolute;bottom:calc(100% + 8px);left:0;z-index:40;box-sizing:border-box;width:320px;max-height:min(420px,60vh);overflow-y:auto;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:var(--dsw-radius-lg);padding:12px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}'
      + '.mcl-row{display:flex;align-items:center;gap:8px;min-height:28px}'
      + '.mcl-label{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}'
      + '.mcl-status{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
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
      + '.mcl-output{box-sizing:border-box;max-height:96px;overflow:auto;margin:0;padding:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}';

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

      /** 焦点离开整块（含弹层内部）才收起；点击弹层内的控件不会误关。 */
      function onBlur(event) {
        var next = event.relatedTarget;
        var wrap = event.currentTarget;
        if (next != null && wrap != null && typeof wrap.contains === 'function' && wrap.contains(next)) return;
        close();
      }

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
        h('span', {
          className: 'mcl-wrap',
          key: 'chip',
          onBlur: onBlur,
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

      var retainPair = React.useState(String(retain));
      var retainDraft = retainPair[0];
      var setRetainDraft = retainPair[1];
      var batchPair = React.useState(String(batch));
      var batchDraft = batchPair[0];
      var setBatchDraft = batchPair[1];
      var cleanPair = React.useState(false);
      var cleanArmed = cleanPair[0];
      var setCleanArmed = cleanPair[1];

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
        ? t('panel.status.on') + ' · ' + (auto ? t('panel.status.auto') : t('panel.status.manual'))
          + ' · ' + t('panel.status.archived', { count: archived })
        : t('panel.status.off');

      var rows = [];

      rows.push(h('div', { className: 'mcl-row', key: 'enable' },
        h('span', { className: 'mcl-label' }, t('panel.enable')),
        switchNode(enabled, t('panel.enable'), busy, function (next) {
          run(next ? '/memory-lab on' : '/memory-lab off');
        }),
        h('span', { className: 'mcl-status', title: statusText }, statusText)));

      rows.push(h('div', { className: 'mcl-row', key: 'retain' },
        h('span', { className: 'mcl-label' }, t('field.retain')),
        h('span', { className: 'mcl-field' },
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            autoComplete: 'off',
            className: 'mcl-input',
            value: retainDraft,
            disabled: busy,
            'aria-label': t('field.retain'),
            title: t('field.retain'),
            onChange: function (event) { setRetainDraft(event.target.value); },
            onBlur: commitRetain,
            onKeyDown: onEnter
          }))));

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

      rows.push(h('div', { className: 'mcl-actions', key: 'actions' },
        secondaryButton(t('action.now'), busy, false, function () { run('/memory-lab now'); }),
        secondaryButton(t('action.dryRun'), busy, false, function () { run('/memory-lab dry-run'); }),
        secondaryButton(t('action.restore'), busy, false, function () { run('/memory-lab restore'); }),
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
      }, store.status != null ? store.status : t('output.empty')));

      return h('div', { className: 'mcl-pop', key: 'pop' }, rows);
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
    }
    //#endregion

    exports.apply = apply;
    // `remote`/`remote.commands` 是宿主 Web 外壳的常驻服务（ui-plan 徽章同样声明它们），
    // 声明后激活顺序正确；组件仍在调用期解析，缺通道时显示一行可读错误而不是整块消失。
    exports.inject = ['slots', 'locale', 'remote', 'remote.commands'];
    return module.exports;
  }
});

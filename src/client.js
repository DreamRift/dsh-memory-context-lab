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
      'panel.status.archived': '归档 {count}',
      'field.batch': '攒够几个再归档',
      'field.pressure': '压力闸门',
      'field.pressureHint': '开启后，上下文占用率达到右侧百分比才自动归档；关闭 = 无压力也降温（旧行为，低占用时通常不划算）',
      'field.autorestore': '停用时恢复原文',
      'field.planFirst': '新会话计划先行',
      'field.planFirstHint': '开启后：全新对话第一条消息即自动进入宿主「计划模式」（经 plan/mode 日志落账），计划期间降温/回注挂起；用户批准计划后自动启用上下文降温，计划全文作为指引常驻、全程不归档',
      'field.compress': '层级压缩',
      'field.compressHint': '层级压缩：把归档记录聚合成 L1/L2 层级卡；关闭后冷库只按记录 ID 回读',
      'field.readlease': '读取租约',
      'field.readleaseHint': '最近 N 个含读取结果的操作额外保留（2N 步后自动失效），0 = 关闭',
      'field.compressModel': '层级压缩模型模式',
      'field.compressModelHint': '层级压缩（/memory-lab compress）启用时，聚合摘要先经注入的 LLM 改写并逐条对回 L0 校验；无模型、鉴权失败、限流、超时、超预算或校验不过时自动落回程序摘要，取消/关闭/阶段重开/来源过期是任务撤销',
  'field.shareL2Content': '层级卡共享正文摘录',
  'field.shareL2ContentHint': '默认关：L1 证据卡与 L2 阶段卡只给属性、来源 ID 与展开入口，不复制成员正文；开启后卡片才带正文摘录（正文仍只经 expand/read 显式展开）',

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
      'error.transport': '执行失败：{message}',    };

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
      'panel.status.archived': '{count} archived',
      'field.batch': 'Archive after N pile up',
      'field.pressure': 'Pressure gate',
      'field.pressureHint': 'When on, archiving starts only once context occupancy reaches the percentage on the right; off = cool regardless of pressure (the old behaviour, usually a net loss at low occupancy)',
      'field.autorestore': 'Restore text when stopping',
      'field.planFirst': 'Plan first in new sessions',
  'field.shareL2Content': 'Share excerpts in hierarchy cards',
  'field.shareL2ContentHint': 'Default off: L1 evidence cards and L2 phase cards carry only attributes, source IDs and expand entries — no member text. Turn on to include excerpt values (originals still require an explicit expand/read)',
      'field.compressModel': 'Hierarchy compression model mode',
  'field.compress': 'Hierarchical compression',
  'field.compressHint': 'Aggregates archived records into L1/L2 hierarchy cards; when off, the cold store answers by record ID only',
  'field.readlease': 'Read lease',
  'field.readleaseHint': 'Keeps the last N read-bearing operations alive (expires after 2N steps); 0 = off',
  'field.compressModelHint': 'Phase summaries are generated by the model: every claim must trace back to exact L0 values; falls back to program summaries when unverified or unavailable (default off)',
  'field.planFirstHint': 'When on, the first message of a brand-new conversation automatically enters host plan mode (via plan/mode log commit); cooling/recall pause while planning, and context cooling auto-enables once the plan is approved, with the plan text kept resident as guidance and never archived',

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
      'error.transport': 'Command failed: {message}',    };
    //#endregion

    //#region 全局配置（设置页）读取
    /**
     * 宿主设置域（settings）与配置表单（configForms）的只读辅助。
     * 两者都按「可选能力」对待：拿不到时降温 chip 与命令照常工作，
     * 仅弹层的预设列表退化为只有「全局预设」、设置页卡片不注册。
     */
    var CONFIG_NS = 'memory-context-lab';
    // 压力闸门默认阈值（与 core.mjs 的 DEFAULT_SETTINGS.pressureGate 同源）。
    // 客户端不能 import 服务端常量（不同 bundle），所以这里是一个显式副本，
    // 由 config-contract 测试断言两者相等。
    var DEFAULT_PRESSURE = 20;
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

    // 预设已删除（0.13.1）：面板不再需要预设列表，原先的读取/归一化助手已一并删除。
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

    /**
     * 严格十进制非负整数；非法输入返回 null（M-01 / R-08，0.13.2-beta.5）。
     *
     * 只认 `/^\d+$/`——与命令面的 `parseStrictInteger` 是**同一把尺子**。旧实现用
     * `Number()`：`Number('')`===0、`Number('2.5')`===2.5、`Number('0x10')`===16、
     * `Number('2e1')`===20，全都 isFinite，于是设置页成了唯一一个「把非法输入变成
     * 另一个合法值」的入口——最危险的那一种（清空输入框 = 把阈值改成最激进的值）。
     */
    function parseCount(text) {
      if (typeof text !== 'string') return null;
      var raw = text.trim();
      if (raw.length === 0) return null;
      if (!/^\d+$/.test(raw)) return null;
      var value = Number(raw);
      if (!isFinite(value) || Math.floor(value) !== value) return null;
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
      var autoRestore = boolOf(view != null ? view.autoRestore : undefined, true);
      var batch = countOf(view != null ? view.archiveBatchSize : undefined);
      var archived = countOf(view != null ? view.archived : undefined);
      var engine = view != null && typeof view.engine === 'string' ? view.engine : '';
      var fullHistory = boolOf(view != null ? view.fullHistory : undefined, false);
      var planFirst = boolOf(view != null ? view.planFirst : undefined, false);
      var compressModel = boolOf(view != null ? view.compressModel : undefined, false);
      var shareL2Content = boolOf(view != null ? view.shareL2Content : undefined, false);
      var compressOn = boolOf(view != null ? view.hierarchyCompress : undefined, false);
      // P2.5 缺口 2：读取租约（0–50，NUMERIC_SETTINGS.readlease 同域；0 = 关闭）。
      var readLease = countOf(view != null ? view.retainReads : undefined);
      var planActive = boolOf(view != null ? view.planActive : undefined, false);
      // 0.13.0 压力闸门：0 = 无压力也降温（旧行为），>0 = 达到该占用率才归档。
      // 面板把它渲染成「开关 + 阈值」：开关关闭即写 0。
      var pressure = countOf(view != null ? view.pressureGate : undefined);
      var pressureOn = pressure > 0;


      var batchPair = React.useState(String(batch));
      var batchDraft = batchPair[0];
      var setBatchDraft = batchPair[1];
      // 闸门阈值草稿：闸门关闭（0）时输入框置灰，但仍保留上一次的非零值，
      // 这样重新打开开关不会把用户设过的阈值丢掉。
      var pressurePair = React.useState(String(pressure > 0 ? pressure : DEFAULT_PRESSURE));
      var pressureDraft = pressurePair[0];
      var setPressureDraft = pressurePair[1];
      var readLeasePair = React.useState(String(readLease));
      var readLeaseDraft = readLeasePair[0];
      var setReadLeaseDraft = readLeasePair[1];
      var cleanPair = React.useState(false);
      var cleanArmed = cleanPair[0];
      var setCleanArmed = cleanPair[1];


      // 投影值真正变化时（一次成功提交之后）回灌草稿；依赖是原始值，
      // 因此宿主每帧推新对象也不会把用户正在输入的内容冲掉。

      React.useEffect(function () {
        setPressureDraft(String(pressure > 0 ? pressure : DEFAULT_PRESSURE));
      }, [pressure]);
      React.useEffect(function () {
        setBatchDraft(String(batch));
      }, [batch]);
      React.useEffect(function () {
        setReadLeaseDraft(String(readLease));
      }, [readLease]);

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


      function commitBatch() {
        var parsed = parseCount(batchDraft);
        if (parsed == null) {
          setBatchDraft(String(batch));
          return;
        }
        if (parsed === batch) return;
        run('/memory-lab set batch ' + String(parsed));
      }

      function commitReadLease() {
        var parsed = parseCount(readLeaseDraft);
        if (parsed == null || parsed > 50) {
          setReadLeaseDraft(String(readLease));
          return;
        }
        if (parsed === readLease) return;
        run('/memory-lab set readlease ' + String(parsed));
      }

      function commitPressure() {
        var parsed = parseCount(pressureDraft);
        // 0 在面板上是「关」的语义，由开关表达；输入框只接受 1..95。
        if (parsed == null || parsed < 1 || parsed > 95) {
          setPressureDraft(String(pressure > 0 ? pressure : DEFAULT_PRESSURE));
          return;
        }
        if (parsed === pressure) return;
        run('/memory-lab set pressure ' + String(parsed));
      }

      function onEnter(event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        var el = event.target;
        if (el != null && typeof el.blur === 'function') el.blur();
      }

      // 0.13.0：全历史是唯一模式，「自动降温」由压力闸门取代——状态行改成
      // 「降温状态 · 压力闸门（阈值/关）· 已归档 · 计划中」。
      var pressureLabel = pressureOn
        ? t('field.pressure') + ' ≥' + pressure + '%'
        : t('field.pressure') + ' ' + t('panel.status.off')
      var statusText = enabled
        ? t('panel.status.on') + (engine === 'v2' ? ' · ' + t('panel.status.v2') : '')
          + ' · ' + pressureLabel
          + ' · ' + t('panel.status.archived', { count: archived })
          + (planActive ? ' · ' + t('panel.status.planActive') : '')
        : t('panel.status.off');

      // rc.5：状态信息从开关后移到底部输出框（原「暂无输出」位）。
      // 摘要恒显：降温状态行 + 计划先行行；最近一次命令输出追加其下。
      var statusSummary = [
        statusText,
        planFirst
          ? (planActive ? t('panel.status.planActive') : t('panel.status.on')) + ' · ' + t('field.planFirst')
          : t('panel.status.off') + ' · ' + t('field.planFirst')
      ].join('\n');

      // 0.13.1 删除了预设功能：命令面已无对应子命令，面板也不再提供下拉框。
      // 旧会话日志里的 preset 命令仍会被投影折叠（foldCommandIntoState），所以
      // `view.preset` 保留在视图里——只是不再有入口去改它。
      var rows = [];

      rows.push(h('div', { className: 'mcl-row', key: 'enable' },
        h('span', { className: 'mcl-label' }, t('panel.enable')),
        switchNode(enabled, t('panel.enable'), busy, function (next) {
          run(next ? '/memory-lab on' : '/memory-lab off');
        })));

      // 0.13.0 瘦身：删除「保留最近操作」「全历史记忆上下文」两行。
      // 前者已成死开关（全历史模式下恒为 0），后者是唯一模式、不再需要开关。
      //
      // 新会话计划先行：插件级开关（从会话日志折叠，两个引擎通用）。
      // 「on」由宿主侧联动进入计划模式（仅全新会话；非全新会话由命令输出提示）。
      rows.push(h('div', { className: 'mcl-row', key: 'planFirst' },
        h('span', { className: 'mcl-label', title: t('field.planFirstHint') }, t('field.planFirst')),
        switchNode(planFirst, t('field.planFirst'), busy, function (next) {
          run('/memory-lab set planfirst ' + (next ? 'on' : 'off'));
        })));

      // P2.5-1 缺口 1：层级压缩默认开、改变冷库回读形态，此前只有命令逃生口；
      // 且 compressOn=false 时它挡着 compressmodel/sharel2content 两行的可见性。
      // 开关行放 if 外——关了也能看到并重新打开。
      rows.push(h('div', { className: 'mcl-row', key: 'compress' },
        h('span', { className: 'mcl-label', title: t('field.compressHint') }, t('field.compress')),
        switchNode(compressOn, t('field.compress'), busy, function (next) {
          run('/memory-lab set compress ' + (next ? 'on' : 'off'));
        })));

      // 层级压缩模型模式（P4）：仅 v2 会话显示；只发偏好命令，模型不可用时
      // 由失败关闭阶梯落回程序摘要，面板不预判宿主契约。
      if (engine === 'v2' && compressOn) {
        rows.push(h('div', { className: 'mcl-row', key: 'compressModel' },
          h('span', { className: 'mcl-label', title: t('field.compressModelHint') }, t('field.compressModel')),
          switchNode(compressModel, t('field.compressModel'), busy, function (next) {
            run('/memory-lab set compressmodel ' + (next ? 'on' : 'off'));
          })));
        // T1/F-03：层级卡是否共享正文摘录（默认关）。只发偏好命令，卡片渲染
        // 由后端按开关决定；面板不预判内容。
        rows.push(h('div', { className: 'mcl-row', key: 'shareL2Content' },
          h('span', { className: 'mcl-label', title: t('field.shareL2ContentHint') }, t('field.shareL2Content')),
          switchNode(shareL2Content, t('field.shareL2Content'), busy, function (next) {
            run('/memory-lab set sharel2content ' + (next ? 'on' : 'off'));
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

      // P2.5 缺口 2：readlease 数字项（0–50；任务书 200 为笔误，真源
      // NUMERIC_SETTINGS.readlease 上界 50——语义一律不改）。
      rows.push(h('div', { className: 'mcl-row', key: 'readlease' },
        h('span', { className: 'mcl-label', title: t('field.readleaseHint') }, t('field.readlease')),
        h('span', { className: 'mcl-field' },
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            autoComplete: 'off',
            className: 'mcl-input',
            value: readLeaseDraft,
            disabled: busy,
            'aria-label': t('field.readlease'),
            title: t('field.readleaseHint'),
            onChange: function (event) { setReadLeaseDraft(event.target.value); },
            onBlur: commitReadLease,
            onKeyDown: onEnter
          }))));

      // 0.13.0：删除「自动降温」「自动回注」两行。
      // 「自动降温」由下面的压力闸门取代（闸门 0 = 无压力也降温，即旧行为）；
      // 「自动回注」恒开——它是取回闭环的一部分，不是一个应该被关掉的选项。
      //
      // 压力闸门：开关 + 阈值。开关关闭 = 阈值 0 = 无压力也降温（旧行为）。
      // 闸门是 v1/v2 **共用**的引擎判据（apply-engine 的 runAutoCooling），
      // 所以命令前缀按会话引擎分流；未启用降温时置灰（无会话可写设置）。
      rows.push(h('div', { className: 'mcl-row', key: 'pressure' },
        h('span', { className: 'mcl-label', title: t('field.pressureHint') }, t('field.pressure')),
        h('span', { className: 'mcl-field' },
          switchNode(pressureOn, t('field.pressure'), busy || !enabled, function (next) {
            run('/memory-lab set pressure ' + (next ? String(pressureDraft || DEFAULT_PRESSURE) : '0'));
          }),
          h('input', {
            type: 'text',
            inputMode: 'numeric',
            spellCheck: false,
            autoComplete: 'off',
            className: 'mcl-input',
            value: pressureDraft,
            disabled: busy || !enabled || !pressureOn,
            'aria-label': t('field.pressure'),
            title: t('field.pressureHint'),
            onChange: function (event) { setPressureDraft(event.target.value); },
            onBlur: commitPressure,
            onKeyDown: onEnter
          }))));

      rows.push(h('div', { className: 'mcl-row', key: 'autorestore' },
        h('span', { className: 'mcl-label' }, t('field.autorestore')),
        switchNode(autoRestore, t('field.autorestore'), busy, function (next) {
          run('/memory-lab set autorestore ' + (next ? 'on' : 'off'));
        })));

      // 0.13.1 只有一个引擎，维护动作不再按引擎分流（删 v1 时留下的三元表达式两边相同）。
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
          // 「清理」= 丢弃本会话隔离冷库。命令要求两道确认词，少一个只回用法。
          run('/memory-lab clean confirm delete-session');
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
      // N-08a：宿主把 `.volatile()` 字段以**引用对象**交出（只有 get()），直接读属性
      // 一律 undefined → 每个字段都回落到硬编码兜底值。于是设置页显示的是默认值，
      // 「改了的那一项」看起来自己跳回；而保存写回的也是这份兜底值，会把用户改过的
      // 其它项静默抹掉。读取侧与保存侧都走本函数，解引用一次即可两边同时修好。
      if (inner != null && typeof inner.get === 'function') {
        var unwrapped = inner.get();
        if (unwrapped && typeof unwrapped === 'object') inner = unwrapped;
      }
      // N-09（beta.4）：以 inner 为底，只覆盖认识的字段——未知/未来字段原样透传。
      // 以前这里是白名单构造：schema 里加了字段而这里没同步，用户只要在设置页动
      // 任何一项并保存，那个字段就被静默抹回默认值（protectBudgetTokens 与
      // retrievalBackend 就这么丢过，而设置页根本不显示它们）。宿主用这份对象
      // 整体替换 defaults，所以「读得到」还不够，必须「写得回」。
      var base = inner != null && typeof inner === 'object' ? inner : {};
      var out = {};
      for (var key in base) {
        if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
      }
      // 兜底字面量与 src/core.mjs 的 DEFAULT_SETTINGS 对齐（独立 bundle 无法 import
      // 后端模块，由 config-contract 测试守卫防止两处漂移）：retain=5，batch=10。
      out.retainOperations = clampInt(base.retainOperations, 0, 200, 5);
      out.archiveBatchSize = clampInt(base.archiveBatchSize, 1, 200, 10);
      // 0.13.1：闸门阈值也在设置里（schema 有 default）。
      out.pressureGate = clampInt(base.pressureGate, 0, 95, DEFAULT_PRESSURE);
      out.auto = base.auto !== false;
      out.autoRecall = base.autoRecall !== false;
      out.autoRestore = base.autoRestore !== false;
      // 开关位：缺省 false（与投影初始值一致，避免「卡片显示开、会话显示关」）。
      out.fullHistory = base.fullHistory === true;
      out.planFirst = base.planFirst === true;
      // 层级压缩模型模式默认（P4）：只作 v2 新账本播种值，会话内开关以命令为准。
      out.compressModelDefault = base.compressModelDefault === true;
      // T1/F-03：层级卡共享正文摘录的全局默认（失败关闭：缺省 false）。
      out.shareL2Content = base.shareL2Content === true;
      // P2.5：读取租约（0–50，缺省 3 与 DEFAULT_SETTINGS 同域）。
      out.retainReads = clampInt(base.retainReads, 0, 50, 3);
      // P2.5：软保护预算（schema protectBudgetTokens 同域，缺省 32768）。
      out.protectBudgetTokens = clampInt(base.protectBudgetTokens, 0, 2000000, 32768);
      return out;
    }

    /** 把 Config 值收敛成卡片草稿：{ defaults }。预设已删除（0.13.1），schema 里没有 presets。 */
    function draftFromValue(value) {
      var source = value && typeof value === 'object' ? value : {};
      return { defaults: settingsValueOf(source.defaults) };
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
      // M-01（0.13.2-beta.5）：commit 与 parseCount 同一把尺子——只认 /^\d+$/。
      // 旧实现是 Math.round(Number(text))：清空输入框被当成 0（再夹到下界，等于把
      // 阈值改成最激进的值）、2.5 静默变 3、0x10 变 16、2e1 变 20。非法输入一律
      // **回落原值且不提交**；越界仍按 clampInt 夹取（既有设计，不是缺陷）。
      var commit = function () {
        var n = parseCount(text);
        if (n === null) {
          setText(String(value));
          if (typeof props.onReject === 'function') props.onReject(text);
          return;
        }
        var next = clampInt(n, min, max, value);
        // 输入框显示收敛后的值：用户看到的就是落盘的那个数，不留「显示 999、存的 200」。
        setText(String(next));
        if (next !== value) props.onCommit(next);
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

    function numberInputNode(value, min, max, disabled, onCommit, onReject) {
      return h(NumberInput, {
        value: value,
        min: min,
        max: max,
        disabled: disabled,
        onCommit: onCommit,
        onReject: onReject
      });
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


    /**
     * 设置页卡片：读写本插件 Config 命名空间的 defaults（预设已删除，schema 里没有 presets）。
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

      // 0.13.1 修复（B）：宿主用**同一个组件**渲染两个座位——描述行传
      // `{ view: 'summary' }` 且刻意不带 form，设置区传 `{ view: 'page', form }`。
      // 所以 summary 没有 form 是正常形态，不是「命名空间未服务」：原来的实现
      // 在判断 view 之前就因 !snapshot 早退，把视图差异写成了宿主故障，
      // 结果详情页常驻一行「配置加载中…」，而下方设置卡其实工作正常。
      // 这个分支必须在快照早退之前——两处都在 hooks 之后，早退是安全的。
      if (view === 'summary') {
        return h('span', { className: 'mcl-card-hint' }, '上下文降温：全局默认与预设');
      }
      if (!snapshot) {
        return h('div', { className: 'mcl-card' },
          h(StyleTag, { key: 'style' }),
          h('p', { className: 'mcl-card-hint' }, '设置尚未就绪：宿主未提供本插件的设置表单。'));
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

      /**
       * 数字框拒绝非法输入时的提示（M-01）：旧实现静默回落原值，用户看不出自己
       * 的输入没被接受。提示必须说清「接受了什么形态」与「值没变」。
       */
      var rejectCount = function (label, min, max) {
        return function (raw) {
          setError(label + '只接受 ' + min + '..' + max + ' 的整数（收到 "' + String(raw) + '"），已保留原值。');
        };
      };

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
            }, rejectCount('保留最近操作', 0, 200)),
            h('span', { className: 'mcl-card-hint' }, '归档批量'),
            numberInputNode(current.defaults.archiveBatchSize, 1, 200, busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { archiveBatchSize: v }) });
              });
            }, rejectCount('归档批量', 1, 200)),
            // 0.13.1：闸门阈值的第二个入口（面板之外）——只坏面板时这里仍可配。
            h('span', { className: 'mcl-card-hint' }, '压力闸门 %'),
            numberInputNode(current.defaults.pressureGate, 0, 95, busy, function (v) {
              wrapSet(function (prev) {
                return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { pressureGate: v }) });
              });
            }, rejectCount('压力闸门', 0, 95)),
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
          // P2.5 缺口 3：软保护预算——高级参数放设置页不放弹层；schema 已有
          // protectBudgetTokens（0..2,000,000，default 32768），0.13.1 白名单抹字段
          // 的旧案由 sanitizeSettingsView 透传 + settings-key-coverage 守卫把关。
          h('div', { className: 'mcl-card-row' },
            h(NumberInput, {
              value: current.defaults.protectBudgetTokens,
              min: 0,
              max: 2000000,
              disabled: busy,
              label: '软保护预算（token）',
              onReject: rejectCount('软保护预算', 0, 2000000),
              onCommit: function (n) {
                wrapSet(function (prev) {
                  return Object.assign({}, prev, { defaults: Object.assign({}, prev.defaults, { protectBudgetTokens: n }) });
                });
              },
            }),
            h('span', { className: 'mcl-card-hint' }, '软保护预算（token）：超预算按最弱先释放；硬保护不受影响')),
          h('p', { className: 'mcl-card-hint' }, '这些是**新会话**的初始值（预设功能已删除，没有「全局预设」可选）；已启用会话的开关仍以会话内命令为准。')),
        // 预设已删除（0.13.1）：Config schema 不再有 presets，设置页也不再提供编辑器。
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

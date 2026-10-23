/**
 * 窗口守卫拒绝文案的**唯一**来源（0.13.2-beta.6 G3）。
 *
 * 单独成文件的原因：它被 runtime-lifecycle（off 路径）与 runtime-settings
 * （set fullhistory off 路径）同时使用，而 runtime-lifecycle 已贴着
 * runtime-module-budget 的 800 行上限——两处各写一份又会退化成
 * 「注释即规格、实现各一份」的老毛病。
 *
 * 三态引入后，「超窗」与「判不了」是两种不同结局，回执必须分开说：
 * 把「我不知道你的窗口多大」印成「你超窗了」，就是在用不确定冒充确定——
 * 用户会去删上下文，而真正的修复可能是重新测量一次。
 */
export function describeWindowGuardRefusal(refusal, growth) {
  if (refusal?.undetermined) {
    const missing = (refusal.unknownReasons ?? []).join('、') || '窗口或占用量'
    return `无法判定恢复是否超出模型窗口（${missing} 不可用：当前约 ${refusal.assembled ?? '未知'} + 待恢复约 ${growth}，窗口 ${refusal.window ?? '未知'}），按失败关闭处理`
  }
  return `恢复会让组装输入超出模型窗口（当前约 ${refusal.assembled} + 待恢复约 ${growth} > 窗口 ${refusal.window}）`
}

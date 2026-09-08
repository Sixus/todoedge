/**
 * 面板透明度（%）：60~95 无极调节，数字越大面板越「实」。
 * 贴边透明面板、窗口模式「普通透明」底色与收起细条共用一个值；
 * 实体材质本就不透明、窗口亚克力浓度由系统材质决定，均不随滑杆。
 * 存 settings 表，启动恢复，拖动即时生效。
 */
export const PANEL_OPACITY_SETTING_KEY = "panel_opacity";

/** 默认 = 功能可配置前贴边透明档写死的 70% */
export const DEFAULT_PANEL_OPACITY = 70;
export const MIN_PANEL_OPACITY = 60;
export const MAX_PANEL_OPACITY = 95;

/** 写 :root 上的 --panel-alpha（0~1 小数），theme.css 的面板底色与细条浓度跟随 */
export function applyPanelOpacity(percent: number): void {
  document.documentElement.style.setProperty(
    "--panel-alpha",
    String(percent / 100),
  );
}

/** settings 读出的字符串 → 合法百分比：非整数回默认，越界钳回边界 */
export function normalizePanelOpacity(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_PANEL_OPACITY;
  }
  return Math.min(MAX_PANEL_OPACITY, Math.max(MIN_PANEL_OPACITY, parsed));
}

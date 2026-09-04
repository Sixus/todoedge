/**
 * 贴边时机设置（毫秒）：鼠标悬停细条多久滑出、鼠标离开面板多久收回。
 * 存 settings 表（仅贴边模式生效，窗口模式面板常驻无滑出/收回）。
 */
export const HOVER_EXPAND_DELAY_SETTING_KEY = "hover_expand_delay_ms";
export const LEAVE_COLLAPSE_DELAY_SETTING_KEY = "leave_collapse_delay_ms";

/** 默认值 = 功能可配置前写死的两个数（docs/01 第 4 节状态机） */
export const DEFAULT_HOVER_EXPAND_MS = 400;
export const DEFAULT_LEAVE_COLLAPSE_MS = 1500;

export const MIN_HOVER_EXPAND_MS = 100;
export const MAX_HOVER_EXPAND_MS = 2000;
export const MIN_LEAVE_COLLAPSE_MS = 500;
export const MAX_LEAVE_COLLAPSE_MS = 10000;

/** settings 读出的字符串 → 合法毫秒数：非整数回默认，越界钳回边界 */
export function normalizeDelayMs(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

/** 输入框失焦兜底：把任意整数钳进合法区间 */
export function clampDelayMs(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

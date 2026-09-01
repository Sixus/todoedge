/** 全局热键（M3-3）：设置表键名 + 录入辅助（组合串生成、展示格式化） */

export const HOTKEY_SETTING_KEY = "global_hotkey";
export const DEFAULT_HOTKEY = "Alt+T";

/** 纯修饰键的 event.code：单按不构成组合，录入时忽略等待下一个键 */
const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
  "Fn",
  "FnLock",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/**
 * 把按键事件拼成插件可解析的组合串。
 * event.code 是物理键名（KeyT/Digit1/F5/Space…），与 global-hotkey
 * 解析器的键名一一对应；修饰键 token 须排在主键前（解析器要求）。
 * Win 键发 "Super"（解析器不认 "Win"）。
 */
export function buildHotkeyCombo(
  code: string,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  meta: boolean,
): string {
  const tokens: string[] = [];
  if (ctrl) tokens.push("Ctrl");
  if (alt) tokens.push("Alt");
  if (shift) tokens.push("Shift");
  if (meta) tokens.push("Super");
  tokens.push(code);
  return tokens.join("+");
}

/** 组合串是否带 Ctrl/Alt/Win 之一（Shift 单独会劫持普通打字，不算热键） */
export function hasUsableModifier(combo: string): boolean {
  const tokens = combo.split("+");
  return (
    tokens.includes("Ctrl") || tokens.includes("Alt") || tokens.includes("Super")
  );
}

/** 录入串转展示文案："Ctrl+Alt+KeyT" → "Ctrl+Alt+T"，"Super" → "Win" */
export function formatHotkey(hotkey: string): string {
  return hotkey
    .split("+")
    .map((token) => {
      const key = token.toLowerCase();
      const letter = key.match(/^key([a-z])$/);
      if (letter) {
        return letter[1].toUpperCase();
      }
      const digit = key.match(/^digit([0-9])$/);
      if (digit) {
        return digit[1];
      }
      if (key === "super") {
        return "Win";
      }
      return token;
    })
    .join("+");
}

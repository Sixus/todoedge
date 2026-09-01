/** 深浅模式：auto 跟随系统（实时），light/dark 手动固定；写入 html[data-theme] 驱动 theme.css */
export type ThemeMode = "auto" | "light" | "dark";

export const THEME_SETTING_KEY = "theme";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

let currentMode: ThemeMode = "auto";

function resolved(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    return darkQuery.matches ? "dark" : "light";
  }
  return mode;
}

/** 应用深浅模式（auto 先按当前系统解析）；设置启动恢复与手动切换都走这里 */
export function applyTheme(mode: ThemeMode): void {
  currentMode = mode;
  document.documentElement.dataset.theme = resolved(mode);
}

export function normalizeTheme(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "auto";
}

// auto 模式下系统深浅变化实时跟随；手动固定时不响应
darkQuery.addEventListener("change", () => {
  if (currentMode === "auto") {
    document.documentElement.dataset.theme = resolved("auto");
  }
});

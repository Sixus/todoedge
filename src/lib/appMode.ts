/** 运行模式：贴边（吸附右缘细条，现状） / 窗口（普通窗口 + 系统级毛玻璃背景） */
export type AppMode = "edge" | "window";

export const APP_MODE_SETTING_KEY = "app_mode";

/** 写 html[data-app-mode]，窗口模式下面板底色用更淡的半透明层透出毛玻璃 */
export function applyAppMode(mode: AppMode): void {
  document.documentElement.dataset.appMode = mode;
}

export function normalizeAppMode(value: string | null): AppMode {
  return value === "window" ? "window" : "edge";
}

/** 窗口模式背景材质：系统毛玻璃（DWM blur）/ 普通透明（纯逐像素透色） */
export type WindowMaterial = "blur" | "clear";

export const WINDOW_MATERIAL_SETTING_KEY = "window_material";

export function normalizeWindowMaterial(value: string | null): WindowMaterial {
  return value === "clear" ? "clear" : "blur";
}

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

/** 窗口模式背景材质：acrylic=Win11 系统亚克力（推荐）/ blur=旧版毛玻璃
    （Win11 上发黑、拖动卡顿，仅 Win10 用）/ clear=普通透明（纯逐像素透色） */
export type WindowMaterial = "acrylic" | "blur" | "clear";

export const WINDOW_MATERIAL_SETTING_KEY = "window_material";

/** 写 html[data-window-material]，CSS 据此调整面板底色浓度 */
export function applyWindowMaterial(material: WindowMaterial): void {
  document.documentElement.dataset.windowMaterial = material;
}

export function normalizeWindowMaterial(value: string | null): WindowMaterial {
  return value === "blur" || value === "clear" ? value : "acrylic";
}

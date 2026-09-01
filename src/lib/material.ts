/** 外观材质：透明玻璃（默认）/ 实体不透明，驱动 html[data-material] 切换 CSS 变量组 */
export type Material = "glass" | "solid";

export const MATERIAL_SETTING_KEY = "material";
export const SNOOZE_SETTING_KEY = "snooze_minutes";
export const ANIMATIONS_SETTING_KEY = "animations";

export function applyMaterial(material: Material): void {
  document.documentElement.dataset.material = material;
}

export function normalizeMaterial(value: string | null): Material {
  return value === "solid" ? "solid" : "glass";
}

import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import {
  ANIMATIONS_SETTING_KEY,
  applyMaterial,
  MATERIAL_SETTING_KEY,
  normalizeMaterial,
  SNOOZE_SETTING_KEY,
  type Material,
} from "../lib/material";

interface SettingsViewProps {
  onClose: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 面板内嵌设置视图（点齿轮覆盖在面板上，‹ 返回清单）。
 * 排版遵循 Windows 11 设置样式：卡片行 + 主标签 + 次级说明 + 右侧控件。
 * 改动即存：外观/间隔写 settings 表；自启走 tauri-plugin-autostart。
 */
export function SettingsView({ onClose }: SettingsViewProps) {
  const [material, setMaterial] = useState<Material>("glass");
  const [snoozeMinutes, setSnoozeMinutes] = useState("10");
  const [animations, setAnimations] = useState(true);
  const [autostart, setAutostart] = useState(false);
  const [autostartPending, setAutostartPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const savedMaterial = normalizeMaterial(await api.getSetting(MATERIAL_SETTING_KEY));
        setMaterial(savedMaterial);
        applyMaterial(savedMaterial);
        const savedSnooze = await api.getSetting(SNOOZE_SETTING_KEY);
        if (savedSnooze !== null && savedSnooze !== "") {
          setSnoozeMinutes(savedSnooze);
        }
        const savedAnimations = await api.getSetting(ANIMATIONS_SETTING_KEY);
        setAnimations(savedAnimations !== "0");
        setAutostart(await api.autostartStatus());
      } catch (cause) {
        setError(errorMessage(cause));
      }
    })();
  }, []);

  // 外观与设置视图在同一文档里，applyMaterial 即时作用于面板本身
  const changeMaterial = useCallback((next: Material) => {
    setMaterial(next);
    applyMaterial(next);
    void api.setSetting(MATERIAL_SETTING_KEY, next).catch((cause) => {
      setError(errorMessage(cause));
    });
  }, []);

  const changeSnooze = useCallback((value: string) => {
    setSnoozeMinutes(value);
    const minutes = Number(value);
    if (Number.isInteger(minutes) && minutes >= 1) {
      void api.setSetting(SNOOZE_SETTING_KEY, String(minutes)).catch((cause) => {
        setError(errorMessage(cause));
      });
    }
  }, []);

  const changeAnimations = useCallback((enabled: boolean) => {
    setAnimations(enabled);
    void api.setSetting(ANIMATIONS_SETTING_KEY, enabled ? "1" : "0").catch((cause) => {
      setError(errorMessage(cause));
    });
    void api.setPanelAnimations(enabled).catch((cause) => {
      setError(errorMessage(cause));
    });
  }, []);

  const changeAutostart = useCallback((enabled: boolean) => {
    setAutostartPending(true);
    void api
      .setAutostart(enabled)
      .then(() => setAutostart(enabled))
      .catch(() => setError("开机自启设置失败"))
      .finally(() => setAutostartPending(false));
  }, []);

  return (
    <div className="settings-overlay">
      <header className="settings-header">
        <button
          aria-label="返回任务清单"
          className="settings-back"
          onClick={onClose}
          title="返回"
          type="button"
        >
          ‹
        </button>
        <h1 className="settings-title">设置</h1>
      </header>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">外观</p>
          <p className="settings-desc">透明玻璃或实体不透明，即时生效</p>
        </div>
        <div className="settings-segment" role="radiogroup" aria-label="外观">
          <button
            aria-checked={material === "glass"}
            className={material === "glass" ? "active" : ""}
            onClick={() => changeMaterial("glass")}
            role="radio"
            type="button"
          >
            透明
          </button>
          <button
            aria-checked={material === "solid"}
            className={material === "solid" ? "active" : ""}
            onClick={() => changeMaterial("solid")}
            role="radio"
            type="button"
          >
            实体
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">稍后提醒间隔</p>
          <p className="settings-desc">点通知里的「稍后提醒」后，隔多久再次提醒</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5">
          <input
            aria-label="稍后提醒间隔（分钟）"
            className="settings-number"
            max="1440"
            min="1"
            onChange={(event) => changeSnooze(event.target.value)}
            step="1"
            type="number"
            value={snoozeMinutes}
          />
          <span className="text-[12px] text-[color:var(--fg-muted)]">分钟</span>
        </span>
      </div>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">滑出 / 缩进动画</p>
          <p className="settings-desc">展开和收起面板时播放过渡动画</p>
        </div>
        <button
          aria-checked={animations}
          aria-label={`滑出缩进动画，当前${animations ? "开启" : "关闭"}`}
          className="settings-switch"
          onClick={() => changeAnimations(!animations)}
          role="switch"
          type="button"
        />
      </div>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">开机自启</p>
          <p className="settings-desc">登录 Windows 时自动启动 TodoEdge（当前{autostart ? "已开启" : "关闭"}）</p>
        </div>
        <button
          aria-checked={autostart}
          aria-label={`开机自启，当前${autostart ? "已开启" : "关闭"}`}
          className="settings-switch"
          disabled={autostartPending}
          onClick={() => changeAutostart(!autostart)}
          role="switch"
          type="button"
        />
      </div>

      {error ? (
        <p className="px-2.5 pt-1 text-[12px] text-[color:var(--danger)]">{error}</p>
      ) : null}
    </div>
  );
}

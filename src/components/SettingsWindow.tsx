import { useCallback, useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";

import { api } from "../lib/api";
import {
  applyMaterial,
  MATERIAL_SETTING_KEY,
  normalizeMaterial,
  SNOOZE_SETTING_KEY,
  type Material,
} from "../lib/material";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 设置小窗页面（独立 WebviewWindow，hash 路由 #settings）。
 * 对话性质窗口，参与正常焦点。外观/间隔写入 settings 表，开机自启走
 * tauri-plugin-autostart（注册表 Run 键，默认关）。
 */
export function SettingsWindow() {
  const [material, setMaterial] = useState<Material>("glass");
  const [snoozeMinutes, setSnoozeMinutes] = useState("10");
  const [autostart, setAutostart] = useState(false);
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
        setAutostart(await api.autostartStatus());
      } catch (cause) {
        setError(errorMessage(cause));
      }
    })();
  }, []);

  // 改动即存：外观切换同时通知主面板即时生效
  const changeMaterial = useCallback((next: Material) => {
    setMaterial(next);
    applyMaterial(next);
    void api.setSetting(MATERIAL_SETTING_KEY, next).catch((cause) => {
      setError(errorMessage(cause));
    });
    void emit("material-changed", next).catch((cause) => {
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

  const changeAutostart = useCallback((enabled: boolean) => {
    setAutostart(enabled);
    void api.setAutostart(enabled).catch(() => {
      // 写注册表失败则回滚开关，保持与真实状态一致
      setAutostart(!enabled);
      setError("开机自启设置失败");
    });
  }, []);

  return (
    <main className="settings-page">
      <h1 className="settings-title">设置</h1>

      <div className="settings-row">
        <span className="settings-label">外观</span>
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
        <span className="settings-label">稍后提醒间隔</span>
        <span className="flex items-center gap-1.5">
          <input
            aria-label="稍后提醒间隔（分钟）"
            className="picker-input w-[64px]"
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
        <span className="settings-label">开机自启</span>
        <button
          aria-checked={autostart}
          aria-label="开机自启"
          className="settings-switch"
          onClick={() => changeAutostart(!autostart)}
          role="switch"
          type="button"
        />
      </div>

      {error ? (
        <p className="px-2.5 pt-1 text-[12px] text-[color:var(--danger)]">{error}</p>
      ) : null}
    </main>
  );
}

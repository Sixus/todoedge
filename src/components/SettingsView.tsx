import { useCallback, useEffect, useState } from "react";

import { getVersion } from "@tauri-apps/api/app";

import { api } from "../lib/api";
import {
  WINDOW_MATERIAL_SETTING_KEY,
  normalizeWindowMaterial,
  type AppMode,
  type WindowMaterial,
} from "../lib/appMode";
import {
  DEFAULT_HOTKEY,
  HOTKEY_SETTING_KEY,
  buildHotkeyCombo,
  formatHotkey,
  hasUsableModifier,
  isModifierCode,
} from "../lib/hotkey";
import {
  applyMaterial,
  MATERIAL_SETTING_KEY,
  normalizeMaterial,
  SNOOZE_SETTING_KEY,
  type Material,
} from "../lib/material";
import {
  applyTheme,
  normalizeTheme,
  THEME_SETTING_KEY,
  type ThemeMode,
} from "../lib/theme";

interface SettingsViewProps {
  /** 全局动画总开关当前值（状态在 App 持有，清单/提示条动画共用） */
  animationsEnabled: boolean;
  /** 拨动动画开关：App 负责落库、同步 Rust 与更新前端状态 */
  onChangeAnimations: (enabled: boolean) => void;
  /** 运行模式（贴边/窗口）：状态在 App 持有，切换走 Rust 落库 + 窗口形态变换 */
  appMode: AppMode;
  onChangeAppMode: (mode: AppMode) => void;
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
export function SettingsView({
  animationsEnabled,
  onChangeAnimations,
  appMode,
  onChangeAppMode,
  onClose,
}: SettingsViewProps) {
  const [material, setMaterial] = useState<Material>("glass");
  // 窗口模式背景材质（毛玻璃/普通透明），仅窗口模式下显示
  const [windowMaterial, setWindowMaterial] = useState<WindowMaterial>("blur");
  const [theme, setTheme] = useState<ThemeMode>("auto");
  const [hotkey, setHotkey] = useState(DEFAULT_HOTKEY);
  const [recording, setRecording] = useState(false);
  const [snoozeMinutes, setSnoozeMinutes] = useState("10");
  const [autostart, setAutostart] = useState(false);
  const [autostartPending, setAutostartPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 版本号显示：从应用真实版本（tauri.conf.json）推导「V 主.次」，
  // 升版本只改配置文件，这里自动跟随
  const [versionLabel, setVersionLabel] = useState("V 1.1");

  useEffect(() => {
    void getVersion()
      .then((version) => {
        const [major, minor] = version.split(".");
        setVersionLabel(`V ${major}.${minor}`);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const savedMaterial = normalizeMaterial(await api.getSetting(MATERIAL_SETTING_KEY));
        setMaterial(savedMaterial);
        applyMaterial(savedMaterial);
        setWindowMaterial(
          normalizeWindowMaterial(await api.getSetting(WINDOW_MATERIAL_SETTING_KEY)),
        );
        setTheme(normalizeTheme(await api.getSetting(THEME_SETTING_KEY)));
        const savedSnooze = await api.getSetting(SNOOZE_SETTING_KEY);
        if (savedSnooze !== null && savedSnooze !== "") {
          setSnoozeMinutes(savedSnooze);
        }
        setHotkey((await api.getSetting(HOTKEY_SETTING_KEY)) ?? DEFAULT_HOTKEY);
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

  // 窗口模式背景材质：Rust 落库并即时应用/撤销系统材质（普通透明用于
  // 云电脑/远程会话等 DWM 不支持背景采样的环境）
  const changeWindowMaterial = useCallback((next: WindowMaterial) => {
    setWindowMaterial(next);
    void api.setWindowMaterial(next).catch((cause) => {
      setError(errorMessage(cause));
    });
  }, []);

  // 深浅模式（auto/light/dark）：applyTheme 即时切换，auto 时由 lib/theme.ts 跟随系统
  const changeTheme = useCallback((next: ThemeMode) => {
    setTheme(next);
    applyTheme(next);
    void api.setSetting(THEME_SETTING_KEY, next).catch((cause) => {
      setError(errorMessage(cause));
    });
  }, []);

  // 热键录入（M3-3）：进入录入态后捕获下一个按键组合交给 Rust 注册；
  // 注册失败（被占用）时提示，旧热键原样保留（Rust 侧未变更）
  useEffect(() => {
    if (!recording) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === "Escape") {
        setRecording(false);
        return;
      }
      // 纯修饰键单按不构成组合，继续等待
      if (isModifierCode(event.code)) {
        return;
      }
      const combo = buildHotkeyCombo(
        event.code,
        event.ctrlKey,
        event.altKey,
        event.shiftKey,
        event.metaKey,
      );
      setRecording(false);
      // 简单校验：至少带 Ctrl/Alt/Win 之一——Shift 单独等价普通打字，全局劫持不合适
      if (!hasUsableModifier(combo)) {
        setError("热键至少要带 Ctrl、Alt 或 Win 键");
        return;
      }
      void api
        .setGlobalHotkey(combo)
        .then((saved) => setHotkey(saved))
        .catch(() => setError("热键注册失败（可能被其他程序占用），已保留原热键"));
    }
    const cancel = () => setRecording(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", cancel);
    };
  }, [recording]);

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
    setAutostartPending(true);
    void api
      .setAutostart(enabled)
      .then(() => setAutostart(enabled))
      .catch(() => setError("开机自启设置失败"))
      .finally(() => setAutostartPending(false));
  }, []);

  // 细条位置重置（M3-4）：回垂直居中并落库，Rust 侧就地挪窗口，看细条即见效果
  const resetStripPosition = useCallback(() => {
    void api.resetStripPosition().catch((cause) => {
      setError(errorMessage(cause));
    });
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

      {/* 运行模式（最上方）：切换即生效；切到贴边后面板收成细条，本视图随面板卸载 */}
      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">运行模式</p>
          <p className="settings-desc">
            贴边=吸附屏幕右缘；窗口=普通窗口，毛玻璃背景可透出桌面
          </p>
        </div>
        <div className="settings-segment" role="radiogroup" aria-label="运行模式">
          <button
            aria-checked={appMode === "edge"}
            className={appMode === "edge" ? "active" : ""}
            onClick={() => onChangeAppMode("edge")}
            role="radio"
            type="button"
          >
            贴边
          </button>
          <button
            aria-checked={appMode === "window"}
            className={appMode === "window" ? "active" : ""}
            onClick={() => onChangeAppMode("window")}
            role="radio"
            type="button"
          >
            窗口
          </button>
        </div>
      </div>

      {/* 窗口模式背景材质：仅窗口模式下显示 */}
      {appMode === "window" ? (
        <div className="settings-row">
          <div className="settings-text">
            <p className="settings-label">窗口背景</p>
            <p className="settings-desc">
              系统毛玻璃=背景真模糊；云电脑/远程桌面不支持时选普通透明
            </p>
          </div>
          <div className="settings-segment" role="radiogroup" aria-label="窗口背景">
            <button
              aria-checked={windowMaterial === "blur"}
              className={windowMaterial === "blur" ? "active" : ""}
              onClick={() => changeWindowMaterial("blur")}
              role="radio"
              type="button"
            >
              毛玻璃
            </button>
            <button
              aria-checked={windowMaterial === "clear"}
              className={windowMaterial === "clear" ? "active" : ""}
              onClick={() => changeWindowMaterial("clear")}
              role="radio"
              type="button"
            >
              普通透明
            </button>
          </div>
        </div>
      ) : null}

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
          <p className="settings-label">深浅模式</p>
          <p className="settings-desc">跟随 Windows 深浅色，或手动固定</p>
        </div>
        <div className="settings-segment" role="radiogroup" aria-label="深浅模式">
          <button
            aria-checked={theme === "auto"}
            className={theme === "auto" ? "active" : ""}
            onClick={() => changeTheme("auto")}
            role="radio"
            type="button"
          >
            跟随系统
          </button>
          <button
            aria-checked={theme === "light"}
            className={theme === "light" ? "active" : ""}
            onClick={() => changeTheme("light")}
            role="radio"
            type="button"
          >
            浅色
          </button>
          <button
            aria-checked={theme === "dark"}
            className={theme === "dark" ? "active" : ""}
            onClick={() => changeTheme("dark")}
            role="radio"
            type="button"
          >
            深色
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
          <p className="settings-label">动画</p>
          <p className="settings-desc">
            面板滑出/缩进、勾选完成、分组展开、新增任务与提示条的动画总开关
          </p>
        </div>
        <button
          aria-checked={animationsEnabled}
          aria-label={`动画，当前${animationsEnabled ? "开启" : "关闭"}`}
          className="settings-switch"
          onClick={() => onChangeAnimations(!animationsEnabled)}
          role="switch"
          type="button"
        />
      </div>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">细条位置</p>
          <p className="settings-desc">按住屏幕右缘细条上下拖动；重置后回到垂直居中</p>
        </div>
        <button
          aria-label="细条位置重置"
          className="settings-reset"
          onClick={resetStripPosition}
          title="回到垂直居中"
          type="button"
        >
          重置
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-text">
          <p className="settings-label">全局热键</p>
          <p className="settings-desc">任何界面呼出 / 收起面板；点击右侧后按新组合键（Esc 取消）</p>
        </div>
        <button
          aria-label="录入全局热键"
          className={
            recording ? "settings-reset hotkey-recorder recording" : "settings-reset hotkey-recorder"
          }
          onClick={() => setRecording(true)}
          type="button"
        >
          {recording ? "请按下组合键…" : formatHotkey(hotkey)}
        </button>
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

      {/* 完全退出：结束整个应用进程，细条与面板一并消失 */}
      <button
        aria-label="完全退出程序"
        className="settings-exit"
        onClick={() => void api.exitApp().catch((cause) => setError(errorMessage(cause)))}
        title="退出 TodoEdge"
        type="button"
      >
        完全退出
      </button>
      <p className="settings-version">{versionLabel}</p>
    </div>
  );
}

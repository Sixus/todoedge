import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import "./App.css";

import { Panel } from "./components/Panel";
import { Strip } from "./components/Strip";
import { useTasks } from "./hooks/useTasks";
import {
  APP_MODE_SETTING_KEY,
  WINDOW_MATERIAL_SETTING_KEY,
  applyAppMode,
  applyWindowMaterial,
  normalizeAppMode,
  normalizeWindowMaterial,
  type AppMode,
} from "./lib/appMode";
import { api, type WindowMode } from "./lib/api";
import {
  ANIMATIONS_SETTING_KEY,
  applyMaterial,
  MATERIAL_SETTING_KEY,
  normalizeMaterial,
} from "./lib/material";
import { applyTheme, normalizeTheme, THEME_SETTING_KEY } from "./lib/theme";
import {
  DEFAULT_HOVER_EXPAND_MS,
  DEFAULT_LEAVE_COLLAPSE_MS,
  HOVER_EXPAND_DELAY_SETTING_KEY,
  LEAVE_COLLAPSE_DELAY_SETTING_KEY,
  MAX_HOVER_EXPAND_MS,
  MAX_LEAVE_COLLAPSE_MS,
  MIN_HOVER_EXPAND_MS,
  MIN_LEAVE_COLLAPSE_MS,
  normalizeDelayMs,
} from "./lib/timing";

const PINNED_SETTING_KEY = "pinned";

function App() {
  const {
    tasks,
    isLoading,
    error,
    addTask,
    toggleTask,
    deleteTask,
    restoreTask,
    editTask,
    reorderTasks,
    reload,
  } = useTasks();
  const [collapsed, setCollapsed] = useState(true);
  const [highlightTaskId, setHighlightTaskId] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  // 全局动画总开关（M4 反馈）：面板滑出/缩进、勾选完成、分组展开、新增任务、
  // 撤销提示全部受它控制；设置表持久化，同一开关同步给 Rust 侧窗口动画
  const [animationsEnabled, setAnimationsEnabled] = useState(true);
  // 运行模式（贴边/窗口）：窗口模式下面板常驻展开、标题栏可拖动窗口
  const [appMode, setAppMode] = useState<AppMode>("edge");
  // 贴边时机：悬停细条多久滑出 / 鼠标离开面板多久收回（设置页可调，
  // Strip/Panel 的定时器使用；仅贴边模式有意义）
  const [hoverExpandMs, setHoverExpandMs] = useState(DEFAULT_HOVER_EXPAND_MS);
  const [leaveCollapseMs, setLeaveCollapseMs] = useState(
    DEFAULT_LEAVE_COLLAPSE_MS,
  );
  const isTransitioning = useRef(false);

  // 外观材质：启动读持久化值（设置视图与面板同文档，改动即时生效，无需跨窗口事件）
  useEffect(() => {
    void api
      .getSetting(MATERIAL_SETTING_KEY)
      .then((value) => applyMaterial(normalizeMaterial(value)))
      .catch(() => undefined);
    // 窗口模式背景材质：恢复 data-window-material（CSS 面板底色浓度跟随）
    void api
      .getSetting(WINDOW_MATERIAL_SETTING_KEY)
      .then((value) => applyWindowMaterial(normalizeWindowMaterial(value)))
      .catch(() => undefined);
    // 运行模式：窗口模式启动时直接进面板（Rust 侧已按模式落位窗口与毛玻璃）
    void api
      .getSetting(APP_MODE_SETTING_KEY)
      .then((value) => {
        const mode = normalizeAppMode(value);
        setAppMode(mode);
        applyAppMode(mode);
        if (mode === "window") {
          setCollapsed(false);
        }
      })
      .catch(() => undefined);
    // 全局动画开关：启动恢复前端状态，并同步给 Rust 侧窗口动画逻辑
    void api
      .getSetting(ANIMATIONS_SETTING_KEY)
      .then((value) => {
        const enabled = value !== "0";
        setAnimationsEnabled(enabled);
        void api.setPanelAnimations(enabled).catch(() => undefined);
      })
      .catch(() => undefined);
    // 图钉固定：跨重启记住，并同步给 Rust 侧（编辑态点外部兜底收起要看这个开关）
    void api
      .getSetting(PINNED_SETTING_KEY)
      .then((value) => {
        const restored = value === "1";
        setPinned(restored);
        void api.setPanelPinned(restored).catch(() => undefined);
      })
      .catch(() => undefined);
    // 深浅模式：auto 跟随系统 / 手动浅深，启动恢复（lib/theme.ts 内部已监听系统变化）
    void api
      .getSetting(THEME_SETTING_KEY)
      .then((value) => applyTheme(normalizeTheme(value)))
      .catch(() => undefined);
    // 贴边时机：启动恢复，缺失/损坏回默认值（设置页改动经 change* 回流到这里）
    void api
      .getSetting(HOVER_EXPAND_DELAY_SETTING_KEY)
      .then((value) =>
        setHoverExpandMs(
          normalizeDelayMs(
            value,
            DEFAULT_HOVER_EXPAND_MS,
            MIN_HOVER_EXPAND_MS,
            MAX_HOVER_EXPAND_MS,
          ),
        ),
      )
      .catch(() => undefined);
    void api
      .getSetting(LEAVE_COLLAPSE_DELAY_SETTING_KEY)
      .then((value) =>
        setLeaveCollapseMs(
          normalizeDelayMs(
            value,
            DEFAULT_LEAVE_COLLAPSE_MS,
            MIN_LEAVE_COLLAPSE_MS,
            MAX_LEAVE_COLLAPSE_MS,
          ),
        ),
      )
      .catch(() => undefined);
  }, []);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      void api.setSetting(PINNED_SETTING_KEY, next ? "1" : "0").catch(() => undefined);
      void api.setPanelPinned(next).catch(() => undefined);
      return next;
    });
  }, []);

  const syncWindowMode = useCallback((mode: WindowMode) => {
    setCollapsed(mode === "collapsed");
  }, []);

  useEffect(() => {
    const unlisten = listen<WindowMode>("window-mode-changed", (event) => {
      syncWindowMode(event.payload);
    });

    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, [syncWindowMode]);

  const expandPanel = useCallback(async () => {
    if (isTransitioning.current) {
      return;
    }

    isTransitioning.current = true;
    try {
      syncWindowMode(await api.expandPanel());
    } finally {
      isTransitioning.current = false;
    }
  }, [syncWindowMode]);

  const collapsePanel = useCallback(async () => {
    if (isTransitioning.current) {
      return;
    }

    isTransitioning.current = true;
    try {
      syncWindowMode(await api.collapsePanel());
    } finally {
      isTransitioning.current = false;
    }
  }, [syncWindowMode]);

  const setPanelEditing = useCallback((editing: boolean) => {
    void api.setPanelEditing(editing);
  }, []);

  // 全局动画开关切换：落库 + 同步 Rust 窗口动画 + 更新前端状态
  const changeAnimations = useCallback((enabled: boolean) => {
    setAnimationsEnabled(enabled);
    void api
      .setSetting(ANIMATIONS_SETTING_KEY, enabled ? "1" : "0")
      .catch(() => undefined);
    void api.setPanelAnimations(enabled).catch(() => undefined);
  }, []);

  // 贴边时机改动（设置页）：落库 + 更新前端状态，下一次悬停/离开即用新值
  const changeHoverExpand = useCallback((ms: number) => {
    setHoverExpandMs(ms);
    void api
      .setSetting(HOVER_EXPAND_DELAY_SETTING_KEY, String(ms))
      .catch(() => undefined);
  }, []);

  const changeLeaveCollapse = useCallback((ms: number) => {
    setLeaveCollapseMs(ms);
    void api
      .setSetting(LEAVE_COLLAPSE_DELAY_SETTING_KEY, String(ms))
      .catch(() => undefined);
  }, []);

  // 运行模式切换：落库交给 Rust（含毛玻璃/窗口形态变换），前端先更新
  // data-app-mode 让面板底色立即过渡；展开/收起由 Rust 的 window-mode-changed 事件驱动
  const changeAppMode = useCallback((mode: AppMode) => {
    setAppMode(mode);
    applyAppMode(mode);
    void api.setAppMode(mode).catch(() => undefined);
  }, []);

  // 全局禁掉网页默认右键菜单：WebView 菜单带刷新/检查/发送到设备等浏览器项，
  // 输入框里也一样，一律不弹；剪切/复制/粘贴走 Ctrl+X/C/V 快捷键
  useEffect(() => {
    function onContextMenu(event: MouseEvent) {
      event.preventDefault();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // Toast 交互路由（M2-1）：完成/稍后提醒只刷新列表（面板不弹出）；
  // 点通知主体 → 呼出面板并高亮该任务，描边由 TaskItem 持续 2 秒后撤掉
  const clearHighlight = useCallback(() => setHighlightTaskId(null), []);

  useEffect(() => {
    const unlisteners = [
      listen<number>("toast-task-done", () => {
        void reload().catch(() => undefined);
      }),
      listen<number>("toast-task-snoozed", () => {
        void reload().catch(() => undefined);
      }),
      listen<number>("open_panel_and_highlight", (event) => {
        void expandPanel();
        setHighlightTaskId(event.payload);
        // 兜底清理：面板因全屏等原因未能展开时，高亮标记也不残留
        window.setTimeout(() => {
          setHighlightTaskId((current) =>
            current === event.payload ? null : current,
          );
        }, 5000);
      }),
    ];

    return () => {
      for (const unlisten of unlisteners) {
        void unlisten.then((dispose) => dispose());
      }
    };
  }, [expandPanel, reload]);

  if (collapsed) {
    return <Strip hoverExpandMs={hoverExpandMs} onExpand={() => void expandPanel()} />;
  }

  return (
    <Panel
      animationsEnabled={animationsEnabled}
      appMode={appMode}
      hoverExpandMs={hoverExpandMs}
      leaveCollapseMs={leaveCollapseMs}
      onChangeAppMode={changeAppMode}
      onChangeHoverExpand={changeHoverExpand}
      onChangeLeaveCollapse={changeLeaveCollapse}
      error={error}
      highlightTaskId={highlightTaskId}
      isLoading={isLoading}
      onAdd={addTask}
      onCollapse={() => void collapsePanel()}
      onChangeAnimations={changeAnimations}
      onDelete={deleteTask}
      onRestoreTask={restoreTask}
      onEditingChange={setPanelEditing}
      pinned={pinned}
      onTogglePin={togglePin}
      onHighlightEnd={clearHighlight}
      onEditTask={editTask}
      onReorder={reorderTasks}
      onToggle={toggleTask}
      tasks={tasks}
    />
  );
}

export default App;

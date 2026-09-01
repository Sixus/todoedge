import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import "./App.css";

import { Panel } from "./components/Panel";
import { Strip } from "./components/Strip";
import { useTasks } from "./hooks/useTasks";
import { api, type WindowMode } from "./lib/api";
import {
  ANIMATIONS_SETTING_KEY,
  applyMaterial,
  MATERIAL_SETTING_KEY,
  normalizeMaterial,
} from "./lib/material";

const PINNED_SETTING_KEY = "pinned";

function App() {
  const {
    tasks,
    isLoading,
    error,
    addTask,
    toggleTask,
    deleteTask,
    editTask,
    reorderTasks,
    reload,
  } = useTasks();
  const [collapsed, setCollapsed] = useState(true);
  const [highlightTaskId, setHighlightTaskId] = useState<number | null>(null);
  const [pinned, setPinned] = useState(false);
  const isTransitioning = useRef(false);

  // 外观材质：启动读持久化值（设置视图与面板同文档，改动即时生效，无需跨窗口事件）
  useEffect(() => {
    void api
      .getSetting(MATERIAL_SETTING_KEY)
      .then((value) => applyMaterial(normalizeMaterial(value)))
      .catch(() => undefined);
    // 动画开关：设置表持久化，同步给 Rust 侧窗口动画逻辑
    void api
      .getSetting(ANIMATIONS_SETTING_KEY)
      .then((value) => api.setPanelAnimations(value !== "0"))
      .catch(() => undefined);
    // 图钉固定：跨重启记住
    void api
      .getSetting(PINNED_SETTING_KEY)
      .then((value) => setPinned(value === "1"))
      .catch(() => undefined);
  }, []);

  const togglePin = useCallback(() => {
    setPinned((prev) => {
      const next = !prev;
      void api.setSetting(PINNED_SETTING_KEY, next ? "1" : "0").catch(() => undefined);
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
    return <Strip onExpand={() => void expandPanel()} />;
  }

  return (
    <Panel
      error={error}
      highlightTaskId={highlightTaskId}
      isLoading={isLoading}
      onAdd={addTask}
      onCollapse={() => void collapsePanel()}
      onDelete={deleteTask}
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

import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import "./App.css";

import { Panel } from "./components/Panel";
import { Strip } from "./components/Strip";
import { useTasks } from "./hooks/useTasks";
import { api, type WindowMode } from "./lib/api";

function App() {
  const {
    tasks,
    isLoading,
    error,
    addTask,
    toggleTask,
    deleteTask,
    setRemindAt,
    reload,
  } = useTasks();
  const [collapsed, setCollapsed] = useState(true);
  const [highlightTaskId, setHighlightTaskId] = useState<number | null>(null);
  const isTransitioning = useRef(false);

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
      onHighlightEnd={clearHighlight}
      onSetRemindAt={setRemindAt}
      onToggle={toggleTask}
      tasks={tasks}
    />
  );
}

export default App;

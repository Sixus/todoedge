import { useCallback, useEffect, useRef, useState } from "react";
import dayjs from "dayjs";

import { listen } from "@tauri-apps/api/event";

import "./App.css";

import { Panel } from "./components/Panel";
import { Strip } from "./components/Strip";
import { useTasks } from "./hooks/useTasks";
import { api, type WindowMode } from "./lib/api";

function App() {
  const { tasks, isLoading, error, addTask, toggleTask, deleteTask, setRemindAt } =
    useTasks();
  const [collapsed, setCollapsed] = useState(true);
  const isTransitioning = useRef(false);

  // 临时测试入口：把任务提醒设到 1 分钟后（M2-3 换成自然语言解析 + 点选器后删除）
  const setTestRemindInOneMinute = useCallback(
    (id: number) => setRemindAt(id, dayjs().add(1, "minute").toISOString()),
    [setRemindAt],
  );

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

  if (collapsed) {
    return <Strip onExpand={() => void expandPanel()} />;
  }

  return (
    <Panel
      error={error}
      isLoading={isLoading}
      onAdd={addTask}
      onCollapse={() => void collapsePanel()}
      onDelete={deleteTask}
      onEditingChange={setPanelEditing}
      onSetTestRemind={setTestRemindInOneMinute}
      onToggle={toggleTask}
      tasks={tasks}
    />
  );
}

export default App;

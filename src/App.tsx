import { useCallback, useEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import "./App.css";

import { Panel } from "./components/Panel";
import { Strip } from "./components/Strip";
import { useTasks } from "./hooks/useTasks";
import { api, type WindowMode } from "./lib/api";

function App() {
  const { tasks, isLoading, error, addTask, toggleTask, deleteTask } = useTasks();
  const [collapsed, setCollapsed] = useState(true);
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
      onToggle={toggleTask}
      tasks={tasks}
    />
  );
}

export default App;

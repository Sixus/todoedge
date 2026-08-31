import { useEffect, useRef, useState } from "react";

import type { Task } from "../lib/api";
import { TaskInput } from "./TaskInput";
import { TaskList } from "./TaskList";

interface PanelProps {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  onAdd: (title: string) => Promise<void>;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetTestRemind: (id: number) => Promise<void>;
  onCollapse: () => void;
  onEditingChange: (editing: boolean) => void;
}

export function Panel({
  tasks,
  isLoading,
  error,
  onAdd,
  onToggle,
  onDelete,
  onSetTestRemind,
  onCollapse,
  onEditingChange,
}: PanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const collapseTimer = useRef<number | null>(null);
  const isEditingRef = useRef(false);
  const [isEditing, setIsEditing] = useState(false);
  const pendingCount = tasks.filter((task) => !task.done).length;

  function clearCollapseTimer() {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }

  function requestCollapse() {
    clearCollapseTimer();
    onEditingChange(false);
    onCollapse();
  }

  function handleMouseLeave() {
    if (isEditing) {
      return;
    }

    clearCollapseTimer();
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      requestCollapse();
    }, 1500);
  }

  function handleInputFocus() {
    clearCollapseTimer();
    isEditingRef.current = true;
    setIsEditing(true);
    onEditingChange(true);
  }

  function handleInputBlur() {
    isEditingRef.current = false;
    setIsEditing(false);
    onEditingChange(false);
  }

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        requestCollapse();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCollapse();
      }
    }

    function handleWindowBlur() {
      if (isEditingRef.current) {
        requestCollapse();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      clearCollapseTimer();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
      isEditingRef.current = false;
      onEditingChange(false);
    };
  }, [onEditingChange]);

  return (
    <main
      className="panel-shell"
      onMouseEnter={clearCollapseTimer}
      onMouseLeave={handleMouseLeave}
      ref={panelRef}
      tabIndex={-1}
    >
      <header className="app-header">
        <h1>TodoEdge</h1>
        <p>未完成 {pendingCount}</p>
      </header>

      <TaskInput onAdd={onAdd} onBlur={handleInputBlur} onFocus={handleInputFocus} />

      <section aria-label="任务清单" className="task-list-section">
        {isLoading ? <p className="empty-state">加载中…</p> : null}
        {!isLoading && error ? <p className="error-state">加载失败：{error}</p> : null}
        {!isLoading && !error ? (
          <TaskList
            onDelete={onDelete}
            onSetTestRemind={onSetTestRemind}
            onToggle={onToggle}
            tasks={tasks}
          />
        ) : null}
      </section>
    </main>
  );
}

import { useState } from "react";
import type { DragEvent } from "react";
import type { Dayjs } from "dayjs";

import type { Task } from "../lib/api";
import { sortTasks } from "../lib/taskSort";
import { TaskItem } from "./TaskItem";

type DropPosition = "before" | "after";

interface TaskListProps {
  tasks: Task[];
  now: Dayjs;
  highlightTaskId: number | null;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onEditTask: (id: number, title: string, remindAt: string | null) => Promise<void>;
  /** 拖拽落定：按新顺序提交全部任务 id（待办在前、已完成在后） */
  onReorder: (orderedIds: number[]) => void;
  onHighlightEnd: () => void;
}

export function TaskList({
  tasks,
  now,
  highlightTaskId,
  onToggle,
  onDelete,
  onEditTask,
  onReorder,
  onHighlightEnd,
}: TaskListProps) {
  const sortedTasks = sortTasks(tasks, now);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; position: DropPosition } | null>(
    null,
  );

  function clearDrag() {
    setDragId(null);
    setDropHint(null);
  }

  /** 只允许同分区内拖动：跨待办/已完成边界的拖放一律忽略 */
  function sameBucket(targetDone: boolean): boolean {
    if (dragId === null) {
      return false;
    }
    const dragTask = tasks.find((task) => task.id === dragId);
    return dragTask !== undefined && dragTask.done === targetDone;
  }

  function handleDragOver(targetId: number, targetDone: boolean, event: DragEvent<HTMLLIElement>) {
    if (dragId === null || dragId === targetId || !sameBucket(targetDone)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const position: DropPosition =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (dropHint?.id !== targetId || dropHint.position !== position) {
      setDropHint({ id: targetId, position });
    }
  }

  function handleDrop(targetId: number, targetDone: boolean) {
    const position = dropHint?.id === targetId ? dropHint.position : null;
    clearDrag();
    if (dragId === null || dragId === targetId || position === null) {
      return;
    }
    if (!sameBucket(targetDone)) {
      return;
    }

    // 基于当前显示顺序重排所在分区，另一个分区原样保留
    const pendingIds = sortedTasks.filter((task) => !task.done).map((task) => task.id);
    const doneIds = sortedTasks.filter((task) => task.done).map((task) => task.id);
    const bucket = targetDone ? doneIds : pendingIds;
    bucket.splice(bucket.indexOf(dragId), 1);
    bucket.splice(bucket.indexOf(targetId) + (position === "after" ? 1 : 0), 0, dragId);
    onReorder([...pendingIds, ...doneIds]);
  }

  /** 当前行该显示的插入位置提示（拖拽中且悬停在同分区其他行上） */
  function hintFor(task: Task): DropPosition | null {
    if (dragId === null || dragId === task.id || dropHint?.id !== task.id) {
      return null;
    }
    return dropHint.position;
  }

  if (sortedTasks.length === 0) {
    return (
      <p className="mt-10 text-center text-[13px] text-[color:var(--fg-muted)]">
        今天没有待办，休息一下
      </p>
    );
  }

  return (
    <ul className="flex flex-col">
      {sortedTasks.map((task) => (
        <TaskItem
          key={task.id}
          now={now}
          highlighted={task.id === highlightTaskId}
          dropHint={hintFor(task)}
          onDragEndItem={clearDrag}
          onDragOverItem={handleDragOver}
          onDragStartItem={setDragId}
          onDropItem={handleDrop}
          onHighlightEnd={onHighlightEnd}
          onDelete={onDelete}
          onEditTask={onEditTask}
          onToggle={onToggle}
          task={task}
        />
      ))}
    </ul>
  );
}

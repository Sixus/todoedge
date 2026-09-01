import { useRef, useState } from "react";
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

interface DragState {
  id: number;
  done: boolean;
  startY: number;
  /** 位移超过阈值后才算拖拽，避免与点击冲突 */
  active: boolean;
}

/**
 * 手动排序：Pointer Events 自实现（HTML5 drag & drop 在 NOACTIVATE 窗口和
 * 云桌面环境下事件不可靠，2026-09-01 反馈拖不动）。按住行的空白/标题区拖动，
 * 跨待办/已完成分区的拖放一律忽略。
 */
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
  // dropHint 的镜像引用：pointerup 落定时读取最新值，不依赖渲染闭包
  const dropHintRef = useRef<{ id: number; position: DropPosition } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  /** 按下：记录候选拖拽（交互控件上不启动）；指针捕获保证后续 move/up 不丢 */
  function handleRowPointerDown(
    id: number,
    done: boolean,
    event: React.PointerEvent<HTMLLIElement>,
  ) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button, input, a, label")) {
      return;
    }
    event.preventDefault(); // 抑制拖动时的文本选择
    dragRef.current = { id, done, startY: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** 移动：超过阈值进入拖拽；用 elementFromPoint 命中测试悬停的目标行 */
  function handleRowPointerMove(
    id: number,
    done: boolean,
    event: React.PointerEvent<HTMLLIElement>,
  ) {
    const state = dragRef.current;
    if (!state || state.id !== id) {
      return;
    }
    if (!state.active) {
      if (Math.abs(event.clientY - state.startY) < 5) {
        return;
      }
      state.active = true;
      setDragId(id);
    }
    event.preventDefault();

    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("li[data-task-id]");
    if (!hit) {
      setDropHint(null);
      return;
    }
    const targetId = Number(hit.getAttribute("data-task-id"));
    if (!Number.isInteger(targetId) || targetId === id) {
      setDropHint(null);
      return;
    }
    const targetTask = tasks.find((task) => task.id === targetId);
    if (!targetTask || targetTask.done !== done) {
      setDropHint(null); // 跨分区：不给落点提示
      return;
    }
    const rect = hit.getBoundingClientRect();
    const position: DropPosition =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (dropHintRef.current?.id !== targetId || dropHintRef.current.position !== position) {
      dropHintRef.current = { id: targetId, position };
      setDropHint({ id: targetId, position });
    }
  }

  /** 抬起：拖拽已激活且悬停在同分区行上则落定新顺序 */
  function handleRowPointerUp(id: number, done: boolean) {
    const state = dragRef.current;
    const wasActive = state?.active ?? false;
    const hint = dropHintRef.current;
    dragRef.current = null;
    dropHintRef.current = null;
    setDragId(null);
    setDropHint(null);
    if (!wasActive || !hint || state?.id !== id) {
      return;
    }
    const targetTask = tasks.find((task) => task.id === hint.id);
    if (!targetTask || targetTask.done !== done) {
      return;
    }

    // 基于当前显示顺序重排所在分区，另一个分区原样保留
    const pendingIds = sortedTasks.filter((task) => !task.done).map((task) => task.id);
    const doneIds = sortedTasks.filter((task) => task.done).map((task) => task.id);
    const bucket = done ? doneIds : pendingIds;
    bucket.splice(bucket.indexOf(id), 1);
    bucket.splice(bucket.indexOf(hint.id) + (hint.position === "after" ? 1 : 0), 0, id);
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
          dragging={task.id === dragId}
          dropHint={hintFor(task)}
          onRowPointerDown={handleRowPointerDown}
          onRowPointerMove={handleRowPointerMove}
          onRowPointerUp={handleRowPointerUp}
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

import { useEffect, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import type { Dayjs } from "dayjs";

import { formatTaskTime, isOverdue } from "../lib/format";
import type { Task } from "../lib/api";
import { CheckIcon, EditIcon, TrashIcon, XIcon } from "./icons";
import { ReminderPicker } from "./ReminderPicker";

interface TaskItemProps {
  task: Task;
  now: Dayjs;
  highlighted: boolean;
  onHighlightEnd: () => void;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 编辑任务标题 + 提醒时间（null = 清除提醒） */
  onEditTask: (id: number, title: string, remindAt: string | null) => Promise<void>;
  /** 手动排序（Pointer Events 自实现，TaskList 编排；跨分区忽略） */
  onRowPointerDown: (id: number, done: boolean, event: PointerEvent<HTMLLIElement>) => void;
  onRowPointerMove: (id: number, done: boolean, event: PointerEvent<HTMLLIElement>) => void;
  onRowPointerUp: (id: number, done: boolean) => void;
  /** 当前行显示的插入位置提示 */
  dropHint: "before" | "after" | null;
  /** 当前行是否为拖拽中的源行 */
  dragging: boolean;
  /** 入场动画（新增任务，全局动画开启时由 TaskList 传入） */
  entering?: boolean;
  /** 离场动画（勾选完成渐隐收拢，动画期间禁点） */
  leaving?: boolean;
}

export function TaskItem({
  task,
  now,
  highlighted,
  onHighlightEnd,
  onToggle,
  onDelete,
  onEditTask,
  onRowPointerDown,
  onRowPointerMove,
  onRowPointerUp,
  dropHint,
  dragging,
  entering = false,
  leaving = false,
}: TaskItemProps) {
  const overdue = !task.done && !!task.remindAt && isOverdue(task.remindAt, now);
  const timeText = task.remindAt ? formatTaskTime(task.remindAt, now) : null;
  const itemRef = useRef<HTMLLIElement>(null);
  // 弹层锚点：打开时记录触发控件位置，卡片钉在它下方
  const [pickerAnchor, setPickerAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );
  // 删除二次确认：点一下变红色垃圾桶，再点才删（3 秒不点自动还原）
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const confirmTimer = useRef<number | null>(null);

  // Toast「点主体」呼出面板：滚到可见并保留描边 2 秒（M2-1）
  useEffect(() => {
    if (!highlighted) {
      return;
    }
    itemRef.current?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(onHighlightEnd, 2000);
    return () => window.clearTimeout(timer);
  }, [highlighted, onHighlightEnd]);

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current);
      }
    };
  }, []);

  function openPicker(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setPickerAnchor({ top: rect.bottom + 4, right: rect.right });
  }

  function handleDeleteClick() {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      confirmTimer.current = window.setTimeout(() => setConfirmingDelete(false), 3000);
      return;
    }
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
    }
    void onDelete(task.id);
  }

  return (
    <li
      className={`group flex min-h-[var(--task-row-h)] items-center gap-2 rounded-md px-1.5 transition-colors duration-150 hover:bg-[var(--surface-hover)]${
        highlighted ? " task-highlight" : ""
      }${dropHint ? ` drop-${dropHint}` : ""}${dragging ? " opacity-50" : ""}${
        entering ? " task-item-enter" : ""
      }${leaving ? " task-item-leave" : ""}`}
      data-task-id={task.id}
      onPointerDown={(event) => onRowPointerDown(task.id, task.done, event)}
      onPointerMove={(event) => onRowPointerMove(task.id, task.done, event)}
      onPointerUp={() => onRowPointerUp(task.id, task.done)}
      onPointerCancel={() => onRowPointerUp(task.id, task.done)}
      ref={itemRef}
    >
      <label className="task-check" title={task.done ? "标记未完成" : "标记完成"}>
        <input
          aria-label={`标记任务「${task.title}」${task.done ? "未完成" : "已完成"}`}
          checked={task.done}
          onChange={() => void onToggle(task.id)}
          type="checkbox"
        />
        <span className="check-circle">
          <CheckIcon className="h-3 w-3" />
        </span>
      </label>
      <span
        className={`task-title min-w-0 flex-1 truncate text-[14px] leading-[1.45] ${
          task.done && !leaving
            ? "text-[color:var(--done-fg)] line-through"
            : "text-[color:var(--fg)]"
        }`}
      >
        {task.title}
      </span>
      {timeText ? (
        <span
          className={`shrink-0 text-[11px] tabular-nums ${
            overdue
              ? "font-semibold text-[color:var(--danger)]"
              : task.done
                ? "text-[color:var(--done-fg)]"
                : "text-[color:var(--fg-muted)]"
          }`}
        >
          {timeText}
        </span>
      ) : null}
      <button
        aria-label={`编辑任务「${task.title}」`}
        className="icon-btn icon-btn-sm shrink-0 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={openPicker}
        title="编辑任务"
        type="button"
      >
        <EditIcon className="h-[14px] w-[14px]" />
      </button>
      <button
        aria-label={
          confirmingDelete ? `再次点击确认删除任务「${task.title}」` : `删除任务「${task.title}」`
        }
        className={`icon-btn icon-btn-sm shrink-0 transition-opacity duration-150 focus-visible:opacity-100 ${
          confirmingDelete
            ? "text-[#c50f1f]! opacity-100 hover:text-[#c50f1f]!"
            : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={handleDeleteClick}
        title={confirmingDelete ? "再次点击确认删除" : "删除任务"}
        type="button"
      >
        {confirmingDelete ? <TrashIcon className="h-[14px] w-[14px]" /> : <XIcon className="h-[14px] w-[14px]" />}
      </button>
      {pickerAnchor ? (
        <ReminderPicker
          anchor={pickerAnchor}
          initial={task.remindAt}
          initialTitle={task.title}
          onCancel={() => setPickerAnchor(null)}
          onConfirm={({ remindAt, title }) => {
            setPickerAnchor(null);
            void onEditTask(task.id, title ?? task.title, remindAt);
          }}
        />
      ) : null}
    </li>
  );
}

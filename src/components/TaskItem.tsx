import { useEffect, useRef, useState } from "react";
import type { Dayjs } from "dayjs";

import { formatTaskTime, isOverdue } from "../lib/format";
import type { Task } from "../lib/api";
import { CheckIcon, ClockIcon, XIcon } from "./icons";
import { ReminderPicker } from "./ReminderPicker";

interface TaskItemProps {
  task: Task;
  now: Dayjs;
  highlighted: boolean;
  onHighlightEnd: () => void;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 设定/改期（ISO）或清除（null）提醒时间 */
  onSetRemindAt: (id: number, remindAt: string | null) => Promise<void>;
}

export function TaskItem({
  task,
  now,
  highlighted,
  onHighlightEnd,
  onToggle,
  onDelete,
  onSetRemindAt,
}: TaskItemProps) {
  const overdue = !task.done && !!task.remindAt && isOverdue(task.remindAt, now);
  const timeText = task.remindAt ? formatTaskTime(task.remindAt, now) : null;
  const itemRef = useRef<HTMLLIElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Toast「点主体」呼出面板：滚到可见并保留描边 2 秒（M2-1）
  useEffect(() => {
    if (!highlighted) {
      return;
    }
    itemRef.current?.scrollIntoView({ block: "nearest" });
    const timer = window.setTimeout(onHighlightEnd, 2000);
    return () => window.clearTimeout(timer);
  }, [highlighted, onHighlightEnd]);

  return (
    <li
      className={`group flex min-h-[44px] items-center gap-2 rounded-md px-1.5 transition-colors duration-150 hover:bg-[var(--surface-hover)]${
        highlighted ? " task-highlight" : ""
      }`}
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
        className={`min-w-0 flex-1 truncate text-[14px] leading-[1.45] ${
          task.done ? "text-[color:var(--done-fg)] line-through" : "text-[color:var(--fg)]"
        }`}
      >
        {task.title}
      </span>
      {timeText ? (
        <button
          aria-label={`修改任务「${task.title}」的提醒时间`}
          className={`shrink-0 cursor-pointer rounded px-0.5 text-xs tabular-nums transition-colors duration-150 ${
            overdue
              ? "font-semibold text-[color:var(--danger)] hover:text-[color:var(--danger)]"
              : task.done
                ? "text-[color:var(--done-fg)]"
                : "text-[color:var(--fg-muted)] hover:text-[color:var(--fg)]"
          }`}
          onClick={() => setPickerOpen(true)}
          title="修改提醒时间"
          type="button"
        >
          {timeText}
        </button>
      ) : (
        !task.done ? (
          <button
            aria-label={`给任务「${task.title}」设置提醒时间`}
            className="icon-btn icon-btn-sm shrink-0 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
            onClick={() => setPickerOpen(true)}
            title="设置提醒时间"
            type="button"
          >
            <ClockIcon className="h-4 w-4" />
          </button>
        ) : null
      )}
      <button
        aria-label={`删除任务「${task.title}」`}
        className="icon-btn icon-btn-sm shrink-0 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => void onDelete(task.id)}
        type="button"
      >
        <XIcon className="h-[14px] w-[14px]" />
      </button>
      {pickerOpen ? (
        <ReminderPicker
          initial={task.remindAt}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(remindAt) => {
            setPickerOpen(false);
            void onSetRemindAt(task.id, remindAt);
          }}
        />
      ) : null}
    </li>
  );
}

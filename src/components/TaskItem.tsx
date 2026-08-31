import { useEffect, useRef } from "react";
import type { Dayjs } from "dayjs";

import { formatTaskTime, isOverdue } from "../lib/format";
import type { Task } from "../lib/api";
import { CheckIcon, XIcon } from "./icons";

interface TaskItemProps {
  task: Task;
  now: Dayjs;
  highlighted: boolean;
  onHighlightEnd: () => void;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetTestRemind: (id: number) => Promise<void>;
}

export function TaskItem({
  task,
  now,
  highlighted,
  onHighlightEnd,
  onToggle,
  onDelete,
  onSetTestRemind,
}: TaskItemProps) {
  const overdue = !task.done && !!task.remindAt && isOverdue(task.remindAt, now);
  const timeText = task.remindAt ? formatTaskTime(task.remindAt, now) : null;
  const itemRef = useRef<HTMLLIElement>(null);

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
        <span
          className={`shrink-0 text-xs tabular-nums ${
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
      {/* 临时测试入口：设 1 分钟后提醒（M2-3 换成正式设时 UI 后删除） */}
      {!task.done ? (
        <button
          aria-label={`设任务「${task.title}」1 分钟后提醒（临时测试）`}
          className="icon-btn icon-btn-sm shrink-0 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={() => void onSetTestRemind(task.id)}
          title="临时测试：1 分钟后提醒"
          type="button"
        >
          <span aria-hidden className="text-[13px] leading-none">
            ⏰
          </span>
        </button>
      ) : null}
      <button
        aria-label={`删除任务「${task.title}」`}
        className="icon-btn icon-btn-sm shrink-0 opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => void onDelete(task.id)}
        type="button"
      >
        <XIcon className="h-[14px] w-[14px]" />
      </button>
    </li>
  );
}

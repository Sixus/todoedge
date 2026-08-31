import type { Dayjs } from "dayjs";

import type { Task } from "../lib/api";
import { sortTasks } from "../lib/taskSort";
import { TaskItem } from "./TaskItem";

interface TaskListProps {
  tasks: Task[];
  now: Dayjs;
  highlightTaskId: number | null;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetRemindAt: (id: number, remindAt: string | null) => Promise<void>;
  onHighlightEnd: () => void;
}

export function TaskList({
  tasks,
  now,
  highlightTaskId,
  onToggle,
  onDelete,
  onSetRemindAt,
  onHighlightEnd,
}: TaskListProps) {
  const sortedTasks = sortTasks(tasks, now);

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
          onHighlightEnd={onHighlightEnd}
          onDelete={onDelete}
          onSetRemindAt={onSetRemindAt}
          onToggle={onToggle}
          task={task}
        />
      ))}
    </ul>
  );
}

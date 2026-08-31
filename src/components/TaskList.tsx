import type { Dayjs } from "dayjs";

import type { Task } from "../lib/api";
import { sortTasks } from "../lib/taskSort";
import { TaskItem } from "./TaskItem";

interface TaskListProps {
  tasks: Task[];
  now: Dayjs;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetTestRemind: (id: number) => Promise<void>;
}

export function TaskList({ tasks, now, onToggle, onDelete, onSetTestRemind }: TaskListProps) {
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
          onDelete={onDelete}
          onSetTestRemind={onSetTestRemind}
          onToggle={onToggle}
          task={task}
        />
      ))}
    </ul>
  );
}

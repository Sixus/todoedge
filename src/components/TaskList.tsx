import type { Task } from "../lib/api";
import { sortTasks } from "../lib/taskSort";
import { TaskItem } from "./TaskItem";

interface TaskListProps {
  tasks: Task[];
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetTestRemind: (id: number) => Promise<void>;
}

export function TaskList({ tasks, onToggle, onDelete, onSetTestRemind }: TaskListProps) {
  const sortedTasks = sortTasks(tasks);

  if (sortedTasks.length === 0) {
    return <p className="empty-state">还没有任务</p>;
  }

  return (
    <ul className="task-list">
      {sortedTasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          onToggle={onToggle}
          onDelete={onDelete}
          onSetTestRemind={onSetTestRemind}
        />
      ))}
    </ul>
  );
}

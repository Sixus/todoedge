import type { Task } from "../lib/api";

interface TaskItemProps {
  task: Task;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

export function TaskItem({ task, onToggle, onDelete }: TaskItemProps) {
  return (
    <li className={`task-item${task.done ? " is-done" : ""}`}>
      <label className="task-label">
        <input
          aria-label={`标记任务「${task.title}」${task.done ? "未完成" : "已完成"}`}
          checked={task.done}
          onChange={() => void onToggle(task.id)}
          type="checkbox"
        />
        <span>{task.title}</span>
      </label>
      <button
        aria-label={`删除任务「${task.title}」`}
        className="delete-button"
        onClick={() => void onDelete(task.id)}
        type="button"
      >
        ×
      </button>
    </li>
  );
}

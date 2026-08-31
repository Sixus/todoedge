import type { Task } from "../lib/api";

interface TaskItemProps {
  task: Task;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onSetTestRemind: (id: number) => Promise<void>;
}

export function TaskItem({ task, onToggle, onDelete, onSetTestRemind }: TaskItemProps) {
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
      {/* 临时测试入口：设 1 分钟后提醒（M2-3 换成正式设时 UI 后删除） */}
      {!task.done ? (
        <button
          aria-label={`设任务「${task.title}」1 分钟后提醒（临时测试）`}
          className="test-remind-button"
          onClick={() => void onSetTestRemind(task.id)}
          title="临时测试：1 分钟后提醒"
          type="button"
        >
          ⏰
        </button>
      ) : null}
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

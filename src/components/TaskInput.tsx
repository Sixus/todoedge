import { FormEvent, useState } from "react";

interface TaskInputProps {
  onAdd: (title: string) => Promise<void>;
}

export function TaskInput({ onAdd }: TaskInputProps) {
  const [title, setTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isAdding) {
      return;
    }

    setIsAdding(true);
    try {
      await onAdd(trimmedTitle);
      setTitle("");
    } finally {
      setIsAdding(false);
    }
  }

  return (
    <form className="task-input" onSubmit={handleSubmit}>
      <input
        aria-label="新建任务"
        autoFocus
        disabled={isAdding}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="新建任务…"
        type="text"
        value={title}
      />
    </form>
  );
}

import { FormEvent, KeyboardEvent, useState } from "react";

import { ClockIcon, PlusIcon } from "./icons";

interface TaskInputProps {
  onAdd: (title: string) => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function TaskInput({ onAdd, onFocus, onBlur }: TaskInputProps) {
  const [title, setTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  async function submit() {
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

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  // 中文输入法选词的回车不提交
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && event.nativeEvent.isComposing) {
      event.preventDefault();
    }
  }

  return (
    <form className="relative" onSubmit={handleSubmit}>
      <input
        aria-label="新建任务"
        className="h-8 w-full rounded-lg border border-[var(--input-border)] bg-[var(--input-bg)] pl-3 pr-[58px] text-[13px] text-[color:var(--fg)] outline-none transition-colors duration-150 placeholder:text-[color:var(--fg-faint)] focus:border-[var(--input-focus)] disabled:bg-[var(--disabled-bg)]"
        disabled={isAdding}
        onBlur={onBlur}
        onChange={(event) => setTitle(event.target.value)}
        onFocus={onFocus}
        onKeyDown={handleKeyDown}
        placeholder="添加任务"
        type="text"
        value={title}
      />
      <div className="absolute right-[4px] top-1/2 flex -translate-y-1/2 items-center">
        {/* 提醒按钮占位：弹层选择器在 M2-3 实现，本卡点击无动作 */}
        <button
          aria-label="设置提醒时间"
          className="icon-btn icon-btn-sm"
          title="设置提醒时间（即将推出）"
          type="button"
        >
          <ClockIcon className="h-4 w-4" />
        </button>
        <button
          aria-label="添加任务"
          className="icon-btn icon-btn-sm"
          disabled={isAdding}
          type="submit"
        >
          <PlusIcon className="h-4 w-4" />
        </button>
      </div>
    </form>
  );
}

import { FormEvent, KeyboardEvent, useMemo, useState } from "react";
import dayjs from "dayjs";

import { formatReminderPreview } from "../lib/format";
import { parseReminder, stripReminderText } from "../lib/parseTime";
import { ClockIcon, PlusIcon } from "./icons";
import { ReminderPicker } from "./ReminderPicker";

interface TaskInputProps {
  onAdd: (title: string, remindAt?: string | null) => Promise<void>;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function TaskInput({ onAdd, onFocus, onBlur }: TaskInputProps) {
  const [title, setTitle] = useState("");
  const [isAdding, setIsAdding] = useState(false);
  // ⏰ 选择器显式设定的提醒时间；设定后优先于自然语言解析（以选择器修正为准）
  const [pickedRemindAt, setPickedRemindAt] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const parsed = useMemo(() => parseReminder(title), [title]);
  const preview = pickedRemindAt
    ? formatReminderPreview(dayjs(pickedRemindAt), dayjs())
    : parsed
      ? formatReminderPreview(parsed.time, dayjs())
      : null;

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle || isAdding) {
      return;
    }

    let remindAt: string | null = null;
    let taskTitle = trimmedTitle;
    if (pickedRemindAt) {
      remindAt = pickedRemindAt;
    } else if (parsed) {
      // 剥离命中片段后剩余文字作标题；剥完为空（如整句就是「明天9点」）则保留整句
      remindAt = parsed.time.toISOString();
      taskTitle = stripReminderText(trimmedTitle, parsed.matchedText) || trimmedTitle;
    }

    setIsAdding(true);
    try {
      await onAdd(taskTitle, remindAt);
      setTitle("");
      setPickedRemindAt(null);
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
        placeholder="添加任务，如：明天9点开会"
        type="text"
        value={title}
      />
      <div className="absolute right-[4px] top-1/2 flex -translate-y-1/2 items-center">
        <button
          aria-label="设置提醒时间"
          className="icon-btn icon-btn-sm"
          onClick={() => setPickerOpen(true)}
          title="设置提醒时间"
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
      {/* 实时预览：小字灰色；解析失败且未用选择器设定时不显示 */}
      {preview ? (
        <p className="truncate pt-1 text-[11px] leading-4 text-[color:var(--fg-faint)]">
          将提醒：{preview}
        </p>
      ) : null}
      {pickerOpen ? (
        <ReminderPicker
          initial={pickedRemindAt}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(remindAt) => {
            setPickedRemindAt(remindAt);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </form>
  );
}

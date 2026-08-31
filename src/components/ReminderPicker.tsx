import { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

interface ReminderPickerProps {
  /** 现有提醒时间（ISO）；null = 尚未设置（不显示「清除提醒」） */
  initial: string | null;
  /** 触发控件在视口中的位置：弹层钉在它下方、右缘对齐 */
  anchor: { top: number; right: number };
  /** 传入时显示任务标题输入框（编辑模式），确认回调带 title */
  initialTitle?: string;
  /** 确定：remindAt=null 表示清除提醒；title 仅编辑模式携带 */
  onConfirm: (result: { remindAt: string | null; title?: string }) => void;
  onCancel: () => void;
}

const CARD_WIDTH = 250;
const CARD_HEIGHT = 116;
const EDIT_CARD_EXTRA_HEIGHT = 40;

/** 可选时间只有整点和半点（docs/05 任务卡 M2-3 修复项 5） */
const HALF_HOUR_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? "00" : "30";
  return `${String(hour).padStart(2, "0")}:${minute}`;
});

/** 向上取整到下一个整点/半点（23:01 → 23:30；正好落在半点上则不变） */
function ceilToHalfHour(time: Dayjs): Dayjs {
  const minutes = time.minute();
  const rounded =
    minutes % 30 === 0 && time.second() === 0 ? minutes : minutes < 30 ? 30 : 60;
  return time.minute(rounded).second(0).millisecond(0);
}

/**
 * Win11 风格提醒时间小弹层（docs/01 第 4.3 节「修正方式」）。
 * 日期 + 整点/半点下拉（打开时滚动到当前选中项）；可选任务标题编辑。
 * 点卡片外即取消。
 */
export function ReminderPicker({
  initial,
  anchor,
  initialTitle,
  onConfirm,
  onCancel,
}: ReminderPickerProps) {
  const editMode = initialTitle !== undefined;
  const initialDay = initial ? dayjs(initial) : null;
  const defaultDay = initialDay
    ? ceilToHalfHour(initialDay)
    : ceilToHalfHour(dayjs().add(1, "hour"));
  const [dateStr, setDateStr] = useState(defaultDay.format("YYYY-MM-DD"));
  const [timeStr, setTimeStr] = useState(defaultDay.format("HH:mm"));
  const [titleText, setTitleText] = useState(initialTitle ?? "");
  const [timeListOpen, setTimeListOpen] = useState(false);
  const timeListRef = useRef<HTMLDivElement>(null);

  // 下拉打开时把当前选中项滚到可见处（作为列表的“头”）
  useEffect(() => {
    if (timeListOpen) {
      timeListRef.current
        ?.querySelector("[data-selected='true']")
        ?.scrollIntoView({ block: "center" });
    }
  }, [timeListOpen]);

  const selected = dateStr && timeStr ? dayjs(`${dateStr}T${timeStr}`) : null;
  const trimmedTitle = titleText.trim();
  const isValid =
    selected !== null && selected.isValid() && (!editMode || trimmedTitle !== "");

  const left = Math.max(
    8,
    Math.min(anchor.right - CARD_WIDTH, window.innerWidth - CARD_WIDTH - 8),
  );
  const top = Math.min(
    anchor.top,
    window.innerHeight - (CARD_HEIGHT + (editMode ? EDIT_CARD_EXTRA_HEIGHT : 0)) - 8,
  );

  function confirm() {
    if (!selected || !isValid) {
      return;
    }
    onConfirm({
      remindAt: selected.toISOString(),
      ...(editMode ? { title: trimmedTitle } : {}),
    });
  }

  return (
    <>
      <div aria-hidden className="picker-backdrop" onClick={onCancel} />
      <div
        aria-label="设置提醒时间"
        className="picker-card"
        role="dialog"
        style={{ top, left }}
      >
        {editMode ? (
          <input
            aria-label="任务标题"
            className="picker-input mb-2 w-full"
            onChange={(event) => setTitleText(event.target.value)}
            placeholder="任务内容"
            type="text"
            value={titleText}
          />
        ) : null}
        <p className="pb-2 text-[12px] font-semibold leading-4">提醒时间</p>
        <div className="flex gap-1.5 pb-2.5">
          <input
            aria-label="提醒日期"
            className="picker-input min-w-0 flex-1"
            onChange={(event) => setDateStr(event.target.value)}
            type="date"
            value={dateStr}
          />
          <div className="relative w-[86px] shrink-0">
            <button
              aria-expanded={timeListOpen}
              aria-haspopup="listbox"
              className="picker-input flex w-full items-center justify-between"
              onClick={() => setTimeListOpen((open) => !open)}
              type="button"
            >
              <span>{timeStr}</span>
              <span aria-hidden className="text-[10px] text-[color:var(--fg-faint)]">
                ▼
              </span>
            </button>
            {timeListOpen ? (
              <div
                aria-label="提醒时间选项"
                className="picker-options"
                ref={timeListRef}
                role="listbox"
              >
                {HALF_HOUR_OPTIONS.map((option) => (
                  <button
                    aria-selected={option === timeStr}
                    className={`picker-option${option === timeStr ? " picker-option-selected" : ""}`}
                    data-selected={option === timeStr}
                    key={option}
                    onClick={() => {
                      setTimeStr(option);
                      setTimeListOpen(false);
                    }}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex items-center justify-between">
          {initial ? (
            <button
              className="picker-btn text-[color:var(--danger)]"
              onClick={() =>
                onConfirm({
                  remindAt: null,
                  ...(editMode ? { title: trimmedTitle } : {}),
                })
              }
              type="button"
            >
              清除提醒
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-1.5">
            <button className="picker-btn" onClick={onCancel} type="button">
              取消
            </button>
            <button
              className="picker-btn picker-btn-primary"
              disabled={!isValid}
              onClick={confirm}
              type="button"
            >
              确定
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

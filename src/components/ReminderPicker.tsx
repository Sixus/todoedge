import { useState } from "react";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

interface ReminderPickerProps {
  /** 现有提醒时间（ISO）；null = 尚未设置（不显示「清除提醒」） */
  initial: string | null;
  /** 触发控件在视口中的位置：弹层钉在它下方、右缘对齐 */
  anchor: { top: number; right: number };
  /** 确定：携带新时间 ISO；清除提醒：null */
  onConfirm: (remindAt: string | null) => void;
  onCancel: () => void;
}

const CARD_WIDTH = 250;
const CARD_HEIGHT = 116;

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
 * 日期 + 整点/半点下拉；默认选中接下来最近的半点。点卡片外即取消。
 */
export function ReminderPicker({ initial, anchor, onConfirm, onCancel }: ReminderPickerProps) {
  const initialDay = initial ? dayjs(initial) : null;
  const defaultDay = initialDay
    ? ceilToHalfHour(initialDay)
    : ceilToHalfHour(dayjs().add(1, "hour"));
  const [dateStr, setDateStr] = useState(defaultDay.format("YYYY-MM-DD"));
  const [timeStr, setTimeStr] = useState(defaultDay.format("HH:mm"));

  const selected = dateStr && timeStr ? dayjs(`${dateStr}T${timeStr}`) : null;
  const isValid = selected !== null && selected.isValid();

  // 跟随触发控件；面板宽度有限，水平钳在视口内
  const left = Math.max(
    8,
    Math.min(anchor.right - CARD_WIDTH, window.innerWidth - CARD_WIDTH - 8),
  );
  const top = Math.min(anchor.top, window.innerHeight - CARD_HEIGHT - 8);

  return (
    <>
      <div aria-hidden className="picker-backdrop" onClick={onCancel} />
      <div
        aria-label="设置提醒时间"
        className="picker-card"
        role="dialog"
        style={{ top, left }}
      >
        <p className="pb-2 text-[12px] font-semibold leading-4">提醒时间</p>
        <div className="flex gap-1.5 pb-2.5">
          <input
            aria-label="提醒日期"
            className="picker-input min-w-0 flex-1"
            onChange={(event) => setDateStr(event.target.value)}
            type="date"
            value={dateStr}
          />
          <select
            aria-label="提醒时间"
            className="picker-input w-[86px] shrink-0"
            onChange={(event) => setTimeStr(event.target.value)}
            value={timeStr}
          >
            {HALF_HOUR_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between">
          {initial ? (
            <button
              className="picker-btn text-[color:var(--danger)]"
              onClick={() => onConfirm(null)}
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
              onClick={() => selected && onConfirm(selected.toISOString())}
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

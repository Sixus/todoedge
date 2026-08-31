import { useState } from "react";
import dayjs from "dayjs";

interface ReminderPickerProps {
  /** 现有提醒时间（ISO）；null = 尚未设置（不显示「清除提醒」） */
  initial: string | null;
  /** 确定：携带新时间 ISO；清除提醒：null */
  onConfirm: (remindAt: string | null) => void;
  onCancel: () => void;
}

/**
 * Win11 风格提醒时间小弹层（docs/01 第 4.3 节「修正方式」）。
 * 日期 + 时间两段原生输入，确定/取消/清除提醒。点卡片外即取消。
 */
export function ReminderPicker({ initial, onConfirm, onCancel }: ReminderPickerProps) {
  const fallback = dayjs().add(1, "hour").startOf("minute");
  const initialDay = initial ? dayjs(initial) : null;
  const [dateStr, setDateStr] = useState(
    (initialDay ?? fallback).format("YYYY-MM-DD"),
  );
  const [timeStr, setTimeStr] = useState((initialDay ?? fallback).format("HH:mm"));

  const selected = dateStr && timeStr ? dayjs(`${dateStr}T${timeStr}`) : null;
  const isValid = selected !== null && selected.isValid();

  return (
    <>
      <div aria-hidden className="picker-backdrop" onClick={onCancel} />
      <div aria-label="设置提醒时间" className="picker-card" role="dialog">
        <p className="pb-2 text-[12px] font-semibold leading-4">提醒时间</p>
        <div className="flex gap-1.5 pb-2.5">
          <input
            aria-label="提醒日期"
            className="picker-input min-w-0 flex-1"
            onChange={(event) => setDateStr(event.target.value)}
            type="date"
            value={dateStr}
          />
          <input
            aria-label="提醒时间"
            className="picker-input w-[76px] shrink-0"
            onChange={(event) => setTimeStr(event.target.value)}
            type="time"
            value={timeStr}
          />
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

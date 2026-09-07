import { useEffect, useRef, useState } from "react";
import dayjs from "dayjs";
import type { Dayjs } from "dayjs";

import { ClockIcon, RepeatIcon } from "./icons";

interface ReminderPickerProps {
  /** 现有提醒时间（ISO）；null = 尚未设置（不显示「清除」） */
  initial: string | null;
  /** 任务当前重复规则（none|daily|weekly|monthly），重复行的初始选中值 */
  initialRepeat?: string;
  /** 触发控件在视口中的位置：弹层钉在它下方、右缘对齐 */
  anchor: { top: number; right: number };
  /** 传入时显示任务标题输入框（编辑模式），确认回调带 title */
  initialTitle?: string;
  /** 确定：remindAt=null 表示清除提醒（重复由后端一并重置）；repeat 仅设有提醒时间时生效 */
  onConfirm: (result: { remindAt: string | null; repeat?: string; title?: string }) => void;
  onCancel: () => void;
}

const CARD_WIDTH = 264;
/** 估算高度用于视口底部钳制：日历 + 时间行 + 重复行 + 大按钮（编辑模式再加标题行） */
const CARD_HEIGHT = 462;
const EDIT_EXTRA_HEIGHT = 40;

/** 可选时间只有整点和半点 */
const HALF_HOUR_OPTIONS = Array.from({ length: 48 }, (_, index) => {
  const hour = Math.floor(index / 2);
  const minute = index % 2 === 0 ? "00" : "30";
  return `${String(hour).padStart(2, "0")}:${minute}`;
});

/** 重复档位（M4-1）：不重复为默认；每年档不做 */
const REPEAT_OPTIONS = [
  { value: "none", label: "不重复" },
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "monthly", label: "每月" },
];

const WEEKDAY_HEADERS = ["日", "一", "二", "三", "四", "五", "六"];

/** 向上取整到下一个整点/半点（23:01 → 23:30；正好落在半点上则不变） */
function ceilToHalfHour(time: Dayjs): Dayjs {
  const minutes = time.minute();
  const rounded =
    minutes % 30 === 0 && time.second() === 0 ? minutes : minutes < 30 ? 30 : 60;
  return time.minute(rounded).second(0).millisecond(0);
}

/**
 * 三段式提醒选择弹层（用户参考系统日历样式）：
 * ① 日历选日期（可翻月）；② 整点/半点时间下拉；③ 重复行（常驻，M4-1）；
 * ④ 清除 / 确定两个大按钮。编辑模式在顶部多一个标题输入框。点卡片外即取消。
 */
export function ReminderPicker({
  initial,
  initialRepeat,
  anchor,
  initialTitle,
  onConfirm,
  onCancel,
}: ReminderPickerProps) {
  const editMode = initialTitle !== undefined;
  const initialDay = initial ? dayjs(initial) : null;
  // 默认选中接下来最近的半点：9:52 → 10:00（不额外加一小时）
  const defaultDay = initialDay
    ? ceilToHalfHour(initialDay)
    : ceilToHalfHour(dayjs());
  const [dateStr, setDateStr] = useState(defaultDay.format("YYYY-MM-DD"));
  const [timeStr, setTimeStr] = useState(defaultDay.format("HH:mm"));
  const [viewMonth, setViewMonth] = useState(() => defaultDay.startOf("month"));
  const [titleText, setTitleText] = useState(initialTitle ?? "");
  const [repeatText, setRepeatText] = useState(initialRepeat ?? "none");
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

  const selectedDay = dateStr ? dayjs(dateStr) : null;
  const trimmedTitle = titleText.trim();
  const isValid =
    selectedDay !== null &&
    selectedDay.isValid() &&
    (!editMode || trimmedTitle !== "");

  const left = Math.max(
    8,
    Math.min(anchor.right - CARD_WIDTH, window.innerWidth - CARD_WIDTH - 8),
  );
  const top = Math.max(
    8,
    Math.min(
      anchor.top,
      window.innerHeight - (CARD_HEIGHT + (editMode ? EDIT_EXTRA_HEIGHT : 0)) - 8,
    ),
  );

  /** 日历格子：从本月第一格（周日起）到铺满整行，包含前后月的补位 */
  function calendarCells(): Dayjs[] {
    const first = viewMonth.startOf("month");
    const start = first.subtract(first.day(), "day");
    const rows = Math.ceil((first.daysInMonth() + first.day()) / 7);
    return Array.from({ length: rows * 7 }, (_, index) => start.add(index, "day"));
  }

  function confirm() {
    if (!selectedDay || !isValid) {
      return;
    }
    onConfirm({
      remindAt: selectedDay.hour(Number(timeStr.slice(0, 2))).minute(Number(timeStr.slice(3, 5))).toISOString(),
      repeat: repeatText,
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
        style={{ top, left, width: CARD_WIDTH }}
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

        {/* ① 日历 */}
        <div className="flex items-center justify-between pb-1.5">
          <span className="text-[13px] font-semibold text-[color:var(--fg)]">
            {viewMonth.format("YYYY年M月")}
          </span>
          <div className="flex items-center gap-0.5">
            <button
              aria-label="上个月"
              className="picker-cal-nav"
              onClick={() => setViewMonth(viewMonth.subtract(1, "month"))}
              type="button"
            >
              ‹
            </button>
            <button
              aria-label="下个月"
              className="picker-cal-nav"
              onClick={() => setViewMonth(viewMonth.add(1, "month"))}
              type="button"
            >
              ›
            </button>
          </div>
        </div>
        <div aria-hidden className="picker-weekrow">
          {WEEKDAY_HEADERS.map((header) => (
            <span key={header}>{header}</span>
          ))}
        </div>
        <div aria-label="选择日期" className="picker-calgrid" role="grid">
          {calendarCells().map((cell) => {
            const inMonth = cell.month() === viewMonth.month();
            const isSelected = selectedDay?.isSame(cell, "day") ?? false;
            const isToday = cell.isSame(dayjs(), "day");
            return (
              <button
                aria-selected={isSelected}
                className={`picker-cell${inMonth ? "" : " picker-cell-muted"}${
                  isSelected ? " picker-cell-selected" : isToday ? " picker-cell-today" : ""
                }`}
                key={cell.format("YYYY-MM-DD")}
                onClick={() => {
                  setDateStr(cell.format("YYYY-MM-DD"));
                  setViewMonth(cell.startOf("month"));
                }}
                type="button"
              >
                {cell.date()}
              </button>
            );
          })}
        </div>

        {/* ② 时间（整点/半点下拉） */}
        <div className="relative mt-1.5 border-t border-[var(--border-subtle)] pt-1.5">
          <button
            aria-expanded={timeListOpen}
            aria-haspopup="listbox"
            className="picker-time-row"
            onClick={() => setTimeListOpen((open) => !open)}
            type="button"
          >
            <ClockIcon className="h-4 w-4" />
            <span className="flex-1 text-left tabular-nums">{timeStr}</span>
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

        {/* ③ 重复行（M4-1）：常驻显示——弹层的确定必然携带时间，顺手选重复；
            只点「清除」时重复由后端一并重置 none */}
        <div aria-label="重复" className="picker-repeat-row mt-1.5" role="radiogroup">
          <RepeatIcon className="h-4 w-4 shrink-0" />
          <div className="picker-repeat-options">
            {REPEAT_OPTIONS.map((option) => (
              <button
                aria-checked={option.value === repeatText}
                className={`picker-repeat-option${
                  option.value === repeatText ? " picker-repeat-option-selected" : ""
                }`}
                key={option.value}
                onClick={() => setRepeatText(option.value)}
                role="radio"
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {/* ④ 清除 / 确定两个大按钮 */}
        <div className="mt-2.5 flex gap-2">
          {initial !== null ? (
            <button
              className="picker-btn-big"
              onClick={() =>
                onConfirm({
                  remindAt: null,
                  ...(editMode ? { title: trimmedTitle } : {}),
                })
              }
              type="button"
            >
              清除
            </button>
          ) : null}
          <button
            className="picker-btn-big picker-btn-big-primary"
            disabled={!isValid}
            onClick={confirm}
            type="button"
          >
            确定
          </button>
        </div>
      </div>
    </>
  );
}

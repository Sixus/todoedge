import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { Task } from "../lib/api";
import { buildReportText, completedInWeek, formatWeekRange, weekStartOf } from "../lib/week";
import { TrashIcon, XIcon } from "./icons";

interface ReportViewProps {
  tasks: Task[];
  onDelete: (id: number) => Promise<void>;
  onClose: () => void;
}

/**
 * 周报视图（docs/01 5.4 节）：点底栏「已完成」进入，弹层覆盖整个面板。
 * ISO 周（周一起始）默认当前周，‹ › 翻历史周；底部一键复制纯文本周报。
 * 行删除与主界面一致：hover 出 ×，点一次变红垃圾桶，再点才删（2026-09-01 反馈）。
 */
export function ReportView({ tasks, onDelete, onClose }: ReportViewProps) {
  // 当前定位周的周一锚点；‹ › 无限翻周
  const [weekStart, setWeekStart] = useState(() => weekStartOf(dayjs()));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  // 删除二次确认：点一下变红色垃圾桶，再点才删（3 秒不点自动还原）；一次只确认一行
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const confirmTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current);
      }
    },
    [],
  );

  const weekTasks = useMemo(() => completedInWeek(tasks, weekStart), [tasks, weekStart]);
  const isCurrentWeek = weekStartOf(dayjs()).isSame(weekStart, "day");

  async function copyReport() {
    try {
      await writeText(buildReportText(weekTasks));
      setError(null);
      setCopied(true);
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
      }
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function handleDeleteClick(id: number) {
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    if (confirmingId !== id) {
      setConfirmingId(id);
      confirmTimer.current = window.setTimeout(() => setConfirmingId(null), 3000);
      return;
    }
    setConfirmingId(null);
    void onDelete(id);
  }

  return (
    <div className="report-overlay">
      <header className="report-header">
        <div className="report-nav">
          <button
            aria-label="上一周"
            className="settings-back"
            onClick={() => setWeekStart((current) => current.subtract(7, "day"))}
            title="上一周"
            type="button"
          >
            ‹
          </button>
          <h1 className="report-title">{formatWeekRange(weekStart)}</h1>
          <button
            aria-label="下一周"
            className="settings-back"
            disabled={isCurrentWeek}
            onClick={() => setWeekStart((current) => current.add(7, "day"))}
            title={isCurrentWeek ? "已经在当前周" : "下一周"}
            type="button"
          >
            ›
          </button>
        </div>
        <button aria-label="返回任务清单" className="report-back" onClick={onClose} title="返回" type="button">
          返回
        </button>
      </header>

      {weekTasks.length === 0 ? (
        <p className="report-empty">本周还没有完成的任务</p>
      ) : (
        <ul className="report-list task-scroll">
          {weekTasks.map((task) => {
            const confirming = confirmingId === task.id;
            return (
              <li className="report-row group" key={task.id}>
                <span className="report-date">{dayjs(task.doneAt as string).format("MM-DD")}</span>
                <span className="report-row-title">{task.title}</span>
                <button
                  aria-label={
                    confirming ? `再次点击确认删除任务「${task.title}」` : `删除任务「${task.title}」`
                  }
                  className={`icon-btn icon-btn-sm shrink-0 transition-opacity duration-150 focus-visible:opacity-100 ${
                    confirming
                      ? "text-[#c50f1f]! opacity-100 hover:text-[#c50f1f]!"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={() => handleDeleteClick(task.id)}
                  title={confirming ? "再次点击确认删除" : "删除任务"}
                  type="button"
                >
                  {confirming ? (
                    <TrashIcon className="h-[14px] w-[14px]" />
                  ) : (
                    <XIcon className="h-[14px] w-[14px]" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {error ? <p className="report-error">复制失败：{error}</p> : null}

      <footer className="report-footer">
        <button
          className="report-copy"
          disabled={weekTasks.length === 0}
          onClick={() => void copyReport()}
          type="button"
        >
          {copied ? "已复制 ✓" : "复制周报"}
        </button>
      </footer>
    </div>
  );
}

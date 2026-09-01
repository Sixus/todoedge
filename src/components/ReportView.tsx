import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import type { Task } from "../lib/api";
import { buildReportText, completedInWeek, formatWeekRange, weekStartOf } from "../lib/week";

interface ReportViewProps {
  tasks: Task[];
  onClose: () => void;
}

/**
 * 周报视图（docs/01 5.4 节）：点底栏「已完成」进入，弹层覆盖整个面板。
 * ISO 周（周一起始）默认当前周，‹ › 翻历史周；底部一键复制纯文本周报。
 */
export function ReportView({ tasks, onClose }: ReportViewProps) {
  // 当前定位周的周一锚点；‹ › 无限翻周
  const [weekStart, setWeekStart] = useState(() => weekStartOf(dayjs()));
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) {
        window.clearTimeout(copiedTimer.current);
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
          {weekTasks.map((task) => (
            <li className="report-row" key={task.id}>
              <span className="report-date">{dayjs(task.doneAt as string).format("MM-DD")}</span>
              <span className="report-row-title">{task.title}</span>
            </li>
          ))}
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

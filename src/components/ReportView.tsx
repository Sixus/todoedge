import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

import { api, type Completion } from "../lib/api";
import { buildReportText, completedInWeek, formatWeekRange, weekStartOf } from "../lib/week";
import { TrashIcon, XIcon } from "./icons";

interface ReportViewProps {
  /** 删除一条完成记录（M4-1 起数据源为 completions；任务本体不动） */
  onDelete: (completion: Completion) => Promise<void>;
  onClose: () => void;
  /** 变化信号：撤销删除插回记录后自增，触发重拉（周报开着也能看到记录回来） */
  reloadSignal: number;
}

/**
 * 周报视图（docs/01 5.4 节）：点底栏「已完成」进入，弹层覆盖整个面板。
 * ISO 周（周一起始）默认当前周，‹ › 翻历史周；底部一键复制纯文本周报。
 * 数据源为 completions 完成记录表（M4-1）：勾选即结算，翻历史周不丢。
 * 行删除只删记录：hover 出 ×，点一次变红垃圾桶，再点才删（2026-09-01 反馈）。
 */
export function ReportView({ onDelete, onClose, reloadSignal }: ReportViewProps) {
  // 当前定位周的周一锚点；‹ › 无限翻周
  const [weekStart, setWeekStart] = useState(() => weekStartOf(dayjs()));
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  // 删除二次确认：点一下变红色垃圾桶，再点才删（3 秒不点自动还原）；一次只确认一行
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const confirmTimer = useRef<number | null>(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      setCompletions(await api.listCompletions());
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, reloadSignal]);

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

  const weekCompletions = useMemo(
    () => completedInWeek(completions, weekStart),
    [completions, weekStart],
  );
  const isCurrentWeek = weekStartOf(dayjs()).isSame(weekStart, "day");

  async function copyReport() {
    try {
      await writeText(buildReportText(weekCompletions));
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

  function handleDeleteClick(completion: Completion) {
    if (confirmTimer.current !== null) {
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = null;
    }
    if (confirmingId !== completion.id) {
      setConfirmingId(completion.id);
      confirmTimer.current = window.setTimeout(() => setConfirmingId(null), 3000);
      return;
    }
    setConfirmingId(null);
    void onDelete(completion).then(reload);
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

      {loadError ? (
        <p className="report-empty">加载失败：{loadError}</p>
      ) : weekCompletions.length === 0 ? (
        <p className="report-empty">本周还没有完成的任务</p>
      ) : (
        <ul className="report-list task-scroll">
          {weekCompletions.map((completion) => {
            const confirming = confirmingId === completion.id;
            return (
              <li className="report-row group" key={completion.id}>
                <span className="report-date">{dayjs(completion.doneAt).format("MM-DD")}</span>
                <span className="report-row-title">{completion.title}</span>
                <button
                  aria-label={
                    confirming
                      ? `再次点击确认删除记录「${completion.title}」`
                      : `删除记录「${completion.title}」`
                  }
                  className={`icon-btn icon-btn-sm shrink-0 transition-opacity duration-150 focus-visible:opacity-100 ${
                    confirming
                      ? "text-[#c50f1f]! opacity-100 hover:text-[#c50f1f]!"
                      : "opacity-0 group-hover:opacity-100"
                  }`}
                  onClick={() => handleDeleteClick(completion)}
                  title={confirming ? "再次点击确认删除" : "删除记录"}
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
          disabled={weekCompletions.length === 0}
          onClick={() => void copyReport()}
          type="button"
        >
          {copied ? "已复制 ✓" : "复制周报"}
        </button>
      </footer>
    </div>
  );
}

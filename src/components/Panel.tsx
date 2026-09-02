import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";

import type { Task } from "../lib/api";
import { formatOverviewDate } from "../lib/format";
import { CompletedIcon, PinIcon, SettingsIcon } from "./icons";
import { ReportView } from "./ReportView";
import { SettingsView } from "./SettingsView";
import { TaskInput } from "./TaskInput";
import { TaskList } from "./TaskList";

interface PanelProps {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  /** 图钉固定：固定时屏蔽一切自动收起（移出/点外部/Esc/失焦），全屏强制收回除外 */
  pinned: boolean;
  onTogglePin: () => void;
  onAdd: (title: string, remindAt?: string | null) => Promise<void>;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 编辑任务标题 + 提醒时间（M2-3 编辑弹层；null = 清除提醒） */
  onEditTask: (id: number, title: string, remindAt: string | null) => Promise<void>;
  /** 拖拽排序落定：按新顺序提交全部任务 id */
  onReorder: (orderedIds: number[]) => Promise<void>;
  onCollapse: () => void;
  onEditingChange: (editing: boolean) => void;
  /** Toast「点主体」呼出时要求高亮的任务 id（M2-1） */
  highlightTaskId: number | null;
  onHighlightEnd: () => void;
}

export function Panel({
  tasks,
  isLoading,
  error,
  pinned,
  onTogglePin,
  onAdd,
  onToggle,
  onDelete,
  onEditTask,
  onReorder,
  onCollapse,
  onEditingChange,
  highlightTaskId,
  onHighlightEnd,
}: PanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const collapseTimer = useRef<number | null>(null);
  const isEditingRef = useRef(false);
  // 图钉最新值镜像：requestCollapse 会被首挂载的事件监听器/定时器闭包调用，
  // 直接读 props 会拿到过期值（首帧 pinned=false），固定后仍会收起
  const pinnedRef = useRef(pinned);
  const [isEditing, setIsEditing] = useState(false);
  // 设置视图：覆盖在面板内容上（M2-4 反馈后从独立小窗改为面板内嵌）
  const [showSettings, setShowSettings] = useState(false);
  // 周报视图：点底栏「已完成」覆盖面板（M3-1）
  const [showReport, setShowReport] = useState(false);

  // 图钉激活时清掉已排队的自动收起，并同步镜像供各事件闭包读取
  useEffect(() => {
    pinnedRef.current = pinned;
    if (pinned) {
      clearCollapseTimer();
    }
  }, [pinned]);

  // 当前时刻：面板长开时也要流动，否则概览统计/过期标记/排序会停在挂载瞬间
  const [now, setNow] = useState(() => dayjs());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(dayjs()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  // 概览计数（01 文档 5.2 节）：过期 = 提醒已过且未完成；今日 = 提醒在今天且未完成
  const { overdueCount, todayCount } = useMemo(() => {
    let overdue = 0;
    let today = 0;
    for (const task of tasks) {
      if (task.done || !task.remindAt) {
        continue;
      }
      const remind = dayjs(task.remindAt);
      if (remind.isBefore(now)) {
        overdue += 1;
      }
      if (remind.isSame(now, "day")) {
        today += 1;
      }
    }
    return { overdueCount: overdue, todayCount: today };
  }, [tasks, now]);
  const pendingCount = tasks.filter((task) => !task.done).length;

  function clearCollapseTimer() {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
  }

  function requestCollapse() {
    // 图钉固定：移出/点外部/Esc/失焦等自动收起全部失效（读 ref 保证非过期值）
    if (pinnedRef.current) {
      return;
    }
    clearCollapseTimer();
    onEditingChange(false);
    onCollapse();
  }

  function handleMouseLeave() {
    if (isEditing) {
      return;
    }

    clearCollapseTimer();
    collapseTimer.current = window.setTimeout(() => {
      collapseTimer.current = null;
      requestCollapse();
    }, 1500);
  }

  function handleInputFocus() {
    clearCollapseTimer();
    isEditingRef.current = true;
    setIsEditing(true);
    onEditingChange(true);
  }

  function handleInputBlur() {
    isEditingRef.current = false;
    setIsEditing(false);
    onEditingChange(false);
  }

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        requestCollapse();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCollapse();
      }
    }

    function handleWindowBlur() {
      if (isEditingRef.current) {
        requestCollapse();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      clearCollapseTimer();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("blur", handleWindowBlur);
      isEditingRef.current = false;
      onEditingChange(false);
    };
  }, [onEditingChange]);

  return (
    <main
      className="relative flex h-full w-full flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)] text-[color:var(--fg)] outline-none"
      onMouseEnter={clearCollapseTimer}
      onMouseLeave={handleMouseLeave}
      ref={panelRef}
      tabIndex={-1}
    >
      {showReport ? (
        <ReportView onClose={() => setShowReport(false)} onDelete={onDelete} tasks={tasks} />
      ) : showSettings ? (
        <SettingsView onClose={() => setShowSettings(false)} />
      ) : (
        <>
          {/* ① 概览区 */}
      <header className="flex items-baseline justify-between gap-2 pb-2 pl-5 pr-5 pt-4">
        <h1 className="text-xl font-semibold leading-7">
          {formatOverviewDate(now)}
        </h1>
        <p className="flex shrink-0 items-baseline text-xs leading-4">
          <span
            className={
              overdueCount > 0
                ? "font-semibold text-[color:var(--danger)]"
                : "text-[color:var(--fg-muted)]"
            }
          >
            过期 {overdueCount}
          </span>
          <span aria-hidden className="px-1 text-[color:var(--fg-faint)]">
            ·
          </span>
          <span className="text-[color:var(--fg-muted)]">今日 {todayCount}</span>
        </p>
      </header>

      {/* ② 新建任务区 */}
      <div className="px-5 pb-2.5">
        <TaskInput onAdd={onAdd} onBlur={handleInputBlur} onFocus={handleInputFocus} />
      </div>

      {/* ③ 任务清单区 */}
      <section
        aria-label="任务清单"
        className="task-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-2"
      >
        {isLoading ? (
          <p className="mt-10 text-center text-[13px] text-[color:var(--fg-muted)]">加载中…</p>
        ) : null}
        {!isLoading && error ? (
          <p className="mt-10 text-center text-[13px] text-[color:var(--danger)]">
            加载失败：{error}
          </p>
        ) : null}
        {!isLoading && !error ? (
          <TaskList
            highlightTaskId={highlightTaskId}
            now={now}
            onHighlightEnd={onHighlightEnd}
            onDelete={onDelete}
            onEditTask={onEditTask}
            onReorder={(orderedIds) => void onReorder(orderedIds)}
            onToggle={onToggle}
            tasks={tasks}
          />
        ) : null}
      </section>

      {/* ④ 底栏 */}
      <footer className="flex items-center justify-between border-t border-[var(--border-subtle)] py-1.5 pl-5 pr-2.5">
        <span className="text-xs text-[color:var(--fg-muted)]">未完成 {pendingCount}</span>
        <div className="flex items-center">
          <button
            aria-label="已完成"
            className="icon-btn"
            onClick={() => setShowReport(true)}
            title="已完成（周报）"
            type="button"
          >
            <CompletedIcon className="h-[18px] w-[18px]" />
          </button>
          <button
            aria-label={pinned ? "取消固定面板" : "固定面板"}
            aria-pressed={pinned}
            className={`icon-btn ${pinned ? "pin-active" : ""}`}
            onClick={onTogglePin}
            title={pinned ? "取消固定" : "固定面板（不自动收回）"}
            type="button"
          >
            <PinIcon className="h-[18px] w-[18px]" />
          </button>
          <button
            aria-label="设置"
            className="icon-btn"
            onClick={() => setShowSettings(true)}
            title="设置"
            type="button"
          >
            <SettingsIcon className="h-[18px] w-[18px]" />
          </button>
        </div>
      </footer>
        </>
      )}
    </main>
  );
}

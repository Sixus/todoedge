import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import dayjs from "dayjs";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, type Completion, type ResizeDirection, type Task } from "../lib/api";
import type { AppMode } from "../lib/appMode";
import { formatOverviewDate } from "../lib/format";
import { CompletedIcon, LockIcon, PinIcon, SettingsIcon } from "./icons";
import { ReportView } from "./ReportView";
import { SettingsView } from "./SettingsView";
import { TaskInput } from "./TaskInput";
import { TaskList } from "./TaskList";

interface PanelProps {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  /** 全局动画总开关：提示条与清单内动画据此启停（窗口滑出/缩进在 Rust 侧） */
  animationsEnabled: boolean;
  /** 运行模式（贴边/窗口）：窗口模式下面板常驻展开，标题栏可拖动窗口 */
  appMode: AppMode;
  onChangeAppMode: (mode: AppMode) => void;
  /** 贴边时机（毫秒）：离开面板多久后自动收回；设置页透传给 SettingsView 编辑 */
  leaveCollapseMs: number;
  hoverExpandMs: number;
  onChangeHoverExpand: (ms: number) => void;
  onChangeLeaveCollapse: (ms: number) => void;
  /** 图钉固定：固定时屏蔽一切自动收起（移出/点外部/Esc/失焦），全屏强制收回除外 */
  pinned: boolean;
  onTogglePin: () => void;
  onChangeAnimations: (enabled: boolean) => void;
  onAdd: (title: string, remindAt?: string | null) => Promise<void>;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  /** 撤销删除：按删除前快照原样恢复（M4 撤销 toast 用） */
  onRestoreTask: (task: Task) => Promise<void>;
  /** 编辑任务标题 + 提醒时间 + 重复规则（M2-3 编辑弹层；null = 清除提醒） */
  onEditTask: (
    id: number,
    title: string,
    remindAt: string | null,
    repeat?: string,
  ) => Promise<void>;
  /** 拖拽排序落定：按新顺序提交全部任务 id */
  onReorder: (orderedIds: number[]) => Promise<void>;
  onCollapse: () => void;
  onEditingChange: (editing: boolean) => void;
  /** Toast「点主体」呼出时要求高亮的任务 id（M2-1） */
  highlightTaskId: number | null;
  onHighlightEnd: () => void;
  /** 托盘「打开设置」信号（M4-3）：App 层监听事件后递增，Panel 见变化即弹设置 */
  openSettingsSignal: number;
}

export function Panel({
  tasks,
  isLoading,
  error,
  animationsEnabled,
  appMode,
  onChangeAppMode,
  leaveCollapseMs,
  hoverExpandMs,
  onChangeHoverExpand,
  onChangeLeaveCollapse,
  pinned,
  onTogglePin,
  onChangeAnimations,
  onAdd,
  onToggle,
  onDelete,
  onRestoreTask,
  onEditTask,
  onReorder,
  onCollapse,
  onEditingChange,
  highlightTaskId,
  onHighlightEnd,
  openSettingsSignal,
}: PanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  // 窗口模式无边框：标题栏作为拖动区（data-tauri-drag-region 要落在
  // 指针命中的确切元素上，所以 h1/p/span 也得带）
  const windowDraggable = appMode === "window";
  const dragRegionProps = windowDraggable
    ? { "data-tauri-drag-region": "" }
    : {};
  // 窗口模式边缘缩放把手：无边框窗口的原生缩放命中会被 WebView 子窗口挡住，
  // 按住把手触发系统缩放循环。把手只盖面板内边距/留白，不压任务行与按钮；
  // 设置/周报覆盖层（z-50）在其上，覆盖层打开时把手自然失效。
  const startResize = (direction: ResizeDirection) => (
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    void api.startResizeDragging(direction).catch(() => undefined);
  };

  // 锁屏覆盖层：原地松手=解锁；按住拖出阈值=挪窗口（复用系统拖动循环）。
  // 拖动开始后指针被系统拖动循环接管，不会误触解锁。
  function beginLockPointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    lockPointer.current = { x: event.clientX, y: event.clientY, dragging: false };
  }

  function moveLockPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const start = lockPointer.current;
    if (!start || start.dragging) {
      return;
    }
    if (Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 6) {
      start.dragging = true;
      void getCurrentWindow().startDragging().catch(() => undefined);
    }
  }

  function endLockPointer() {
    const start = lockPointer.current;
    lockPointer.current = null;
    if (start && !start.dragging) {
      setLocked(false);
    }
  }
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
  // 周报重拉信号：撤销删除记录插回后自增，开着的周报立刻看到记录回来（M4-1）
  const [reportReloadTick, setReportReloadTick] = useState(0);
  // 撤销 toast（M4 反馈）：完成/删除后底部弹出，15 秒内可撤销；
  // 多条并存堆叠展示，新触发的排在旧的上方，各自独立倒计时
  const [undoToasts, setUndoToasts] = useState<
    Array<{ id: number; message: string; undo: () => void }>
  >([]);
  const undoTimers = useRef(new Map<number, number>());
  const nextUndoToastId = useRef(0);
  // 正在播渐隐退场动画的提示条：动画结束后才真正移除（关动画时直接移除）
  const [closingToastIds, setClosingToastIds] = useState<number[]>([]);
  // 隐私锁：锁定后覆盖层盖住全部内容，点击锁屏解锁（严格模式：激活不解锁）
  const [locked, setLocked] = useState(false);
  const lockPointer = useRef<{ x: number; y: number; dragging: boolean } | null>(
    null,
  );

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
    }, leaveCollapseMs);
  }

  // 卸载时清掉所有撤销提示的自动消失定时器
  useEffect(() => {
    const timers = undoTimers.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  // 隐私锁：Rust 失焦计时到点 / 底栏锁头按钮 → 上锁；点击锁屏解锁（严格模式）
  useEffect(() => {
    const unlisten = listen("panel-lock", () => setLocked(true));
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  // 托盘「打开设置」（M4-3）：信号由常驻的 App 层接收计数（贴边收起时 Panel
  // 卸载，事件必须在那里等）；面板挂载后见信号变化即打开设置弹层并解锁
  useEffect(() => {
    if (openSettingsSignal > 0) {
      setShowSettings(true);
      setLocked(false);
    }
  }, [openSettingsSignal]);

  function removeUndoToast(id: number) {
    const timer = undoTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      undoTimers.current.delete(id);
    }
    setUndoToasts((current) => current.filter((toast) => toast.id !== id));
  }

  /** 两段式收起：开动画时先渐隐再移除；关动画时直接移除 */
  function beginUndoToastClose(id: number) {
    if (!animationsEnabled) {
      removeUndoToast(id);
      return;
    }
    setClosingToastIds((current) =>
      current.includes(id) ? current : [...current, id],
    );
    window.setTimeout(() => {
      setClosingToastIds((current) => current.filter((closing) => closing !== id));
      removeUndoToast(id);
    }, 180);
  }

  function showUndoToast(message: string, undo: () => void) {
    const id = nextUndoToastId.current++;
    setUndoToasts((current) => [{ id, message, undo }, ...current]);
    undoTimers.current.set(
      id,
      window.setTimeout(() => {
        undoTimers.current.delete(id);
        beginUndoToastClose(id);
      }, 15000),
    );
  }

  function handleUndoClick(id: number) {
    const toast = undoToasts.find((item) => item.id === id);
    beginUndoToastClose(id);
    toast?.undo();
  }

  /** 打勾完成才弹撤销提示；取消勾选不弹（撤销只覆盖「完成后/删除后」） */
  function handleToggleWithUndo(id: number) {
    const task = tasks.find((item) => item.id === id);
    const willComplete = task ? !task.done : false;
    return onToggle(id).then(() => {
      if (task && willComplete) {
        showUndoToast(`已完成「${task.title}」`, () => {
          onToggle(id).catch(() => undefined);
        });
      }
    });
  }

  /** 删除前留存快照，撤销时按快照原样恢复（含原 id 与手动排序） */
  function handleDeleteWithUndo(id: number) {
    const snapshot = tasks.find((item) => item.id === id);
    return onDelete(id).then(() => {
      if (snapshot) {
        showUndoToast(`已删除「${snapshot.title}」`, () => {
          onRestoreTask(snapshot).catch(() => undefined);
        });
      }
    });
  }

  /** 删除一条完成记录（周报，M4-1）：只删记录，撤销=原样插回；
   *  插回后 bump 信号让开着的周报立刻重拉 */
  function handleDeleteCompletionWithUndo(completion: Completion) {
    return api.deleteCompletion(completion.id).then(() => {
      showUndoToast(`已删除「${completion.title}」`, () => {
        api
          .restoreCompletion(completion)
          .then(() => setReportReloadTick((tick) => tick + 1))
          .catch(() => undefined);
      });
    });
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

    // 仅文本类输入算「编辑中」（01 文档第 68 行），勾选框/普通按钮不算
    function isTextInput(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) {
        return false;
      }
      if (target.isContentEditable) {
        return true;
      }
      if (target instanceof HTMLInputElement) {
        return ["", "text", "search", "url"].includes(target.type);
      }
      return target instanceof HTMLTextAreaElement;
    }

    // 编辑态统一在面板层用 focusin/focusout 判定：除新建输入框外，
    // 任务编辑弹层的标题输入框也必须算编辑中——否则编辑任务打字时，
    // 鼠标一离开面板，1.5 秒后被当空闲态自动收回（用户反馈 2026-09-03）
    function handleFocusIn(event: FocusEvent) {
      if (isTextInput(event.target)) {
        handleInputFocus();
      }
    }

    function handleFocusOut(event: FocusEvent) {
      if (isTextInput(event.target)) {
        handleInputBlur();
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
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      clearCollapseTimer();
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      window.removeEventListener("blur", handleWindowBlur);
      isEditingRef.current = false;
      onEditingChange(false);
    };
  }, [onEditingChange]);

  return (
    <main
      className={`relative flex h-full w-full flex-col overflow-hidden border border-[var(--border)] bg-[var(--bg)] text-[color:var(--fg)] outline-none${
        appMode === "window" ? " rounded-lg" : " rounded-xl"
      }${animationsEnabled ? "" : " animations-off"}`}
      onMouseEnter={clearCollapseTimer}
      onMouseLeave={handleMouseLeave}
      ref={panelRef}
      tabIndex={-1}
    >
      {showReport ? (
        <ReportView
          onClose={() => setShowReport(false)}
          onDelete={handleDeleteCompletionWithUndo}
          reloadSignal={reportReloadTick}
        />
      ) : showSettings ? (
        <SettingsView
          animationsEnabled={animationsEnabled}
          onChangeAnimations={onChangeAnimations}
          appMode={appMode}
          hoverExpandMs={hoverExpandMs}
          leaveCollapseMs={leaveCollapseMs}
          onChangeHoverExpand={onChangeHoverExpand}
          onChangeLeaveCollapse={onChangeLeaveCollapse}
          onChangeAppMode={onChangeAppMode}
          onClose={() => setShowSettings(false)}
        />
      ) : (
        <>
          {/* ① 概览区（窗口模式下即标题栏，可拖动窗口） */}
      <header
        className="flex items-baseline justify-between gap-2 pb-2 pl-5 pr-5 pt-4"
        {...dragRegionProps}
      >
        <h1 className="text-xl font-semibold leading-7" {...dragRegionProps}>
          {formatOverviewDate(now)}
        </h1>
        <p
          className="flex shrink-0 items-baseline text-xs leading-4"
          {...dragRegionProps}
        >
          <span
            className={
              overdueCount > 0
                ? "font-semibold text-[color:var(--danger)]"
                : "text-[color:var(--fg-muted)]"
            }
            {...dragRegionProps}
          >
            过期 {overdueCount}
          </span>
          <span aria-hidden className="px-1 text-[color:var(--fg-faint)]" {...dragRegionProps}>
            ·
          </span>
          <span className="text-[color:var(--fg-muted)]" {...dragRegionProps}>
            今日 {todayCount}
          </span>
        </p>
      </header>

      {/* ② 新建任务区（编辑态判定已上收到面板层 focusin/focusout） */}
      <div className="px-5 pb-2.5">
        <TaskInput onAdd={onAdd} />
      </div>

      {/* ③ 任务清单区（窗口模式右缘留出缩放把手位，滚动条随之内移） */}
      <section
        aria-label="任务清单"
        className={`task-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-2${
          windowDraggable ? " task-scroll-resize" : ""
        }`}
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
            animationsEnabled={animationsEnabled}
            highlightTaskId={highlightTaskId}
            now={now}
            onHighlightEnd={onHighlightEnd}
            onDelete={handleDeleteWithUndo}
            onEditTask={onEditTask}
            onReorder={(orderedIds) => void onReorder(orderedIds)}
            onToggle={handleToggleWithUndo}
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
            aria-label={
              pinned
                ? appMode === "window"
                  ? "取消窗口置顶"
                  : "取消固定面板"
                : appMode === "window"
                  ? "窗口置顶"
                  : "固定面板"
            }
            aria-pressed={pinned}
            className={`icon-btn ${pinned ? "pin-active" : ""}`}
            onClick={onTogglePin}
            title={
              pinned
                ? appMode === "window"
                  ? "取消置顶"
                  : "取消固定"
                : appMode === "window"
                  ? "窗口置顶（悬浮在最前）"
                  : "固定面板（不自动收回）"
            }
            type="button"
          >
            <PinIcon className="h-[18px] w-[18px]" />
          </button>
          {appMode === "window" ? (
            <button
              aria-label="立即锁定"
              className="icon-btn"
              onClick={() => void api.lockPanel().catch(() => undefined)}
              title="立即锁定"
              type="button"
            >
              <LockIcon className="h-[18px] w-[18px]" />
            </button>
          ) : null}
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

      {/* 窗口模式边缘缩放把手（z 在设置/周报覆盖层之下，覆盖层打开时不碍事） */}
      {windowDraggable ? (
        <>
          <div
            className="resize-grip"
            style={{ bottom: 14, cursor: "ew-resize", left: 14, top: 14, width: 6 }}
            onMouseDown={startResize("West")}
          />
          <div
            className="resize-grip"
            style={{ bottom: 14, cursor: "ew-resize", right: 14, top: 14, width: 6 }}
            onMouseDown={startResize("East")}
          />
          <div
            className="resize-grip"
            style={{ bottom: 0, cursor: "ns-resize", height: 6, left: 14, right: 14 }}
            onMouseDown={startResize("South")}
          />
          <div
            className="resize-grip"
            style={{ cursor: "nwse-resize", height: 14, left: 0, top: 0, width: 14 }}
            onMouseDown={startResize("NorthWest")}
          />
          <div
            className="resize-grip"
            style={{ cursor: "nesw-resize", height: 14, right: 0, top: 0, width: 14 }}
            onMouseDown={startResize("NorthEast")}
          />
          <div
            className="resize-grip"
            style={{ bottom: 0, cursor: "nesw-resize", height: 14, left: 0, width: 14 }}
            onMouseDown={startResize("SouthWest")}
          />
          <div
            className="resize-grip"
            style={{ bottom: 0, cursor: "nwse-resize", height: 14, right: 0, width: 14 }}
            onMouseDown={startResize("SouthEast")}
          />
        </>
      ) : null}

      {/* 隐私锁覆盖层：盖住全部内容与交互（含底栏/把手/弹层）；原地点击解锁，
          按住拖动挪窗口。严格解锁——窗口重新激活不解锁，必须点一下锁屏 */}
      {locked ? (
        <div
          aria-label="已锁定，点击显示 Todo 内容"
          className="lock-overlay"
          onPointerCancel={endLockPointer}
          onPointerDown={beginLockPointer}
          onPointerMove={moveLockPointer}
          onPointerUp={endLockPointer}
        >
          <LockIcon className="lock-overlay-icon" />
          <p className="lock-overlay-text">点击显示 Todo 内容</p>
        </div>
      ) : null}

      {/* 撤销 toast：浮在所有视图（含周报）之上；多条堆叠，新触发的在上。
          弹出自下而上滑入，消失渐隐；动画受全局开关控制 */}
      {undoToasts.length > 0 ? (
        <div className="undo-toast-stack">
          {undoToasts.map((toast) => (
            <div
              className={`undo-toast${animationsEnabled ? " undo-toast-anim" : ""}${
                closingToastIds.includes(toast.id) ? " undo-toast-closing" : ""
              }`}
              key={toast.id}
              role="status"
            >
              <span className="undo-toast-text">{toast.message}</span>
              <button
                className="undo-toast-btn"
                onClick={() => handleUndoClick(toast.id)}
                type="button"
              >
                撤销
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </main>
  );
}

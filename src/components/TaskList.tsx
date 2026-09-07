import { useEffect, useLayoutEffect, useRef, useState } from "react";
import dayjs, { type Dayjs } from "dayjs";

import type { Task } from "../lib/api";
import { sortTasks } from "../lib/taskSort";
import { ChevronIcon } from "./icons";
import { TaskItem } from "./TaskItem";

type DropPosition = "before" | "after";

/** 离场动画行：勾选完成后在原位渐隐收拢的任务（oldIndex = 基准帧中的位置） */
interface LeavingRow {
  task: Task;
  oldIndex: number;
}

/** 一次入场/离场动画的快照；order 为基准帧的未完成 id 序列，供原位插回 */
interface ListTransition {
  entering: number[];
  leaving: LeavingRow[];
  order: number[];
}

interface TaskListProps {
  tasks: Task[];
  now: Dayjs;
  /** 全局动画总开关：入场/离场与分组展开动画据此启停 */
  animationsEnabled: boolean;
  highlightTaskId: number | null;
  onToggle: (id: number) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onEditTask: (
    id: number,
    title: string,
    remindAt: string | null,
    repeat?: string,
  ) => Promise<void>;
  /** 拖拽落定：按新顺序提交全部任务 id（待办在前、已完成在后） */
  onReorder: (orderedIds: number[]) => void;
  onHighlightEnd: () => void;
}

interface DragState {
  id: number;
  done: boolean;
  startY: number;
  /** 位移超过阈值后才算拖拽，避免与点击冲突 */
  active: boolean;
}

/**
 * 手动排序：Pointer Events 自实现（HTML5 drag & drop 在 NOACTIVATE 窗口和
 * 云桌面环境下事件不可靠，2026-09-01 反馈拖不动）。按住行的空白/标题区拖动，
 * 仅未完成任务可拖；「今日已完成」分组内按完成时间排列，不参与拖拽。
 */
export function TaskList({
  tasks,
  now,
  animationsEnabled,
  highlightTaskId,
  onToggle,
  onDelete,
  onEditTask,
  onReorder,
  onHighlightEnd,
}: TaskListProps) {
  // 主清单只显示未完成任务；今日勾完的归入「今日已完成」分组（默认缩起，
  // 点标题展开）；更早完成的只在周报视图看（2026-09-01 反馈）
  const pendingTasks = sortTasks(
    tasks.filter((task) => !task.done),
    now,
  );
  const doneTodayTasks = tasks
    .filter(
      (task) =>
        task.done && task.doneAt !== null && dayjs(task.doneAt).isSame(now, "day"),
    )
    .sort(
      (first, second) =>
        dayjs(second.doneAt!).valueOf() - dayjs(first.doneAt!).valueOf(),
    );
  // 分组展开态只在本次面板内有效：面板收起再展开、跨天都回到默认缩起
  const [groupOpen, setGroupOpen] = useState(false);

  const [dragId, setDragId] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ id: number; position: DropPosition } | null>(
    null,
  );
  // dropHint 的镜像引用：pointerup 落定时读取最新值，不依赖渲染闭包
  const dropHintRef = useRef<{ id: number; position: DropPosition } | null>(null);
  const dragRef = useRef<DragState | null>(null);

  /** 分组内行为照常（勾选/编辑/删除），仅拖拽排序不启用 */
  const disabledDrag = {
    onRowPointerDown: () => {},
    onRowPointerMove: () => {},
    onRowPointerUp: () => {},
  };

  // 入场/离场动画追踪（仅开动画时）：数据更新后的那一帧尚未上屏，用
  // useLayoutEffect 先补帧再绘制——勾选完成的行按上一帧位置「原位保留」
  // （划线扫过→右滑渐隐→高度收拢，下方元素平滑上移），新增的行高度展开
  // 把下方推下去；删除不播离场（撤销提示已反馈消失原因）。首次挂载不播，
  // 避免面板展开时整列齐动。
  const prevOrderRef = useRef<number[] | null>(null);
  const animTimerRef = useRef<number | null>(null);
  const [transition, setTransition] = useState<ListTransition | null>(null);

  useEffect(
    () => () => {
      if (animTimerRef.current !== null) {
        window.clearTimeout(animTimerRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const previous = prevOrderRef.current;
    const currentIds = pendingTasks.map((task) => task.id);
    prevOrderRef.current = currentIds;

    if (previous === null || !animationsEnabled) {
      setTransition((current) => (current === null ? current : null));
      return;
    }

    const currentSet = new Set(currentIds);
    const entered = currentIds.filter((id) => !previous.includes(id));
    const left = previous
      .filter((id) => !currentSet.has(id))
      .map((id) => {
        const task = tasks.find((candidate) => candidate.id === id && candidate.done);
        return task ? { task, oldIndex: previous.indexOf(id) } : null;
      })
      .filter((row): row is LeavingRow => row !== null);

    if (entered.length === 0 && left.length === 0) {
      return;
    }

    // 连续勾选/新增时叠加；order 锚定最初基准帧，原位插入不漂移
    setTransition((current) => ({
      entering: [...(current?.entering ?? []), ...entered],
      leaving: [...(current?.leaving ?? []), ...left],
      order: current?.order ?? previous,
    }));

    if (animTimerRef.current !== null) {
      window.clearTimeout(animTimerRef.current);
    }
    animTimerRef.current = window.setTimeout(() => {
      animTimerRef.current = null;
      setTransition((current) => (current === null ? current : null));
    }, 520);
  }, [pendingTasks, tasks, animationsEnabled]);

  // 渲染序合并：离场行插回基准帧的原位，布局不跳动
  const mergedRows: Array<{ task: Task; leaving: boolean }> = [];
  if (transition === null || transition.leaving.length === 0) {
    for (const task of pendingTasks) {
      mergedRows.push({ task, leaving: false });
    }
  } else {
    const leavingSorted = [...transition.leaving].sort(
      (first, second) => first.oldIndex - second.oldIndex,
    );
    let cursor = 0;
    for (const task of pendingTasks) {
      const oldIndex = transition.order.indexOf(task.id);
      while (
        cursor < leavingSorted.length &&
        (oldIndex === -1 || leavingSorted[cursor].oldIndex < oldIndex)
      ) {
        mergedRows.push({ task: leavingSorted[cursor].task, leaving: true });
        cursor += 1;
      }
      mergedRows.push({ task, leaving: false });
    }
    for (; cursor < leavingSorted.length; cursor += 1) {
      mergedRows.push({ task: leavingSorted[cursor].task, leaving: true });
    }
  }

  /** 按下：记录候选拖拽（交互控件上不启动）；指针捕获保证后续 move/up 不丢 */
  function handleRowPointerDown(
    id: number,
    done: boolean,
    event: React.PointerEvent<HTMLLIElement>,
  ) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    // 弹层（提醒选择/编辑）整体排除：遮罩被指针捕获后 click 会改道任务行，
    // 「点卡片外取消」永远收不到（2026-09-03 反馈编辑弹层关不掉）
    if (target.closest("button, input, a, label, .picker-backdrop, .picker-card")) {
      return;
    }
    event.preventDefault(); // 抑制拖动时的文本选择
    dragRef.current = { id, done, startY: event.clientY, active: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  /** 移动：超过阈值进入拖拽；用 elementFromPoint 命中测试悬停的目标行 */
  function handleRowPointerMove(
    id: number,
    done: boolean,
    event: React.PointerEvent<HTMLLIElement>,
  ) {
    const state = dragRef.current;
    if (!state || state.id !== id) {
      return;
    }
    if (!state.active) {
      if (Math.abs(event.clientY - state.startY) < 5) {
        return;
      }
      state.active = true;
      setDragId(id);
    }
    event.preventDefault();

    const hit = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("li[data-task-id]");
    if (!hit) {
      setDropHint(null);
      return;
    }
    const targetId = Number(hit.getAttribute("data-task-id"));
    if (!Number.isInteger(targetId) || targetId === id) {
      setDropHint(null);
      return;
    }
    const targetTask = tasks.find((task) => task.id === targetId);
    if (!targetTask || targetTask.done !== done) {
      setDropHint(null); // 跨分区：不给落点提示
      return;
    }
    const rect = hit.getBoundingClientRect();
    const position: DropPosition =
      event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    if (dropHintRef.current?.id !== targetId || dropHintRef.current.position !== position) {
      dropHintRef.current = { id: targetId, position };
      setDropHint({ id: targetId, position });
    }
  }

  /** 抬起：拖拽已激活且悬停在同分区行上则落定新顺序 */
  function handleRowPointerUp(id: number, done: boolean) {
    const state = dragRef.current;
    const wasActive = state?.active ?? false;
    const hint = dropHintRef.current;
    dragRef.current = null;
    dropHintRef.current = null;
    setDragId(null);
    setDropHint(null);
    if (!wasActive || !hint || state?.id !== id) {
      return;
    }
    const targetTask = tasks.find((task) => task.id === hint.id);
    if (!targetTask || targetTask.done !== done) {
      return;
    }

    // 只有未完成区可拖（分组行不挂拖拽事件），基于当前显示顺序重排
    const pendingIds = pendingTasks.map((task) => task.id);
    pendingIds.splice(pendingIds.indexOf(id), 1);
    pendingIds.splice(pendingIds.indexOf(hint.id) + (hint.position === "after" ? 1 : 0), 0, id);
    onReorder(pendingIds);
  }

  /** 当前行该显示的插入位置提示（拖拽中且悬停在同分区其他行上） */
  function hintFor(task: Task): DropPosition | null {
    if (dragId === null || dragId === task.id || dropHint?.id !== task.id) {
      return null;
    }
    return dropHint.position;
  }

  if (pendingTasks.length === 0 && doneTodayTasks.length === 0) {
    return (
      <p className="mt-10 text-center text-[13px] text-[color:var(--fg-muted)]">
        今天没有待办，休息一下
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <ul className="flex flex-col">
        {mergedRows.map(({ task, leaving }) =>
          leaving ? (
            <TaskItem
              key={task.id}
              {...disabledDrag}
              leaving
              now={now}
              highlighted={false}
              dragging={false}
              dropHint={null}
              onHighlightEnd={onHighlightEnd}
              onDelete={onDelete}
              onEditTask={onEditTask}
              onToggle={onToggle}
              task={task}
            />
          ) : (
            <TaskItem
              key={task.id}
              now={now}
              highlighted={task.id === highlightTaskId}
              dragging={task.id === dragId}
              dropHint={hintFor(task)}
              entering={transition?.entering.includes(task.id) ?? false}
              onRowPointerDown={handleRowPointerDown}
              onRowPointerMove={handleRowPointerMove}
              onRowPointerUp={handleRowPointerUp}
              onHighlightEnd={onHighlightEnd}
              onDelete={onDelete}
              onEditTask={onEditTask}
              onToggle={onToggle}
              task={task}
            />
          ),
        )}
      </ul>

      {/* 「今日已完成」分组：默认缩起，点标题展开；不提供自建分组（首版）。
          内容常驻挂载，展开/收起靠 grid-rows 过渡（关动画时瞬时切换） */}
      {doneTodayTasks.length > 0 ? (
        <section
          aria-label="今日已完成"
          className={`task-group${animationsEnabled ? "" : " task-group-anim-off"}`}
        >
          <button
            aria-expanded={groupOpen}
            className="task-group-toggle"
            onClick={() => setGroupOpen((open) => !open)}
            type="button"
          >
            <ChevronIcon
              className={`task-group-chevron${groupOpen ? " task-group-chevron-open" : ""}`}
            />
            <span className="task-group-title">今日已完成</span>
            <span className="task-group-count">{doneTodayTasks.length}</span>
          </button>
          <div
            aria-hidden={!groupOpen}
            className={`task-group-body${groupOpen ? " task-group-body-open" : ""}${
              animationsEnabled ? "" : " task-group-body-instant"
            }`}
          >
            <ul className="flex flex-col">
              {doneTodayTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  {...disabledDrag}
                  now={now}
                  highlighted={task.id === highlightTaskId}
                  dragging={false}
                  dropHint={null}
                  onHighlightEnd={onHighlightEnd}
                  onDelete={onDelete}
                  onEditTask={onEditTask}
                  onToggle={onToggle}
                  task={task}
                />
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}

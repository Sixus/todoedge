import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

import type { AppMode, WindowMaterial } from "./appMode";

/** 与 Rust 侧 commands::Task 对齐（camelCase），时间一律 RFC3339 字符串（UTC）。
 *  repeat：重复规则 none|daily|weekly|monthly；originId：重复任务勾掉后
 *  新建的下一期卡指回被结算的旧卡 */
export interface Task {
  id: number;
  title: string;
  remindAt: string | null;
  repeat: string;
  notified: boolean;
  done: boolean;
  doneAt: string | null;
  sortOrder: number | null;
  groupId: number | null;
  createdAt: string;
  originId: number | null;
}

/** 完成记录（M4-1）：周报数据源，重复任务每结算一期一条 */
export interface Completion {
  id: number;
  taskId: number;
  title: string;
  doneAt: string;
}

export type WindowMode = "collapsed" | "expanded";

/** 窗口模式边缘缩放把手的拖拽方向（与 Tauri ResizeDirection 对齐） */
export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

export const api = {
  listTasks: () => invoke<Task[]>("list_tasks"),
  /** repeat：none|daily|weekly|monthly，非法值后端兜底回 none */
  addTask: (title: string, remindAt?: string | null, repeat?: string) =>
    invoke<Task>("add_task", { title, remindAt, repeat }),
  toggleTask: (id: number) => invoke<Task>("toggle_task", { id }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  /** 撤销删除：按删除前快照原样恢复（含原完成状态与手动排序） */
  restoreTask: (task: Task) => invoke<Task>("restore_task", { task }),
  /** 只更新传入的字段，其余保持不变（M2 改期用；M4-1 起可带 repeat） */
  updateTask: (id: number, title?: string, remindAt?: string | null, repeat?: string) =>
    invoke<Task>("update_task", { id, title, remindAt, repeat }),
  /** 清除提醒时间（M2-3 选择器「清除提醒」），重复一并重置 none */
  clearReminder: (id: number) => invoke<Task>("clear_reminder", { id }),
  /** 完成记录（M4-1 周报数据源）：全量返回，前端按周过滤 */
  listCompletions: () => invoke<Completion[]>("list_completions"),
  deleteCompletion: (id: number) => invoke<void>("delete_completion", { id }),
  /** 撤销周报删除：把完成记录原样插回 */
  restoreCompletion: (completion: Completion) =>
    invoke<Completion>("restore_completion", { completion }),
  /** 拖拽排序：按新顺序写入 sort_order */
  reorderTasks: (ids: number[]) => invoke<void>("reorder_tasks", { ids }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  /** 完全退出程序（设置页底部按钮）：结束整个应用 */
  exitApp: () => invoke<void>("exit_app"),
  autostartStatus: () => invoke<boolean>("autostart_status"),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  setPanelAnimations: (enabled: boolean) =>
    invoke<void>("set_panel_animations", { enabled }),
  expandPanel: () => invoke<WindowMode>("expand_panel"),
  collapsePanel: () => invoke<WindowMode>("collapse_panel"),
  setPanelEditing: (editing: boolean) =>
    invoke<void>("set_panel_editing", { editing }),
  /** 图钉固定同步给 Rust：固定时「编辑态点外部」兜底收起一并失效 */
  setPanelPinned: (pinned: boolean) =>
    invoke<void>("set_panel_pinned", { pinned }),
  /** 拖动细条：把指针位移增量（逻辑像素）交给 Rust 移动窗口 y（x 恒贴右缘），不落库 */
  moveStripWindow: (deltaY: number) =>
    invoke<void>("move_strip_window", { deltaY }),
  /** 拖动结束：把当前细条垂直比例写入 settings */
  persistStripPosition: () => invoke<void>("persist_strip_position"),
  /** 设置里的重置：细条回垂直居中并落库 */
  resetStripPosition: () => invoke<void>("reset_strip_position"),
  /** 设置全局热键（如 "Ctrl+Alt+KeyT"）；注册成功才落库并回显，失败 Err 且旧热键保持 */
  setGlobalHotkey: (hotkey: string) =>
    invoke<string>("set_global_hotkey", { hotkey }),
  /** 切换运行模式（贴边↔窗口）：Rust 落库并就地变换窗口形态（含毛玻璃开关） */
  setAppMode: (mode: AppMode) => invoke<AppMode>("set_app_mode", { mode }),
  /** 切换窗口模式背景材质（亚克力↔普通透明）：Rust 落库并即时应用/撤销系统材质 */
  setWindowMaterial: (material: WindowMaterial) =>
    invoke<WindowMaterial>("set_window_material", { material }),
  /** 底栏锁头：立即上锁（Rust 广播 panel-lock 事件，面板锁屏统一处理） */
  lockPanel: () => invoke<void>("lock_panel"),
  /** 窗口模式最小化到托盘：藏起主窗口（任务栏不显示），托盘/热键/通知点击唤回 */
  hideToTray: () => invoke<void>("hide_to_tray"),
  /** 设置：失焦自动上锁开关 */
  setAutoLockEnabled: (enabled: boolean) =>
    invoke<void>("set_auto_lock_enabled", { enabled }),
  /** 设置：失焦多久上锁（分钟，1–1440） */
  setAutoLockMinutes: (minutes: number) =>
    invoke<void>("set_auto_lock_minutes", { minutes }),
  /** 窗口模式边缘缩放把手：从指定边/角进入系统缩放循环（无边框窗口的
      原生缩放命中会被 WebView 子窗口挡住，只能这样触发） */
  startResizeDragging: (direction: ResizeDirection) =>
    getCurrentWindow().startResizeDragging(direction),
};

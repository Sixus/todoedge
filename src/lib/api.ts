import { invoke } from "@tauri-apps/api/core";

/** 与 Rust 侧 commands::Task 对齐（camelCase），时间一律 RFC3339 字符串（UTC） */
export interface Task {
  id: number;
  title: string;
  remindAt: string | null;
  notified: boolean;
  done: boolean;
  doneAt: string | null;
  sortOrder: number | null;
  groupId: number | null;
  createdAt: string;
}

export type WindowMode = "collapsed" | "expanded";

export const api = {
  listTasks: () => invoke<Task[]>("list_tasks"),
  addTask: (title: string, remindAt?: string | null) =>
    invoke<Task>("add_task", { title, remindAt }),
  toggleTask: (id: number) => invoke<Task>("toggle_task", { id }),
  deleteTask: (id: number) => invoke<void>("delete_task", { id }),
  /** 只更新传入的字段，其余保持不变（M2 改期用） */
  updateTask: (id: number, title?: string, remindAt?: string | null) =>
    invoke<Task>("update_task", { id, title, remindAt }),
  /** 清除提醒时间（M2-3 选择器「清除提醒」） */
  clearReminder: (id: number) => invoke<Task>("clear_reminder", { id }),
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
};

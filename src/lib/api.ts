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
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  expandPanel: () => invoke<WindowMode>("expand_panel"),
  collapsePanel: () => invoke<WindowMode>("collapse_panel"),
  setPanelEditing: (editing: boolean) =>
    invoke<void>("set_panel_editing", { editing }),
};

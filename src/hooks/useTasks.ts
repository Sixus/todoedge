import { useCallback, useEffect, useState } from "react";

import { api, type Task } from "../lib/api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      setTasks(await api.listTasks());
    } catch (cause) {
      setError(errorMessage(cause));
      throw cause;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  const addTask = useCallback(
    async (title: string, remindAt?: string | null) => {
      await api.addTask(title, remindAt);
      await reload();
    },
    [reload],
  );

  /** 编辑任务：标题 + 提醒时间（null = 清除提醒）。改期会重置 notified 重新进入调度 */
  const toggleTask = useCallback(
    async (id: number) => {
      await api.toggleTask(id);
      await reload();
    },
    [reload],
  );

  const deleteTask = useCallback(
    async (id: number) => {
      await api.deleteTask(id);
      await reload();
    },
    [reload],
  );

  /** 撤销删除：按删除前快照原样恢复 */
  const restoreTask = useCallback(
    async (task: Task) => {
      await api.restoreTask(task);
      await reload();
    },
    [reload],
  );

  /** 编辑任务：标题 + 提醒时间（null = 清除提醒）。改期会重置 notified 重新进入调度 */
  const editTask = useCallback(
    async (id: number, title: string, remindAt: string | null) => {
      if (remindAt) {
        await api.updateTask(id, title, remindAt);
      } else {
        await api.updateTask(id, title);
        await api.clearReminder(id);
      }
      await reload();
    },
    [reload],
  );

  /** 拖拽排序落定：按新顺序持久化 sort_order */
  const reorderTasks = useCallback(
    async (orderedIds: number[]) => {
      await api.reorderTasks(orderedIds);
      await reload();
    },
    [reload],
  );

  return {
    tasks,
    isLoading,
    error,
    reload,
    addTask,
    toggleTask,
    deleteTask,
    restoreTask,
    editTask,
    reorderTasks,
  };
}

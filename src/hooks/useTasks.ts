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
    async (title: string) => {
      await api.addTask(title);
      await reload();
    },
    [reload],
  );

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

  return { tasks, isLoading, error, addTask, toggleTask, deleteTask };
}

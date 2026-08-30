import "./App.css";

import { TaskInput } from "./components/TaskInput";
import { TaskList } from "./components/TaskList";
import { useTasks } from "./hooks/useTasks";

function App() {
  const { tasks, isLoading, error, addTask, toggleTask, deleteTask } = useTasks();
  const pendingCount = tasks.filter((task) => !task.done).length;

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>TodoEdge</h1>
        <p>未完成 {pendingCount}</p>
      </header>

      <TaskInput onAdd={addTask} />

      <section aria-label="任务清单" className="task-list-section">
        {isLoading ? <p className="empty-state">加载中…</p> : null}
        {!isLoading && error ? <p className="error-state">加载失败：{error}</p> : null}
        {!isLoading && !error ? (
          <TaskList tasks={tasks} onToggle={toggleTask} onDelete={deleteTask} />
        ) : null}
      </section>
    </main>
  );
}

export default App;

import React from "react";
import ReactDOM from "react-dom/client";
import { SettingsWindow } from "./components/SettingsWindow";
import "./styles/theme.css";

// 设置小窗独立入口（settings.html，Vite 多页面构建；Rust 侧
// WebviewUrl::App("settings.html") 加载）
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SettingsWindow />
  </React.StrictMode>,
);

# TodoEdge

全AI Vibe Coding的贴边常驻极简 Windows 桌面待办：平时缩在屏幕右缘一条 6px 细线，鼠标碰一下滑出面板，记完即走，不打断手头的事。数据全部存在本机 SQLite，不联网、不上传。


## 功能一览

- **贴边细条 + 悬停展开**：右缘细条贴边常驻，鼠标移入滑出面板，移出自动收起；细条可上下拖动、位置记忆
- **窗口模式**：可切换为普通窗口形态（Win11 系统亚克力背景），可自由缩放、置顶、最小化到托盘
- **原生 Toast 提醒**：到点弹系统通知，通知里直接「完成」或「稍后提醒」，不用切回面板
- **自然语言时间**：输入框里直接写「明天 9 点」「周五下午 3」这类说法，自动解析成提醒时间
- **重复任务**：每日 / 每周 / 每月，勾掉自动结算并生成下一期
- **周报视图**：按周回顾完成记录，一键复制成文本
- **托盘 + 全局热键**：默认 `Alt+T` 随时呼出/收起，热键可自定义；托盘左键切换面板
- **隐私锁**：面板可手动上锁，失焦自动上锁（时长可设），解锁才显示内容
- **外观**：深 / 浅色，透明度可调，支持开机自启

## 环境要求

- Windows 10 / 11
- 构建：[Rust](https://rustup.rs/)（stable 工具链）+ [Node.js](https://nodejs.org/) ≥ 20.19

## 快速开始

```bash
npm install
npm run tauri dev    # 开发运行
npm run tauri build  # 打安装包（NSIS / MSI）
```

## 数据存储

所有数据保存在本机 `%APPDATA%\com.todoedge.app\todoedge\todo.db`（SQLite），卸载应用不影响该文件；应用不发起任何网络请求。

## 目录结构

```
src/          前端（React 18 + TypeScript + Tailwind 4）
src-tauri/    Rust 后端（Tauri 2 + rusqlite + Win32/WinRT）
docs/         产品方案与开发指南（界面/行为规格以 docs/01 为准）
```

## 参与贡献

欢迎 issue 与 PR，开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)

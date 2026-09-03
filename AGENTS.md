# TodoEdge 项目约定（所有 AI agent 必读）

## 这是什么
贴边常驻的极简 Windows 待办。完整需求见 docs/01-产品方案框架-v1.md（单一事实来源，
界面/行为规格以它为准，不得自行发挥）。开发流程与技术架构见 docs/02-开发总指南.md。

## 技术栈（不得擅改）
Tauri 2.x / React 18 + TS + Vite / Tailwind 4 / rusqlite /
windows-rs。新增任何依赖前必须向用户说明并获同意。
透明面板 = 原生逐像素透明 + CSS 半透明层，禁止引入 window-vibrancy 等
DWM 系统材质（主窗口永不激活，系统材质只会渲染纯色兜底，见 01 文档第 7 节）。

## 硬性规则
1. 单主窗口贴边架构：expand/collapse 改窗口几何，见 docs/02 第 4.1 节。
2. 所有 Win32/WinRT 调用仅限 window_ctl.rs / toast.rs，#[cfg(windows)] 门控。
3. 时间一律 UTC 存储，前端 dayjs 本地显示。
4. UI 文案全部中文；代码注释中文；变量命名英文。
5. 不实现任务卡之外的功能，不加"顺手优化"。
6. 数据库 schema 变更必须走 src-tauri/migrations/ 新增迁移文件，禁止改历史迁移。
7. 每完成一张任务卡：cargo check + 前端 tsc 无错误后才算完，然后等用户验收。

## 常用命令
npm run tauri dev   # 开发运行
npm run tauri build # 打安装包
cargo check         # Rust 编译检查（在 src-tauri/ 下）

## 打包发布规则（2026-09-03 用户约定）
1. 每次打包前必须确认版本号：tauri.conf.json / Cargo.toml / package.json 三处同步升，
   设置页「V 主.次」自动跟随。用户没主动提版本号就先问；明确说不升才沿用旧版。
2. 每次打包后在 docs/版本记录.md 追加一行：版本号 + 日期 + 本次包含的主要内容。

## 用户背景
用户无代码基础：解释用日常语言；验证只靠运行应用看效果；git 由你全权代管，
用户说"提交"才 commit，说"回滚"才 revert。

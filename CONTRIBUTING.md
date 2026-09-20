# 参与贡献

感谢你有兴趣参与 TodoEdge 的开发。

## 开发环境

- Windows 10 / 11
- Rust stable 工具链（[rustup](https://rustup.rs/)）
- Node.js ≥ 20.19

## 本地运行

```bash
npm install
npm run tauri dev    # 开发运行
npm run tauri build  # 打安装包
```

## 项目约定

- **界面与行为规格以 [docs/01-产品方案框架-v1.md](docs/01-产品方案框架-v1.md) 为准**，改动交互前请先读它；架构说明见 [docs/02-开发总指南.md](docs/02-开发总指南.md)
- 技术栈不随意加依赖：新增任何第三方依赖，请先在 issue/PR 里说明理由
- 所有 Win32 / WinRT 调用只放在 `src-tauri/src/window_ctl.rs` 与 `src-tauri/src/toast.rs`，并用 `#[cfg(windows)]` 门控
- 时间一律 UTC 存储（RFC3339），前端用 dayjs 本地显示
- 数据库结构变更只能在 `src-tauri/migrations/` 新增迁移文件，不改历史迁移
- UI 文案全部中文，代码注释中文、变量命名英文

## 提交 PR 前

请确保以下命令全部通过：

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test          # 在 src-tauri/ 下
npm run build       # 仓库根目录（tsc + vite）
```

CI 会对每条 push / PR 跑同样的检查。

# 安监智能辅助系统

铁路安全检查智能辅助系统 — 检查手册、检查信息、规章制度、应急电话、工作日志、AI 助手六合一工具。
纯静态站点 + PWA 离线应用，数据全部存储在浏览器本地（IndexedDB + localStorage）。

## 本地预览

项目无构建步骤，任意静态服务器均可：

```bash
npx serve -s . -l 8080
# 或
python -m http.server 8080
```

访问 `http://localhost:8080`。

## 部署信息

### CloudBase（腾讯云开发 · 静态网站托管）

| 项目 | 值 |
| --- | --- |
| 环境 ID | `cloud1-9gkm9db511a4b04f` |
| 地域 | `ap-shanghai` |
| 静态托管域名 | `cloud1-9gkm9db511a4b04f-1407433603.tcloudbaseapp.com` |
| 静态存储桶 | `de55-static-cloud1-9gkm9db511a4b04f-1407433603` |
| 默认首页 | `index.html`（已配置索引文档） |
| 首次部署 | 2026-09-04 |
| 当前版本 | `v3.75`（构建 20260916_192914，SW 缓存 `20260916192914`） |

**访问地址**：https://cloud1-9gkm9db511a4b04f-1407433603.tcloudbaseapp.com/

> 更新后用「设置 → 检查更新」刷新，或访问地址加 `?t=20260915130920` 随机参数强制跳过 CDN 缓存；PWA 已安装用户建议先清一次 Service Worker 缓存。

### GitHub Pages（备用托管，当前线上版本与仓库同步）

| 项目 | 值 |
| --- | --- |
| 仓库 | https://github.com/haibing321/36075739-2 |
| 访问地址 | https://haibing321.github.io/36075739-2/ |
| 更新方式 | `git push` 到 `main` 分支后由 Pages 自动构建 |

> `app.js` 的「检查更新」读取同源 `./version.json`，两个托管环境的版本号都以该文件为准；发版需同步 `version.json` + `app.js` 的 `APP_VERSION` + 关于面板三者（`sw.js` 的 `CACHE_VERSION` 由 `scripts/bump-sw.js` 与 pre-commit 钩子自动同步）。

**部署方式**：项目无后端，不涉及云函数 / 云托管 / 数据库。直接将项目根目录文件上传至静态托管根路径即可，
上传时应排除 `.git/`、`.codebuddy/`、`.workbuddy/`、`node_modules/`、`scripts/`、`*.md` 等非站点文件。

### CloudStudio（预览沙箱）

- 启动命令：`npm install -g serve` → `npx serve -s . -l 8080`
- 预览地址：<http://0ed9ab9adff84042a0ae33f316d53fe7.codebuddy.cloudstudio.run>

沙箱为只读预览环境，本地改动需重新部署才会同步。

## 使用的云资源

- **CloudBase 静态网站托管**：承载全部前端静态资源（HTML / CSS / JS / 图标 / manifest / service worker）。
- 数据库、云函数、云存储、云托管：**未使用**。

## 更新部署后的注意事项

1. 静态托管有 CDN 缓存，验证新版本时请在 URL 后追加随机查询串（如 `?t=202609041500`）或在浏览器强制刷新。
2. `sw.js` 会缓存站点资源，更新后需在应用内点「设置 → 检查更新」或清除浏览器缓存。
3. `sw.js` 中的 `CACHE_VERSION` 与 `version.json` 需保持一致，仓库已通过 `scripts/bump-sw.js` + `pre-commit` 钩子自动同步，请勿手动改动其中一处。

# Git Hooks 模板

本目录存放项目的 Git 钩子模板。**`.git/hooks/` 不被 git 跟踪**，克隆/换机后需手动复制：

```sh
# 在仓库根目录执行
cp scripts/hooks/pre-commit .git/hooks/pre-commit
cp scripts/hooks/pre-push   .git/hooks/pre-push
```

Windows（Git Bash）下无需 chmod +x，git 会用 sh 调用。

## pre-commit
- 自动把 `sw.js` 的 `CACHE_VERSION` 提升为单调 12 位时间戳（`YYYYMMDDHHMMSS`），
  让 SW 版本号随功能提交一起进入同一 commit。
- 仅当本次提交暂存区含非 `sw.js` 改动时才 bump，防止“只 bump 自身”死循环。

## pre-push
- 仅对所有被跟踪的 `*.js` 跑 `node --check` 语法门禁，不通过则拦截 push。
- SW 版本 bump 已移至 pre-commit，这里不再负责。

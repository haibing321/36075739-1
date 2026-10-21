@echo off
chcp 65001 >nul
title 铁路安监智能辅助系统 — 本地启动
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     铁路安监智能辅助系统 —— 本地启动（U 盘 / 本机离线可用）
echo   ==========================================================
echo.
echo   正在启动本地服务（纯本机、不联网上传任何数据）...
echo   启动后会自动打开浏览器窗口；关闭本窗口即停止服务。
echo.

rem ---- 启动前自检：关键文件缺失时先说清"可能是被杀软隔离"，别直接报错 ----
set "MISSING="
if not exist "index.html"     set "MISSING=%MISSING% index.html"
if not exist "sw.js"          set "MISSING=%MISSING% sw.js"
if not exist "src\js\app.js"  set "MISSING=%MISSING% src\js\app.js"
if not "%MISSING%"=="" (
  echo   [!] 缺少关键文件:%MISSING%
  echo       最常见原因：被杀毒软件或单位安全管控软件隔离/删除。
  echo       处理顺序：
  echo         1^) 打开杀软的「隔离区 / 恢复区」，恢复本目录的文件；
  echo         2^) 把整个版本目录加入信任（白名单 / 排除项）；
  echo         3^) 双击「校验文件完整性.bat」确认文件完整后再启动。
  echo       详细说明见「安全说明（先读我）.txt」。
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_serve.ps1" %*

echo.
echo   服务已停止。若刚才提示启动失败，请把本窗口内容截图反馈。
pause

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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0_serve.ps1" %*

echo.
echo   服务已停止。若刚才提示启动失败，请把本窗口内容截图反馈。
pause

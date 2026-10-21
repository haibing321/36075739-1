@echo off
chcp 65001 >nul
title 校验文件完整性 — 铁路安监智能辅助系统
cd /d "%~dp0"

echo.
echo   ==========================================================
echo     校验文件完整性（对照 SHA256SUMS.txt）
echo   ==========================================================
echo.
echo   用途：确认版本目录里的文件没被杀毒软件删除或改动。
echo   只做本地读取与哈希计算，不联网、不写任何文件。
echo.

if not exist "SHA256SUMS.txt" (
  echo   [!] 未找到 SHA256SUMS.txt —— 本目录可能不完整。
  echo       请从原始安装包重新拷贝一份，或联系提供者。
  echo.
  pause
  exit /b 2
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0verify-integrity.ps1"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   [OK] 全部文件完整，与清单一致。
) else (
  echo   [!] 存在缺失或被改动的文件。
  echo       最常见原因：杀毒软件 / 单位安全管控把 .html 或脚本当成威胁隔离了。
  echo       处理顺序：
  echo         1^) 打开杀软的「隔离区 / 恢复区」，把本目录的文件恢复；
  echo         2^) 把整个版本目录加入信任（白名单 / 排除项）；
  echo         3^) 再运行一次本校验，全部通过即可正常启动。
  echo       详细说明见「安全说明（先读我）.txt」。
)
echo.
pause

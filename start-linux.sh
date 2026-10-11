#!/bin/sh
# ==========================================================================
#  安监智能辅助系统 · Linux 启动器（华为麒麟 / 统信 UOS / 通用发行版）
#
#  用法：
#     bash start-linux.sh              直接启动（U 盘上够用；关终端窗口即停）
#     bash start-linux.sh --install    一次性安装：复制到本机 + 生成「双击即开」桌面图标
#
#  作用：用 python3 起一个「纯本机」静态服务 http://127.0.0.1:8788（占用自动顺延），
#        再用浏览器以「应用窗口」打开 —— 与线上体验一致（Service Worker / 离线可用）。
#
#  为什么不能直接双击 index.html：file:// 下浏览器禁用 Service Worker ⇒ 离线/安装能力失效。
#
#  注意：本文件必须保持 LF 行尾 + UTF-8 无 BOM（CRLF/BOM 会让 shebang 失效）。
# ==========================================================================

case "${1:-}" in
  --install|-i) MODE="install" ;;
  --help|-h)    MODE="help" ;;
  *)            MODE="run" ;;
esac

DIR=$(cd "$(dirname "$0")" && pwd) || { echo "[!] 无法定位脚本所在目录"; exit 1; }

if [ "$MODE" = "help" ]; then
  echo "用法：bash start-linux.sh [--install]"
  echo "  （无参数）  直接启动：本地服务 + 浏览器应用窗口，关终端窗口即停"
  echo "  --install   一次性安装到本机，并在桌面生成「双击即开」的图标"
  exit 0
fi

if [ ! -f "$DIR/index.html" ]; then
  echo "[!] 未找到 index.html —— 请把本脚本放在「版本目录」里（与 index.html 同级）。"
  exit 1
fi

# --------------------------------------------------------------------------
#  --install：复制到本机 + 生成桌面 / 应用菜单图标（Kylin / UOS 通用做法）
# --------------------------------------------------------------------------
if [ "$MODE" = "install" ]; then
  APP_NAME="安监智能辅助系统"
  APP="$HOME/.local/share/anjian-helper"
  APPS="$HOME/.local/share/applications"
  LINK="$APPS/anjian-helper.desktop"

  DESK=$(xdg-user-dir DESKTOP 2>/dev/null)
  [ -n "$DESK" ] || DESK="$HOME/桌面"
  [ -d "$DESK" ] || DESK="$HOME/Desktop"
  mkdir -p "$DESK" "$APPS" "$APP" || { echo "[!] 无法写入用户目录（$HOME）"; exit 1; }

  echo "==> 正在复制到本机： $APP"
  cp -rf "$DIR"/. "$APP"/ || { echo "[!] 复制失败，请检查 U 盘是否可读"; exit 1; }
  chmod +x "$APP/start-linux.sh" 2>/dev/null

  ICON="$APP/favicon.ico"
  if [ -d "$APP/icons" ]; then
    for c in "$APP"/icons/*.png; do
      [ -f "$c" ] && ICON="$c" && break
    done
  fi

  cat > "$LINK" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
Comment=本地启动（浏览器应用窗口打开）
Exec=bash "$APP/start-linux.sh"
Path=$APP
Terminal=true
Icon=$ICON
Categories=Utility;
EOF
  chmod +x "$LINK" 2>/dev/null
  cp -f "$LINK" "$DESK/anjian-helper.desktop" 2>/dev/null
  chmod +x "$DESK/anjian-helper.desktop" 2>/dev/null

  echo "==> 完成！"
  echo "    · 以后双击桌面（或应用菜单）里的「$APP_NAME」即可启动；关闭弹出的终端窗口即停止。"
  echo "    · 卸载：删除 $APP 与 $LINK（桌面图标一并删除）。"
  exit 0
fi

# --------------------------------------------------------------------------
#  正常启动
# --------------------------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "[!] 未找到 python3，无法启动本地服务。"
  echo "    安装（麒麟/统信为 deb 系）： sudo apt install -y python3"
  echo "    替代一： python -m SimpleHTTPServer 8788   然后浏览器打开 http://127.0.0.1:8788/"
  echo "    替代二： 直接双击 index.html（注意：离线与「安装为应用」能力会失效）"
  exit 1
fi

PORT=8788
SRV_PID=""
printf '正在启动本地服务'
while [ "$PORT" -lt 8830 ]; do
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SRV_PID=$!
  sleep 1
  kill -0 "$SRV_PID" 2>/dev/null && break
  PORT=$((PORT + 1))
  printf '.'
done
printf '\n'

if ! kill -0 "$SRV_PID" 2>/dev/null; then
  echo "[!] 8788~8829 端口均被占用，未能启动本地服务。请先关掉占用端口的程序再试。"
  exit 1
fi

trap 'kill "$SRV_PID" 2>/dev/null' INT TERM HUP
URL="http://127.0.0.1:$PORT/"

# ---- 打开浏览器：优先 Chromium 内核（支持 --app 应用窗口），其次 Firefox、最后系统默认 ----
BROWSER=""
for B in chromium chromium-browser google-chrome google-chrome-stable microsoft-edge microsoft-edge-stable qaxbrowser kylin-browser 360browser firefox firefox-esr; do
  if command -v "$B" >/dev/null 2>&1; then
    case "$B" in
      firefox|firefox-esr) "$B" --new-window "$URL" >/dev/null 2>&1 & ;;
      *)                   "$B" --app="$URL"        >/dev/null 2>&1 & ;;
    esac
    BROWSER="$B"
    break
  fi
done
if [ -z "$BROWSER" ] && command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 &
  BROWSER="系统默认浏览器（xdg-open）"
fi

echo "=============================================="
echo " 安监智能辅助系统 已在本地启动"
echo "   地址  ： $URL"
echo "   目录  ： $DIR"
echo "   浏览器： ${BROWSER:-未自动打开（请手动复制上面的地址到浏览器打开）}"
echo "   停止  ： 关闭本终端窗口，或按 Ctrl+C"
echo "   提示  ： 想以后双击图标启动，执行： bash start-linux.sh --install"
echo "=============================================="

wait "$SRV_PID"

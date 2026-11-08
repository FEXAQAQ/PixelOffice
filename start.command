#!/bin/sh
# PixelOffice 啟動器（macOS 可直接按兩下；Linux 用 ./start.command 執行）
cd "$(dirname "$0")" || exit 1

echo "============================================="
echo "  PixelOffice 啟動中..."
echo "============================================="
echo

# 1. 檢查 Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[X] 找不到 Node.js。"
  echo
  echo "    PixelOffice 需要 Node.js 18 以上。"
  echo "    請到 https://nodejs.org/ 下載 LTS 版安裝後再試一次。"
  echo
  read -r _
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "[X] Node.js 版本太舊 (目前 v$NODE_MAJOR)，需要 18 以上。"
  echo "    請到 https://nodejs.org/ 安裝新版 LTS。"
  echo
  read -r _
  exit 1
fi
echo "[1/4] Node.js 檢查完成。"

# 2. 準備 .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[2/4] 已建立設定檔 .env（預設為模擬模式，可直接試玩）。"
else
  echo "[2/4] 設定檔 .env 已存在。"
fi

# 3. 安裝套件（只在需要時）
NEED_INSTALL=0
for pkg in express socket.io axios dotenv; do
  [ -d "node_modules/$pkg" ] || NEED_INSTALL=1
done

if [ "$NEED_INSTALL" = "1" ]; then
  echo "[3/4] 第一次啟動，正在安裝相依套件，需要幾分鐘，請勿關閉視窗..."
  if ! npm install; then
    echo
    echo "[X] 套件安裝失敗。請確認網路連線後再試一次。"
    echo
    read -r _
    exit 1
  fi
else
  echo "[3/4] 相依套件已就緒。"
fi

# 4. 啟動
echo "[4/4] 啟動服務，瀏覽器會自動開啟。"
echo
echo "    （要關閉 PixelOffice，直接關掉這個視窗，或按 Ctrl+C）"
echo
OPEN_BROWSER=1 node server.js

echo
echo "PixelOffice 已停止。"
read -r _

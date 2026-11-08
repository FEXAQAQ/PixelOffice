@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title PixelOffice

echo =============================================
echo   PixelOffice 啟動中...
echo =============================================
echo.

rem ---------- 1. 檢查 Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [X] 找不到 Node.js。
  echo.
  echo     PixelOffice 需要 Node.js 18 以上。
  echo     請到 https://nodejs.org/ 下載 LTS 版安裝，
  echo     安裝完成後關掉這個視窗，重新按兩下本檔案即可。
  echo.
  pause
  exit /b 1
)

set NODE_MAJOR=0
for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODE_MAJOR=%%v
if "%NODE_MAJOR%"=="0" set NODE_MAJOR=99
if %NODE_MAJOR% LSS 18 (
  echo [X] Node.js 版本太舊 ^(目前 v%NODE_MAJOR%^)，需要 18 以上。
  echo     請到 https://nodejs.org/ 安裝新版 LTS。
  echo.
  pause
  exit /b 1
)
echo [1/4] Node.js 檢查完成。

rem ---------- 2. 準備 .env ----------
if not exist ".env.example" (
  echo [X] 找不到 .env.example，檔案可能沒有解壓縮完整。
  echo.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [2/4] 已建立設定檔 .env ^(預設為模擬模式，可直接試玩^)。
) else (
  echo [2/4] 設定檔 .env 已存在。
)

rem ---------- 3. 安裝套件（只在需要時） ----------
set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if not exist "node_modules\express" set NEED_INSTALL=1
if not exist "node_modules\socket.io" set NEED_INSTALL=1
if not exist "node_modules\axios" set NEED_INSTALL=1
if not exist "node_modules\dotenv" set NEED_INSTALL=1

if "%NEED_INSTALL%"=="1" (
  echo [3/4] 第一次啟動，正在安裝相依套件，需要幾分鐘，請勿關閉視窗...
  call npm install || goto :install_failed
) else (
  echo [3/4] 相依套件已就緒。
)

rem ---------- 4. 啟動 ----------
echo [4/4] 啟動服務，瀏覽器會自動開啟。
echo.
echo     ^(要關閉 PixelOffice，直接關掉這個視窗，或按 Ctrl+C^)
echo.
set OPEN_BROWSER=1
node server.js

echo.
echo PixelOffice 已停止。
pause
exit /b 0

:install_failed
echo.
echo [X] 套件安裝失敗。請確認網路連線後再試一次。
echo.
pause
exit /b 1

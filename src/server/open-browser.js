// 啟動後自動開啟預設瀏覽器。只有在 OPEN_BROWSER=1 時才動作，
// 所以 `npm start` / `npm run dev` 的行為不變（--watch 每次重啟都開分頁會很吵）。
const { spawn } = require('child_process');

function openBrowser(url) {
  if (String(process.env.OPEN_BROWSER || '') !== '1') return;

  const plat = process.platform;
  let cmd, args;
  if (plat === 'win32') {
    // start 的第一個引數會被當成視窗標題，所以補一個空字串佔位。
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (plat === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  try {
    const proc = spawn(cmd, args, { stdio: 'ignore', detached: true });
    proc.on('error', () => console.log(`  （無法自動開啟瀏覽器，請手動開啟 ${url}）`));
    proc.unref();
  } catch {
    console.log(`  （無法自動開啟瀏覽器，請手動開啟 ${url}）`);
  }
}

module.exports = { openBrowser };

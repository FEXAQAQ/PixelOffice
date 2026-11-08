# 專案結構導覽

PixelOffice 是單一 Node.js 服務加上瀏覽器前端。`server.js` 載入 `src/server/app.js`；Express 提供 API 與靜態檔，Socket.io 推送任務與對話事件。前端使用 Vue 3、Canvas 2D 與原生 JavaScript，依 `public/index.html` 中的 script 順序載入。

```text
PixelOffice/
├─ start.bat / start.command    一鍵啟動器（Windows / macOS）
├─ server.js                    啟動入口
├─ config/                     專案、工程師與 AI 平台設定
├─ src/server/
│  ├─ app.js                   HTTP、Socket 與任務執行協調
│  ├─ open-browser.js          啟動後自動開分頁（僅 OPEN_BROWSER=1）
│  ├─ jira-cache.js            Jira 讀取結果快取（開機預熱、手動重新整理）
│  ├─ config-store.js          專案與工程師設定檔讀寫
│  ├─ ai-settings.js           AI 平台選擇
│  ├─ task-store.js            工單、事件與舊資料遷移
│  ├─ features/                設定 API、成果檢查與交付操作
│  ├─ integrations/            Jira、Claude、Codex 與模型清單
│  ├─ security/                操作核准與自動執行政策
│  └─ workflow/                準備分支與自動開發流程（不含提交與推送）
├─ public/
│  ├─ index.html               主頁模板
│  ├─ pages/                   連線測試與角色檢查頁
│  ├─ js/                      Dashboard、畫面工具、場景與引擎
│  ├─ css/                     頁面與場景樣式
│  └─ assets/backgrounds/      庭院背景 SVG
├─ assets/characters/MetroCity/ 原始角色圖集
├─ test/                       Node 回歸測試
└─ docs/                       使用手冊、技術文件與展示素材
```

執行期工單放在 `task/`，驗收後的工作日誌放在 `note/`（`NOTE_DIR` 可覆寫），兩者都不進版控；`.env` 也不進版控。`config/` 裡由畫面寫入的個人環境設定（`projects.json`、`engineers.json`、`roles.json`、`runtime.json`、`ai.json`）同樣不進版控，改附 `*.example.json` 範本；這些檔案不存在時各自回退到預設值，不影響啟動（`engineers.json` 會以預設名單自動重建）。`TASK_DIR`、`PROJECTS_CONFIG`、`ENGINEERS_CONFIG`、`ROLES_CONFIG`、`AI_CONFIG` 可覆寫資料位置。舊版平面工單在讀取時遷移到每單資料夾，並保留 legacy 備份。

## 修改入口

| 功能 | 主要檔案 |
| --- | --- |
| 主頁內容與對話框 | `public/index.html` |
| 任務、設定與 Socket 前端狀態 | `public/js/dashboard.js` |
| 前端頭像與訊息格式 | `public/js/dashboard-ui.js` |
| 設定視窗操作 | `public/js/dashboard-settings.js` |
| 場景繪製與編輯器 | `public/js/office-scene.js` |
| 角色登記表（PM／BOSS 預設、外觀格式） | `public/js/office-roles.js`；自訂值存在 `config/roles.json` |
| 角色繪製（髮色、配件、頭像） | `public/js/office-sprites.js` |
| 配置、碰撞、尋路 | `public/js/office-engine.js` |
| 任務狀態定義 | `public/js/task-status.js`，供前後端共用 |
| API 與任務協調 | `src/server/app.js` |
| 設定讀寫與 API | `src/server/config-store.js`、`src/server/features/settings-routes.js` |
| CLI 診斷與連線測試 | `src/server/features/connection-routes.js` |
| 自動開發流程 | `src/server/workflow/` |
| 工單儲存 | `src/server/task-store.js` |
| Jira 與 AI CLI | `src/server/integrations/` |
| PM 開單（生成草稿、建立 Jira 工單） | `src/server/features/jira-card-routes.js`、`src/server/integrations/jira-card-prompt.js`、`src/server/integrations/jira-create.js`、`public/js/dashboard-jira-card.js` |
| 開卡提示範本 | `config/jira-card-prompt.md` |
| 操作核准與政策 | `src/server/security/` |
| 成果檢查與 Git 交付 | `src/server/features/engineer-actions.js` |
| BOSS 工作日誌（驗收後寫入 `note/<年>/<月日>.md`、瀏覽與複製） | `src/server/features/work-log.js`、`public/js/dashboard-worklog.js` |
| 一鍵啟動流程 | `start.bat`、`start.command`、`src/server/open-browser.js` |
| Jira 待辦／開單選項快取 | `src/server/jira-cache.js`、`src/server/features/jira-card-routes.js` |

`app.js` 仍是 HTTP、Socket 與手動任務生命週期的協調入口。擴充現有功能時，優先在對應模組實作，再從入口接線，避免把檔案讀寫、外部 API 或顯示格式重新塞回入口。

## 路徑與啟動

開發時在根目錄執行 `npm start`、`npm run dev` 或 `npm test`。給非工程使用者的入口是根目錄的 `start.bat`（Windows）與 `start.command`（macOS）：檢查 Node.js 版本、必要時建立 `.env` 與跑 `npm install`，再以 `OPEN_BROWSER=1` 啟動並自動開分頁；埠被占用時 `app.js` 的 `server.on('error')` 會改印中文提示而非 stack trace。首頁是 `/`；`/test.html` 與 `/character-check.html` 由明確路由提供。角色圖集放在 `assets/characters/MetroCity`，網址維持 `/assets/MetroCity`。`config/`、`task/`、`.env` 不作靜態公開。

前端依序載入 `office-roles.js`、`office-engine.js`、`office-sprites.js`、`office-scene.js`、`task-status.js`、`dashboard-ui.js`、`dashboard-settings.js`、`dashboard.js`。CSS 載入順序見 `public/index.html`，詳細場景說明見 [辦公室 UI 技術文件](OFFICE_UI_TECHNICAL.md)。完整操作方式見 [使用手冊](USER_GUIDE.md)。

const path = require('path');

/**
 * 會 spawn 真正的 server.js 的測試，必須把「所有執行期設定檔」指到暫存目錄。
 *
 * 那些測試繼承 process.env，而 server.js 的設定檔預設在專案的 config/ 底下 ——
 * 漏掉任何一個，測試就會讀到（甚至寫入）開發者本機的真實設定。
 * 實際發生過兩次：CLAUDE_MODE=mock 被本機設定覆寫成 real 而真的跑起 Claude CLI；
 * 以及 JIRA_MODE=mock 被覆寫成 mcp，測試連上了線上 Jira 看板。
 *
 * 所以新增設定檔時，只要改這裡一處，兩支測試就同時受保護。
 */
function isolatedConfigEnv(dir) {
  return {
    RUNTIME_CONFIG: path.join(dir, 'runtime.json'),
    AI_CONFIG: path.join(dir, 'ai.json'),
    ENGINEERS_CONFIG: path.join(dir, 'engineers.json'),
    PROJECTS_CONFIG: path.join(dir, 'projects.json'),
  };
}

module.exports = { isolatedConfigEnv };

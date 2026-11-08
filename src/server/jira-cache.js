/**
 * Jira 讀取結果的記憶體快取。
 *
 * 撈 Jira 要走 MCP（spawn npx、OAuth、多次 tools/call），實測 9~50 秒，
 * 每次開「待辦清單」或「開新單」都重撈，使用者就是在等那段。
 *
 * 策略刻意保守：開機先背景撈一次，之後只有使用者按「重新整理」或改了
 * Jira 設定才會重撈。不做定時自動更新 —— 資料何時該更新由使用者決定，
 * 畫面上會顯示這份資料是幾點取的。
 */

/**
 * @param {object} opts
 * @param {Record<string, () => Promise<any>>} opts.loaders 每個名稱對應一個真正去撈的函式
 * @param {(name: string, state: object) => void} [opts.onState] 狀態變化通知（接 Socket.io）
 */
function createJiraCache({ loaders, onState = () => {} }) {
  const entries = new Map();

  function entry(name) {
    if (!loaders[name]) throw Error(`未知的快取項目：${name}`);
    if (!entries.has(name)) entries.set(name, { data: null, error: '', fetchedAt: 0, inflight: null });
    return entries.get(name);
  }

  /** 給畫面看的狀態，不含資料本身。 */
  function state(name) {
    const e = entry(name);
    return { name, ready: !!e.data, loading: !!e.inflight, fetchedAt: e.fetchedAt, error: e.error };
  }

  function notify(name) {
    try { onState(name, state(name)); } catch (_) { /* 通知失敗不該影響取資料 */ }
  }

  /** 同一項目同時只會有一個真正的請求在跑，後到的共用同一個 promise。 */
  function start(name) {
    const e = entry(name);
    if (e.inflight) return e.inflight;
    e.inflight = Promise.resolve()
      .then(() => loaders[name]())
      .then((data) => {
        e.data = data; e.error = ''; e.fetchedAt = Date.now();
        return data;
      })
      .catch((err) => {
        e.error = err && err.message ? err.message : String(err);
        throw err;
      })
      .finally(() => { e.inflight = null; notify(name); });
    notify(name);
    return e.inflight;
  }

  /**
   * 取資料。有快取就直接回（不等待）；沒有就等這次撈完。
   * @param {string} name
   * @param {{refresh?: boolean}} [opts] refresh=true 強制重撈
   */
  async function read(name, { refresh = false } = {}) {
    const e = entry(name);
    if (!refresh && e.data) return { data: e.data, fetchedAt: e.fetchedAt, fromCache: true };
    // 沒資料時就算上次失敗也要再試一次，否則開機撈失敗會一直卡著舊錯誤。
    const data = await (refresh ? start(name) : (e.inflight || start(name)));
    return { data, fetchedAt: e.fetchedAt, fromCache: false };
  }

  /** 開機預熱：背景撈，失敗只記錄不拋出，不能擋住伺服器啟動。 */
  function warm(names = Object.keys(loaders)) {
    for (const name of names) start(name).catch(() => {});
  }

  /** 設定變更後把資料丟掉（下次讀取會重撈）。 */
  function invalidate(names = Object.keys(loaders)) {
    for (const name of names) {
      const e = entry(name);
      e.data = null; e.error = ''; e.fetchedAt = 0;
      notify(name);
    }
  }

  function states() {
    return Object.keys(loaders).map(state);
  }

  return { read, warm, invalidate, state, states };
}

module.exports = { createJiraCache };

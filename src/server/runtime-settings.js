const fs = require('fs');
const path = require('path');

/**
 * 可在畫面上改、不需重啟的設定。
 *
 * values = 列舉型（第一個是保底值）；pattern = 自由輸入（fallback 是保底值）。
 * mode 是全域開關：mock 時 AI 與 Jira 都使用模擬資料；
 * real 時 AI 執行真實 CLI，Jira 固定使用 Atlassian MCP。
 */
const FIELDS = {
  mode: { values: ['mock', 'real'] },
  accessMode: { values: ['ask', 'auto', 'full'] },
  // 看板數字 ID。空字串 = 未設定；它不是機密，所以可以從畫面輸入
  // （JIRA_EMAIL / JIRA_API_TOKEN 是機密，維持只從 .env 讀）。
  jiraBoardId: { pattern: /^\d*$/, fallback: '', hint: 'Jira 看板 ID 必須是數字' },
  // 選配功能模組：預設關閉，啟用後才在畫面上出現、API 才接受呼叫。
  jev: { values: ['off', 'on'] },
};
const KEYS = Object.keys(FIELDS);

const isValid = (key, value) => {
  const field = FIELDS[key];
  return field.values ? field.values.includes(value) : field.pattern.test(value);
};

/**
 * env 只提供「開機預設值」，設定檔存的是使用者在畫面上做的**覆寫**。
 * 沒被覆寫過的項目不會寫進檔案 —— 這樣改 .env 對它仍然有效，
 * 不會因為存過一次設定就把 env 永久蓋掉。
 */
function createRuntimeSettings(file, defaults = {}) {
  const fallback = {};
  for (const key of KEYS) {
    const field = FIELDS[key];
    const value = String(defaults[key] ?? '').toLowerCase();
    fallback[key] = isValid(key, value) && value !== ''
      ? value
      : (field.values ? field.values[0] : field.fallback);
  }

  let overrides = {};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of KEYS) {
      if (typeof saved[key] === 'string' && isValid(key, saved[key])) overrides[key] = saved[key];
    }
    if (!('mode' in overrides) &&
        (saved.jira === 'mcp' || saved.jira === 'real' || saved.claude === 'real' || saved.codex === 'real')) {
      overrides.mode = 'real';
    }
  } catch (error) {
    // 檔案不存在是正常的（還沒人改過設定）；其他錯誤要讓它浮出來。
    if (error.code !== 'ENOENT') throw error;
  }

  const get = (key) => (key in overrides ? overrides[key] : fallback[key]);

  return {
    get,
    all: () => Object.fromEntries(KEYS.map((key) => [key, get(key)])),
    /** 目前值來自 env 預設還是畫面上的覆寫，供 UI 說明用 */
    overridden: () => Object.fromEntries(KEYS.map((key) => [key, key in overrides])),
    defaults: () => ({ ...fallback }),
    values: () => Object.fromEntries(KEYS.map((key) => [key, FIELDS[key].values ? [...FIELDS[key].values] : null])),
    set(key, value) {
      if (!KEYS.includes(key)) throw Error(`未知的設定項目：${key}`);
      if (typeof value !== 'string' || !isValid(key, value)) {
        throw Error(FIELDS[key].values
          ? `${key} 必須為 ${FIELDS[key].values.join(' / ')}`
          : FIELDS[key].hint);
      }
      if (get(key) === value && key in overrides) return;
      const next = { ...overrides, [key]: value };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 先寫暫存檔再 rename：中途當掉不會留下半個壞掉的 JSON。
      const temp = `${file}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
      fs.renameSync(temp, file);
      overrides = next;
    },
  };
}

// 只影響畫面與選配 API、不會改變執行中任務行為的設定，任務執行中也允許切換。
const MODULE_KEYS = ['jev'];

module.exports = { createRuntimeSettings, SETTING_KEYS: KEYS, MODULE_KEYS };

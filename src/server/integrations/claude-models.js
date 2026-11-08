const axios = require('axios');

// Claude CLI 沒有模型清單；合併別名、Models API 與執行時觀察到的模型。
const MODEL_ALIASES = [
  { value: 'opus',   label: 'Opus（最新）',   hint: '最強，適合難的重構' },
  { value: 'sonnet', label: 'Sonnet（最新）', hint: '平衡，日常首選' },
  { value: 'haiku',  label: 'Haiku（最新）',  hint: '最便宜，適合雜事' },
  { value: 'fable',  label: 'Fable（最新）',  hint: '最強推理，成本最高' },
];

// 實際執行時從 system/init 收到的 model id（跨任務累積）
const seenModels = new Set();

let modelCache = { at: 0, models: null, error: null };
const MODEL_CACHE_MS = 60 * 60 * 1000;

/** 有 ANTHROPIC_API_KEY 才撈得到真實清單；沒有就回 null，讓前端只顯示別名 */
async function fetchModelList() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { models: null, error: '沒有設定 ANTHROPIC_API_KEY，只能用別名' };
  if (modelCache.models && Date.now() - modelCache.at < MODEL_CACHE_MS) {
    return { models: modelCache.models, error: null };
  }
  try {
    const res = await axios.get('https://api.anthropic.com/v1/models', {
      params: { limit: 100 },
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      timeout: 10000,
    });
    const models = (res.data.data || []).map((m) => ({
      id: m.id,
      displayName: m.display_name || m.id,
      maxInputTokens: m.max_input_tokens || null,
      maxTokens: m.max_tokens || null,
    }));
    modelCache = { at: Date.now(), models, error: null };
    return { models, error: null };
  } catch (err) {
    const msg = err.response
      ? `Models API 回 ${err.response.status}`
      : `連不上 Models API：${err.message}`;
    modelCache = { at: Date.now(), models: null, error: msg };
    return { models: null, error: msg };
  }
}

module.exports = { MODEL_ALIASES, seenModels, fetchModelList };

// claude CLI 的 stream-json 訊息 → 前端要渲染的正規化事件。
//
// 從 app.js 抽出來是為了能單獨測試：app.js 一被 require 就會把 server 起起來，
// 這裡的轉換規則卻是整個「看得到工程師在做什麼」的基礎，值得單獨釘住。

/** 超過 n 個字就截斷，並記下少了幾個字。 */
function clip(s, n) {
  const str = typeof s === 'string' ? s : String(s == null ? '' : s);
  return str.length > n ? { text: str.slice(0, n), truncated: str.length - n } : { text: str };
}

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return content == null ? '' : JSON.stringify(content);
}

/**
 * 把 claude 的一個 stream-json 訊息，轉成前端要渲染的正規化事件（可能一對多）。
 *
 * ⚠️ 刻意寫得寬鬆：認得的形狀就轉，認不得的一律當 raw 丟出去。
 *    寧可畫面上出現一行看不懂的 JSON，也不要因為格式沒對上就靜默吞掉內容。
 */
/** 只回報進度、不帶內容的 system 訊息；要再擋別的加在這裡就好。 */
const NOISE_SYSTEM_SUBTYPES = new Set(['thinking_tokens']);

function normalizeClaudeMessage(msg) {
  const out = [];
  if (!msg || typeof msg !== 'object') return out;
  // 非 null 代表這是 subagent 的訊息（值是產生它的那個 tool_use id）
  const parentId = msg.parent_tool_use_id || null;

  if (msg.type === 'system') {
    // 純進度回報，內容只有計數器，沒有任何可讀資訊。
    // thinking_tokens 每累積 50～200 個思考 token 就送一筆 —— 實測一張單 1411 筆
    // 事件裡有 868 筆是它（62%），把真正的對話沖到捲不完。這種訊息直接丟掉，
    // 不進對話、也不寫進 log.jsonl。
    if (NOISE_SYSTEM_SUBTYPES.has(msg.subtype)) return out;
    if (msg.subtype === 'init') {
      out.push({
        kind: 'system', subtype: 'init',
        model: msg.model || '', sessionId: msg.session_id || '',
        toolCount: Array.isArray(msg.tools) ? msg.tools.length : null,
        cwd: msg.cwd || '',
      });
    } else if (msg.subtype === 'api_retry') {
      out.push({
        kind: 'system', subtype: 'api_retry',
        attempt: msg.attempt, maxRetries: msg.max_retries,
        delayMs: msg.retry_delay_ms, error: msg.error || '',
      });
    } else {
      out.push({ kind: 'system', subtype: msg.subtype || 'info', ...clip(JSON.stringify(msg), 400) });
    }
    return out;
  }

  if (msg.type === 'assistant' || msg.type === 'user') {
    const blocks = (msg.message && msg.message.content) || [];
    for (const b of Array.isArray(blocks) ? blocks : []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && b.text) {
        out.push({ kind: 'text', role: msg.type, parentId, ...clip(b.text, 20000) });
      } else if (b.type === 'thinking' && b.thinking) {
        out.push({ kind: 'thinking', parentId, ...clip(b.thinking, 8000) });
      } else if (b.type === 'tool_use') {
        // Write / Edit 的 input 會夾帶整份檔案內容，一定要截
        out.push({
          kind: 'tool_use', id: b.id || '', name: b.name || '(unknown)', parentId,
          ...clip(JSON.stringify(b.input == null ? {} : b.input), 2000),
        });
      } else if (b.type === 'tool_result') {
        out.push({
          kind: 'tool_result', id: b.tool_use_id || '', isError: !!b.is_error, parentId,
          ...clip(blockText(b.content), 4000),
        });
      }
    }
    return out;
  }

  if (msg.type === 'result') {
    out.push({
      kind: 'result', subtype: msg.subtype || '', isError: !!msg.is_error,
      durationMs: msg.duration_ms || null, numTurns: msg.num_turns || null,
      costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
      sessionId: msg.session_id || '',
      ...clip(typeof msg.result === 'string' ? msg.result : '', 20000),
    });
    return out;
  }

  // stream_event 是逐 token 的 delta；我們沒開 --include-partial-messages，忽略
  if (msg.type === 'stream_event') return out;

  out.push({ kind: 'raw', stream: 'stdout', ...clip(JSON.stringify(msg), 800) });
  return out;
}

module.exports = {clip, blockText, normalizeClaudeMessage, NOISE_SYSTEM_SUBTYPES};

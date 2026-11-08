/**
 * 開卡提示的組裝與回覆解析。
 *
 * 提示樣板放在 config/jira-card-prompt.md（使用者可自行修改），這裡只負責
 * 「挑出對應議題類型的範本 → 填入佔位符 → 解析 AI 回來的 JSON」。
 * 全部是純函式，沒有檔案讀寫與網路，方便單獨測試。
 */

const fs = require('fs');
const path = require('path');

/** 開單支援的議題類型；順序即畫面上的下拉順序。要新增類型記得同步補上描述範本。 */
const ISSUE_TYPES = ['任務', '錯誤'];

const TEMPLATE_HEADING = /^##[ \t]+描述範本[ \t]*·[ \t]*(.+?)[ \t]*$/gm;

const DEFAULT_PROMPT_FILE = path.resolve(__dirname, '../../../config/jira-card-prompt.md');

/** 目前實際採用的提示樣板路徑；畫面會把它顯示出來，方便使用者直接去改。 */
function promptFilePath() {
  return path.resolve(process.env.JIRA_CARD_PROMPT_FILE || DEFAULT_PROMPT_FILE);
}

function readPromptDoc(file = promptFilePath()) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw Error(`讀不到開卡提示樣板 ${file}：${err.message}`);
  }
}

/**
 * 從樣板文件切出「基礎指示」與各議題類型的描述範本。
 * 範本內容取該段落內第一個 fenced code block；沒有圍欄就取整段文字。
 */
function parsePromptDoc(doc) {
  const text = String(doc || '');
  const headings = [...text.matchAll(TEMPLATE_HEADING)];
  const base = (headings.length ? text.slice(0, headings[0].index) : text).trim();
  const templates = {};
  headings.forEach((h, i) => {
    const body = text.slice(h.index + h[0].length, i + 1 < headings.length ? headings[i + 1].index : text.length);
    const fenced = body.match(/```[^\n]*\n([\s\S]*?)```/);
    templates[h[1]] = (fenced ? fenced[1] : body).trim();
  });
  return { base, templates };
}

/**
 * 各議題類型給畫面看的說明：顯示名稱、用途、輸入範例、會產生哪些章節。
 * 取自範本段落圍欄前的 `> 顯示名稱：`、`> 用途：`、`> 範例：` 引言（不會送給 AI）；
 * 顯示名稱只影響畫面，建單時送給 Jira 的仍是類型本名。
 * 章節直接從範本的 `##` 標題列出來，改了範本畫面就跟著變；
 * 標題後面的英文括號（例如「（What）」）只為了縮短畫面上的標籤而拿掉，送給 AI 的範本不動。
 */
function describeIssueTypes(doc) {
  const text = String(doc || '');
  const headings = [...text.matchAll(TEMPLATE_HEADING)];
  const { templates } = parsePromptDoc(text);
  const info = {};
  headings.forEach((h, i) => {
    const type = h[1];
    const body = text.slice(h.index + h[0].length, i + 1 < headings.length ? headings[i + 1].index : text.length);
    const intro = body.split('```')[0];
    const pick = (label) => {
      const m = intro.match(new RegExp(`^>[ \\t]*${label}[：:][ \\t]*(.+)$`, 'm'));
      return m ? m[1].trim() : '';
    };
    const sections = [...(templates[type] || '').matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map((m) => m[1].replace(/[ 	]*[（(][A-Za-z][A-Za-z 	-]*[）)][ 	]*$/, ''));
    info[type] = { label: pick('顯示名稱') || type, purpose: pick('用途'), example: pick('範例'), sections };
  });
  return info;
}

/**
 * 組出丟給 AI 的完整提示。
 * 佔位符用函式替換（不是字串 replace），避免使用者輸入裡的 `$&`、`$1`
 * 被當成 replacement pattern 展開。
 */
function buildCardPrompt({ doc, issueType, input }) {
  const type = String(issueType || '').trim();
  if (!type) throw Error('請選擇議題類型');
  const requirement = String(input || '').trim();
  if (!requirement) throw Error('請先輸入需求內容');

  const { base, templates } = parsePromptDoc(doc);
  const template = templates[type];
  if (!base) throw Error('開卡提示樣板沒有內容');
  if (!template) throw Error(`開卡提示樣板缺少「${type}」的描述範本，不支援這個議題類型`);

  return base
    .replace(/\{\{ISSUE_TYPE\}\}/g, () => type)
    .replace(/\{\{TEMPLATE\}\}/g, () => template)
    .replace(/\{\{INPUT\}\}/g, () => requirement);
}

const SUMMARY_MAX = 255; // Jira 摘要欄位上限

/**
 * 解析 AI 回覆。要求是純 JSON，但 CLI 偶爾會補一層說明或 ```json 圍欄，
 * 所以退而求其次取第一個 `{` 到最後一個 `}`。解析不出來就報錯，不猜內容。
 */
function parseCardDraft(raw) {
  const text = String(raw || '').trim();
  if (!text) throw Error('AI 沒有回傳任何內容');

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let parsed;
  if (start >= 0 && end > start) {
    try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Error('AI 回傳的不是預期的 JSON 格式，請重新生成');
  }

  const summary = String(parsed.summary ?? '').replace(/\s+/g, ' ').trim();
  const description = String(parsed.description ?? '').trim();
  if (!summary) throw Error('AI 沒有生成摘要，請重新生成');
  if (!description) throw Error('AI 沒有生成描述，請重新生成');
  if (summary.length > SUMMARY_MAX) throw Error(`摘要超過 ${SUMMARY_MAX} 字，請重新生成或手動修短`);

  return { summary, description };
}

/**
 * AI 為 mock 模式時的替代草稿。
 * 刻意標記來源並保留範本骨架，讓畫面能照常預覽，但不會被誤認為 AI 產出。
 */
function mockCardDraft({ doc, issueType, input }) {
  const { templates } = parsePromptDoc(doc);
  const requirement = String(input || '').trim();
  const firstLine = requirement.split('\n').find((l) => l.trim()) || '未命名需求';
  return {
    summary: `【Mock】${firstLine.trim().slice(0, 50)}`,
    description:
      `> 【Mock 示範，非 AI 生成】切換到 real 模式才會實際呼叫 AI 生成內容。\n\n` +
      `${templates[issueType] || ''}\n\n---\n\n原始輸入：\n\n${requirement}`,
  };
}

module.exports = {
  ISSUE_TYPES,
  DEFAULT_PROMPT_FILE,
  promptFilePath,
  readPromptDoc,
  parsePromptDoc,
  describeIssueTypes,
  buildCardPrompt,
  parseCardDraft,
  mockCardDraft,
  SUMMARY_MAX,
};

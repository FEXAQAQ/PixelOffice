// 工作日誌：任務驗收完成時寫入 note/<年>/<月日>.md，給老闆瀏覽當天交付了什麼。
//
// 一天可能驗收很多張單，所以同目錄另存一份 <月日>.json 當結構化來源，
// 每次驗收都「更新該單 → 重算當日總覽 → 整份重寫 .md」。同一張單當天重驗只會更新，不會重複。
// .md 是呈現結果，手動修改會在當天下一次驗收時被覆蓋；要加註請寫在別的檔案。
const fs = require('fs');
const path = require('path');

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = '日一二三四五六';
const pad = n => String(n).padStart(2, '0');
const dateOf = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const timeOf = ts => { if (!ts) return '—'; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim();
const cut = (text, n) => text.length > n ? text.slice(0, n - 1) + '…' : text;

function minutes(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分`;
}

/**
 * 報告可能是條列、也可能是一段話，一律轉成 Markdown 條列。
 * 縮排的子項目（例如「- 部署」底下的 1. 2. 3.）保留一層，其餘一律當成主項目。
 */
function bullets(text, limit = 8) {
  const out = [];
  let top = 0, subs = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^PIXELOFFICE_(DONE|BLOCKED):?\s*$/.test(line)) continue;
    const marker = line.match(/^([-*•]|\d+[.)])\s+/), body = cut(line.slice(marker ? marker[0].length : 0).replace(/^PIXELOFFICE_DONE:\s*/, ''), 240);
    if (/^\s{2,}/.test(raw) && marker && top) {
      if (subs++ < 6) out.push(`  ${/\d/.test(marker[1]) ? marker[1].replace(')', '.') : '-'} ${body}`);
    } else {
      if (top++ >= limit) break;
      subs = 0; out.push('- ' + body);
    }
  }
  return out;
}

/** 手動派工沒有自動成果報告，改從執行紀錄取工程師最後的完成說明。 */
function lastWords(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if ((ev.kind === 'text' && ev.role === 'assistant') || (ev.kind === 'result' && !ev.isError)) if (oneLine(ev.text)) return ev.text;
  }
  return '';
}

/** 從任務紀錄萃取老闆需要的欄位；只留結論，不放 diff 與工具紀錄。 */
function entryFromTask(task, events = []) {
  const feedback = events.filter(ev => ev.kind === 'feedback').length;
  const report = bullets(task.resultReport);
  const outcome = report.length ? report : bullets(task.resultSummary || lastWords(events), 4);
  const notes = [];
  if (task.mock) notes.push('模擬模式產生，未實際修改程式碼。');
  if (task.policyNotice) notes.push(`過程中有操作被自動模式擋下：${oneLine(task.policyNotice)}`);
  if (task.resultReportError) notes.push(oneLine(task.resultReportError));
  return {
    key: task.key, summary: oneLine(task.summary), type: task.type || '', priority: task.priority || '',
    sprint: task.sprint?.name || '', engineer: task.engineerName || '未記錄', provider: task.provider || '', model: task.model || '',
    project: task.projectName || '', branch: task.branch || '',
    startedAt: task.startedAt || task.claimedAt || null, finishedAt: task.finishedAt || null, acceptedAt: task.acceptedAt || Date.now(),
    costUsd: Number.isFinite(task.costUsd) ? task.costUsd : null, feedback,
    outcome: outcome.length ? outcome : ['- 工程師未留下成果說明，請至任務監看查看執行紀錄。'],
    selfReport: task.resultReport && task.resultSummary ? cut(oneLine(task.resultSummary), 400) : '',
    requirement: cut(oneLine(task.description), 200), notes,
  };
}

const spent = e => (e.startedAt && e.finishedAt ? e.finishedAt - e.startedAt : 0);
const tally = (items, pick) => {
  const map = new Map();
  for (const item of items) { const k = pick(item); if (k) map.set(k, (map.get(k) || 0) + 1); }
  return [...map].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join('、');
};

function renderDay(date, entries) {
  const [, y, m, d] = date.match(DATE_PATTERN);
  const weekday = WEEKDAYS[new Date(+y, +m - 1, +d).getDay()];
  const list = [...entries].sort((a, b) => a.acceptedAt - b.acceptedAt);
  const cost = list.filter(e => e.costUsd != null).reduce((s, e) => s + e.costUsd, 0);
  const rounds = list.reduce((s, e) => s + e.feedback, 0), total = minutes(list.reduce((s, e) => s + spent(e), 0));
  const stats = [
    `驗收完成 **${list.length}** 項`,
    `工程師：${tally(list, e => e.engineer)}`,
    tally(list, e => e.project) && `專案：${tally(list, e => e.project)}`,
  ].filter(Boolean);
  const effort = [
    tally(list, e => e.type) && `類型：${tally(list, e => e.type)}`,
    total && `開發耗時合計 ${total}`,
    `驗收退回修正 ${rounds} 次`,
    list.some(e => e.costUsd != null) && `AI 成本 US$${cost.toFixed(2)}`,
  ].filter(Boolean);
  const out = [`# 工作日誌｜${date}（${weekday}）`, '', `> ${stats.join(' ｜ ')}`, `> ${effort.join(' ｜ ')}`, '', '## 今日重點', ''];
  list.forEach((e, i) => {
    const tags = [e.type, e.priority].filter(Boolean).join('／');
    out.push(`${i + 1}. **[${e.key}] ${e.summary}** — ${e.engineer}${e.project ? ' · ' + e.project : ''}${tags ? `（${tags}）` : ''}`);
    out.push(`   ${e.outcome[0].replace(/^- /, '')}`);
  });
  const attention = list.filter(e => e.notes.length);
  if (attention.length) {
    out.push('', '## 需要留意', '');
    attention.forEach(e => e.notes.forEach(n => out.push(`- [${e.key}] ${n}`)));
  }
  out.push('', '## 任務明細');
  list.forEach((e, i) => {
    const duration = minutes(spent(e));
    out.push('', `### ${i + 1}. [${e.key}] ${e.summary}`, '');
    if (e.type || e.priority) out.push(`- **類型／優先度**：${[e.type, e.priority].filter(Boolean).join('／')}`);
    out.push(`- **負責人**：${e.engineer}${e.model || e.provider ? `（${[e.provider, e.model].filter(Boolean).join(' · ')}）` : ''}`);
    if (e.project || e.branch) out.push(`- **專案／分支**：${e.project || '—'}${e.branch ? '／' + e.branch : ''}`);
    if (e.sprint) out.push(`- **Sprint**：${e.sprint}`);
    out.push(`- **時程**：${timeOf(e.startedAt)} 開始 → ${timeOf(e.finishedAt)} 完成 → ${timeOf(e.acceptedAt)} 驗收${duration ? `（開發 ${duration}）` : ''}`);
    out.push(`- **驗收退回**：${e.feedback} 次`);
    if (e.costUsd != null) out.push(`- **AI 成本**：US$${e.costUsd.toFixed(2)}`);
    out.push('', '**交付成果**', '', ...e.outcome);
    if (e.selfReport) out.push('', '**工程師回報（含測試）**', '', `> ${e.selfReport}`);
    if (e.requirement) out.push('', '**需求摘要**', '', `> ${e.requirement}`);
    if (e.notes.length) out.push('', '**注意事項**', '', ...e.notes.map(n => `- ${n}`));
  });
  return out.join('\n') + '\n';
}

function createWorkLog(root) {
  root = path.resolve(root);
  function files(date) {
    const match = String(date).match(DATE_PATTERN);
    if (!match) throw Error('日期格式應為 YYYY-MM-DD');
    const dir = path.join(root, match[1]), base = match[2] + match[3];
    return {dir, md: path.join(dir, base + '.md'), json: path.join(dir, base + '.json')};
  }
  function write(file, text) {
    const temp = file + '.tmp';
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  }
  function entries(date) {
    try { return JSON.parse(fs.readFileSync(files(date).json, 'utf8')).entries || []; }
    catch (_) { return []; }
  }
  /** 驗收完成時呼叫：以驗收當天（伺服器本地時間）歸檔，同一張單只保留最新一筆。 */
  function record(task, events) {
    const entry = entryFromTask(task, events), date = dateOf(entry.acceptedAt), f = files(date);
    const list = entries(date).filter(e => e.key !== entry.key).concat(entry);
    fs.mkdirSync(f.dir, {recursive: true});
    write(f.json, JSON.stringify({date, entries: list}, null, 2));
    write(f.md, renderDay(date, list));
    return {date, file: f.md, count: list.length};
  }
  function listDates() {
    if (!fs.existsSync(root)) return [];
    const out = [];
    for (const year of fs.readdirSync(root).filter(n => /^\d{4}$/.test(n))) {
      for (const name of fs.readdirSync(path.join(root, year))) {
        const m = name.match(/^(\d{2})(\d{2})\.md$/);
        if (!m) continue;
        const date = `${year}-${m[1]}-${m[2]}`;
        out.push({date, count: entries(date).length});
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }
  function read(date) {
    const f = files(date);
    return fs.existsSync(f.md) ? {date, markdown: fs.readFileSync(f.md, 'utf8'), count: entries(date).length} : null;
  }
  return {record, listDates, read, files};
}

function installWorkLogRoutes(app, {workLog}) {
  app.get('/api/worklog', (req, res) => res.json({dates: workLog.listDates(), today: dateOf(Date.now())}));
  app.get('/api/worklog/:date', (req, res) => {
    if (!DATE_PATTERN.test(req.params.date)) return res.status(400).json({error: '日期格式應為 YYYY-MM-DD'});
    const day = workLog.read(req.params.date);
    day ? res.json(day) : res.status(404).json({error: `${req.params.date} 沒有工作日誌`});
  });
}

module.exports = {createWorkLog, installWorkLogRoutes, entryFromTask, renderDay, dateOf};

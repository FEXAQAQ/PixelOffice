const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createWorkLog, entryFromTask} = require('../src/server/features/work-log');
const {renderMarkdown, summaryOf, plainOf} = require('../public/js/dashboard-worklog');

const at = (h, m) => new Date(2026, 8, 23, h, m).getTime();
const task = (key, extra = {}) => ({
  key, summary: `任務 ${key}`, type: 'Bug', priority: 'High', engineerName: 'Alice', projectName: 'Web', branch: `claude/${key}`,
  provider: 'claude', model: 'sonnet', startedAt: at(9, 0), finishedAt: at(9, 30), acceptedAt: at(10, 0), costUsd: 0.04,
  description: '修復登入頁在手機寬度下按鈕溢出的問題。', resultReport: '- 修正按鈕寬度\n- 補上 RWD 測試', resultSummary: '已執行 npm test，12 項通過', ...extra,
});

function tempLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worklog-'));
  return {dir, log: createWorkLog(dir), done: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('accepted tasks are filed under note/<year>/<MMDD>.md and merged into one daily log', () => {
  const {dir, log, done} = tempLog();
  try {
    log.record(task('WEB-1'), []);
    const second = log.record(task('WEB-2', {engineerName: 'Bob', projectName: 'API', type: 'Story', acceptedAt: at(15, 5), costUsd: 0.1}), [{kind: 'feedback'}]);
    assert.equal(second.file, path.join(dir, '2026', '0923.md'));
    assert.equal(second.count, 2);
    const md = fs.readFileSync(second.file, 'utf8');
    assert.match(md, /^# 工作日誌｜2026-09-23（三）/);
    assert.match(md, /驗收完成 \*\*2\*\* 項/);
    assert.match(md, /工程師：Alice 1、Bob 1/);
    assert.match(md, /驗收退回修正 1 次/);
    assert.match(md, /AI 成本 US\$0\.14/);
    assert.ok(md.indexOf('[WEB-1]') < md.indexOf('[WEB-2]'), 'ordered by acceptance time');
    assert.match(md, /### 2\. \[WEB-2\][\s\S]*驗收退回\*\*：1 次/);
    assert.match(md, /\*\*工程師回報（含測試）\*\*\n\n> 已執行 npm test/);
    assert.deepEqual(log.listDates(), [{date: '2026-09-23', count: 2}]);
  } finally { done(); }
});

test('re-accepting the same task on the same day updates its entry instead of duplicating it', () => {
  const {log, done} = tempLog();
  try {
    log.record(task('WEB-1'), []);
    log.record(task('WEB-1', {summary: '改過的標題', acceptedAt: at(11, 0)}), []);
    const day = log.read('2026-09-23');
    assert.equal(day.count, 1);
    assert.match(day.markdown, /改過的標題/);
    assert.doesNotMatch(day.markdown, /任務 WEB-1/);
    assert.equal(log.read('2026-09-24'), null);
    assert.throws(() => log.read('../etc'), /日期格式/);
  } finally { done(); }
});

test('manual tasks without a report fall back to the engineer\'s last words, and risks are surfaced', () => {
  const entry = entryFromTask(task('WEB-3', {resultReport: null, resultSummary: null, mock: true, policyNotice: 'git push 被擋下'}),
    [{kind: 'text', role: 'assistant', text: '完成了登入頁修正，測試通過。'}, {kind: 'result', isError: false, text: 'WEB-3 已完成'}]);
  assert.deepEqual(entry.outcome, ['- WEB-3 已完成']);
  assert.equal(entry.notes.length, 2);
  const bare = entryFromTask({key: 'WEB-4', summary: 'x'}, []);
  assert.match(bare.outcome[0], /未留下成果說明/);
});

test('viewer escapes file content, renders the log structure and copies a summary without details', () => {
  const html = renderMarkdown('# 標題\n\n> 一 ｜ 二\n\n1. **[A-1] <b>x</b>** — Alice\n   修正按鈕\n\n- `code` 項目');
  assert.match(html, /<h2>標題<\/h2>/);
  assert.match(html, /<blockquote>一 ｜ 二<\/blockquote>/);
  assert.match(html, /<ol><li><strong>\[A-1\] &lt;b&gt;x&lt;\/b&gt;<\/strong> — Alice<span class="wl-sub">修正按鈕<\/span><\/li><\/ol>/);
  assert.match(html, /<ul><li><code>code<\/code> 項目<\/li><\/ul>/);
  assert.equal(summaryOf('# t\n\n## 今日重點\n\n1. a\n\n## 任務明細\n\n### 1. a\n'), '# t\n\n## 今日重點\n\n1. a\n');
});

test('plain copy keeps only key, title and outcomes, preserving one level of numbered sub-items', () => {
  const {log, done} = tempLog();
  try {
    log.record(task('DEMO-1530', {summary: 'DEMO 主站 Log 盤點與統一實作', resultReport:
      '- 部署 v1.0.21 到正式環境，完成 **S7-2b**\n  1. 掛載 demo-applog1\n  2) 掛載 demo-applog2\n- 驗證正式環境兩台的新掛載與落檔正常\n- 逐台切換到 `Serilog`'}), []);
    log.record(task('DEMO-123', {summary: '卡片標題', acceptedAt: at(11, 0), resultReport: '1. 只有一項成果'}), []);
    const md = log.read('2026-09-23').markdown;
    assert.match(md, /- 部署 v1\.0\.21[^\n]*\n  1\. 掛載 demo-applog1\n  2\. 掛載 demo-applog2\n- 驗證/);
    assert.equal(plainOf(md), [
      'DEMO-1530 DEMO 主站 Log 盤點與統一實作',
      '- 部署 v1.0.21 到正式環境，完成 S7-2b',
      ' 1. 掛載 demo-applog1',
      ' 2. 掛載 demo-applog2',
      '- 驗證正式環境兩台的新掛載與落檔正常',
      '- 逐台切換到 Serilog',
      '',
      'DEMO-123 卡片標題',
      '- 只有一項成果',
      '',
    ].join('\n'));
    assert.match(renderMarkdown(md), /<li>部署[^<]*<strong>S7-2b<\/strong><span class="wl-sub">1\. 掛載 demo-applog1<\/span>/);
    assert.equal(plainOf('# 空的一天\n'), '');
  } finally { done(); }
});
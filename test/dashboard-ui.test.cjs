const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toolSummary, stripAnsi, toolIcon } = require('../public/js/dashboard-ui');

test('dashboard event helpers preserve readable summaries and remove terminal controls', () => {
  assert.equal(toolSummary('Bash', JSON.stringify({ command: 'npm test', description: 'run tests' })), 'npm test');
  assert.equal(toolSummary('Read', 'plain text'), 'plain text');
  assert.equal(stripAnsi('\x1b[31mfailed\x1b[0m\rnext'), 'failednext');
  assert.equal(toolIcon('Read'), '📖');
});

test('dashboard presentation helpers load before the Vue app', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const helpers = html.indexOf('/js/dashboard-ui.js');
  const settings = html.indexOf('/js/dashboard-settings.js');
  const app = html.indexOf('/js/dashboard.js');
  assert.ok(helpers >= 0 && settings > helpers && app > settings);
});

test('result review follows report, changed files, Jev and delivery steps', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  // 分頁由 dashboard.js 的 resultTabs 產生：Jev 是選配模組，只在啟用時插在變更與交付之間，編號自動重排
  const js = fs.readFileSync(path.join(__dirname, '../public/js/dashboard.js'), 'utf8');
  const tabs = js.slice(js.indexOf('const resultTabs'), js.indexOf('const resultTabs') + 400);
  assert.ok(tabs.indexOf('成果報告') < tabs.indexOf('變更與紀錄'));
  assert.ok(tabs.indexOf('變更與紀錄') < tabs.indexOf('sys.modules.jev'));
  assert.ok(tabs.indexOf('Jev 小助手') < tabs.indexOf('交付'));
  assert.match(html, /v-for="item in resultTabs"/);
  assert.match(html, /git status --short/);
  assert.match(html, /runEngineerAction\('commit-now'\)/);
  assert.doesNotMatch(html, /查看程式碼差異/);
  assert.doesNotMatch(html, /遠端名稱/);
  assert.doesNotMatch(html, /產生成果報告/);
  assert.doesNotMatch(html, /<b>任務狀態<\/b>|<b>目前分支<\/b>|<b>交付方式<\/b>/);
});

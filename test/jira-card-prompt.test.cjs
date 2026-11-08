const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  ISSUE_TYPES, readPromptDoc, parsePromptDoc, describeIssueTypes, buildCardPrompt, parseCardDraft, mockCardDraft,
} = require('../src/server/integrations/jira-card-prompt');

const DOC = [
  '基礎指示：類型是「{{ISSUE_TYPES_PLACEHOLDER}}」',
  '',
  '{{TEMPLATE}}',
  '',
  '<input>',
  '{{INPUT}}',
  '</input>',
  '',
  '## 描述範本 · 任務',
  '',
  '```markdown',
  '## 需求描述',
  '```',
  '',
  '## 描述範本 · 錯誤',
  '',
  '```markdown',
  '## 問題描述',
  '```',
  '',
].join('\n').replace('{{ISSUE_TYPES_PLACEHOLDER}}', '{{ISSUE_TYPE}}');

test('隨附的提示樣板涵蓋所有議題類型', () => {
  const { base, templates } = parsePromptDoc(readPromptDoc());
  assert.ok(base.includes('{{INPUT}}'), '基礎指示必須帶 {{INPUT}} 佔位符');
  for (const type of ISSUE_TYPES) {
    assert.ok(templates[type] && templates[type].includes('##'), `缺少「${type}」的描述範本`);
  }
});

test('組提示時填入類型、範本與需求內容', () => {
  const prompt = buildCardPrompt({ doc: DOC, issueType: '錯誤', input: '登入頁按鈕會壞掉' });
  assert.match(prompt, /類型是「錯誤」/);
  assert.match(prompt, /## 問題描述/);
  assert.match(prompt, /登入頁按鈕會壞掉/);
  assert.doesNotMatch(prompt, /## 需求描述/, '不該混入其他類型的範本');
});

test('使用者輸入裡的 $& 不會被當成 replacement pattern 展開', () => {
  const prompt = buildCardPrompt({ doc: DOC, issueType: '任務', input: '金額顯示成 $& 與 $1' });
  assert.match(prompt, /金額顯示成 \$& 與 \$1/);
});

test('類型不合法或需求空白時拒絕生成', () => {
  assert.throws(() => buildCardPrompt({ doc: DOC, issueType: '史詩', input: 'x' }), /缺少「史詩」的描述範本/);
  assert.throws(() => buildCardPrompt({ doc: DOC, issueType: '任務', input: '   ' }), /請先輸入需求內容/);
  assert.throws(() => buildCardPrompt({ doc: DOC, issueType: '子任務', input: 'x' }), /缺少「子任務」的描述範本/);
});

test('解析 AI 回覆：純 JSON、含圍欄、含前後贅字都要吃得下', () => {
  const expected = { summary: '修復登入頁破版', description: '## 需求描述\n修好它' };
  const payload = JSON.stringify(expected);
  for (const raw of [payload, '```json\n' + payload + '\n```', '好的，這是結果：\n' + payload + '\n以上。']) {
    assert.deepEqual(parseCardDraft(raw), expected);
  }
});

test('解析 AI 回覆：缺欄位或格式不對就報錯，不放行空內容', () => {
  assert.throws(() => parseCardDraft(''), /沒有回傳任何內容/);
  assert.throws(() => parseCardDraft('抱歉我沒辦法'), /不是預期的 JSON 格式/);
  assert.throws(() => parseCardDraft('{"summary":"","description":"x"}'), /沒有生成摘要/);
  assert.throws(() => parseCardDraft('{"summary":"x","description":"  "}'), /沒有生成描述/);
  assert.throws(() => parseCardDraft(JSON.stringify({ summary: 'a'.repeat(256), description: 'x' })), /摘要超過/);
});

test('摘要的換行會被壓成單行（Jira 摘要是單行欄位）', () => {
  assert.equal(parseCardDraft('{"summary":"修復\\n登入頁","description":"x"}').summary, '修復 登入頁');
});

test('mock 草稿標明來源並保留範本骨架', () => {
  const draft = mockCardDraft({ doc: DOC, issueType: '任務', input: '做一個匯出功能\n第二行' });
  assert.match(draft.summary, /^【Mock】做一個匯出功能$/);
  assert.match(draft.description, /Mock 示範，非 AI 生成/);
  assert.match(draft.description, /## 需求描述/);
  assert.match(draft.description, /第二行/);
});

test('議題類型說明：取出用途、範例與章節，引言不會混進送給 AI 的範本', () => {
  const doc = DOC.replace('## 描述範本 · 錯誤\n', '## 描述範本 · 錯誤\n\n> 用途：壞掉的行為\n> 範例：例如白畫面\n');
  const info = describeIssueTypes(doc);
  assert.deepEqual(info['錯誤'], { label: '錯誤', purpose: '壞掉的行為', example: '例如白畫面', sections: ['問題描述'] });
  assert.deepEqual(info['任務'], { label: '任務', purpose: '', example: '', sections: ['需求描述'] });
  assert.doesNotMatch(buildCardPrompt({ doc, issueType: '錯誤', input: 'x' }), /用途：/);
});

test('隨附的提示樣板每個類型都有用途說明', () => {
  const info = describeIssueTypes(readPromptDoc());
  for (const type of ISSUE_TYPES) {
    assert.ok(info[type].purpose, `「${type}」缺少 > 用途：說明`);
    assert.ok(info[type].sections.length >= 3, `「${type}」章節太少`);
  }
});

test('顯示名稱只改畫面上的字，不寫就用類型本名', () => {
  const info = describeIssueTypes(readPromptDoc());
  assert.equal(info['任務'].label, '功能');
  assert.equal(info['錯誤'].label, '錯誤');
});

test('畫面上的章節標籤拿掉英文括號，中文說明（選填）保留', () => {
  const info = describeIssueTypes(readPromptDoc());
  assert.ok(info['任務'].sections.includes('🧩 需求描述'));
  assert.ok(info['錯誤'].sections.includes('💻 重現步驟'));
  assert.ok(info['錯誤'].sections.includes('🔧 修復建議（選填）'));
  assert.ok(info['任務'].sections.every((s) => !/[A-Za-z]/.test(s)));
  assert.match(parsePromptDoc(readPromptDoc()).templates['任務'], /需求描述（What）/, '送給 AI 的範本不受影響');
});

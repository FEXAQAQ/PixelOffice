const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeClaudeMessage,clip,blockText}=require('../src/server/integrations/claude-stream');

/**
 * thinking_tokens 是純進度計數器，每累積 50～200 個思考 token 就送一筆。
 * 實測一張單 1411 筆事件裡有 868 筆是它（62%）、佔 log.jsonl 三分之一，
 * 而且畫面上只會印出一整行原始 JSON，把真正的對話沖到捲不完。
 */
test('pure progress pings are dropped instead of printed as raw JSON', () => {
  const ping={type:'system',subtype:'thinking_tokens',estimated_tokens:3200,estimated_tokens_delta:100,session_id:'s',uuid:'u'};
  assert.deepEqual(normalizeClaudeMessage(ping),[],'不進對話，也不該寫進 log');
});

test('system messages that carry information are still kept', () => {
  const [init]=normalizeClaudeMessage({type:'system',subtype:'init',model:'claude-sonnet-4-5',session_id:'sess',tools:[1,2,3],cwd:'C:/proj'});
  assert.equal(init.subtype,'init');
  assert.equal(init.sessionId,'sess');
  assert.equal(init.toolCount,3);

  const [retry]=normalizeClaudeMessage({type:'system',subtype:'api_retry',attempt:2,max_retries:5,retry_delay_ms:400,error:'overloaded'});
  assert.equal(retry.attempt,2);
  assert.equal(retry.error,'overloaded');

  // 認不得的形狀仍要留下來 —— 寧可看到一行 JSON，也不要靜默吞掉
  const [unknown]=normalizeClaudeMessage({type:'system',subtype:'task_notification',status:'failed',summary:'Build the solution'});
  assert.equal(unknown.subtype,'task_notification');
  assert.match(unknown.text,/Build the solution/);
});

test('assistant content splits into text, thinking and tool events with oversized payloads clipped', () => {
  const events=normalizeClaudeMessage({type:'assistant',message:{content:[
    {type:'text',text:'開始處理'},
    {type:'thinking',thinking:'先讀設定檔'},
    {type:'tool_use',id:'t1',name:'Read',input:{file_path:'a.cs'}},
    {type:'tool_result',tool_use_id:'t1',is_error:false,content:[{text:'內容'}]},
  ]}});
  assert.deepEqual(events.map(e=>e.kind),['text','thinking','tool_use','tool_result']);
  assert.equal(events[2].name,'Read');
  assert.match(events[2].text,/a\.cs/);

  const huge='x'.repeat(30000);
  const [big]=normalizeClaudeMessage({type:'assistant',message:{content:[{type:'text',text:huge}]}});
  assert.equal(big.text.length,20000);
  assert.equal(big.truncated,10000);
});

test('unknown shapes fall through to raw and partial stream events are ignored', () => {
  assert.deepEqual(normalizeClaudeMessage({type:'stream_event',event:{}}),[]);
  assert.deepEqual(normalizeClaudeMessage(null),[]);
  const [raw]=normalizeClaudeMessage({type:'something_new',payload:1});
  assert.equal(raw.kind,'raw');
  assert.match(raw.text,/something_new/);
});

test('helpers', () => {
  assert.deepEqual(clip('abc',10),{text:'abc'});
  assert.deepEqual(clip('abcdef',3),{text:'abc',truncated:3});
  assert.equal(blockText([{text:'a'},{text:'b'}]),'ab');
  assert.equal(blockText('plain'),'plain');
  assert.equal(blockText(null),'');
});

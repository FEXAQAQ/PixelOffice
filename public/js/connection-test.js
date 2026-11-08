const $ = (id) => document.getElementById(id);
const socket = io();
let running = false;
let sessionId = null;
let canChat = false;   // 只有 real 模式 + 找到執行檔才能對話

// 按鈕狀態集中在一處，避免錯誤路徑把 mock 模式的 disabled 意外解開
function syncSend(){
  const b = $('send');
  b.disabled = !canChat || running;
  b.title = canChat ? '' : '目前不是 real 模式，或找不到 AI CLI 執行檔 —— 見上方診斷';
  $('stop').disabled = !running;
}

/* ---------- 診斷 ---------- */
function chk(state, key, val){
  const d = document.createElement('div');
  d.className = 'chk ' + (state || '');
  const icon = state === 'ok' ? '✔' : state === 'bad' ? '✖' : state === 'warn' ? '⚠' : '·';
  d.innerHTML = '<span class="i">' + icon + '</span><span class="k"></span><span class="v"></span>';
  d.querySelector('.k').textContent = key;
  d.querySelector('.v').textContent = val == null || val === '' ? '—' : String(val);
  return d;
}

async function loadDiag(){
  const box = $('checks'), pills = $('pills'), banner = $('banner');
  box.innerHTML = ''; pills.innerHTML = ''; banner.innerHTML = '';
  let d;
  try { d = await (await fetch('/api/diag')).json(); }
  catch (e) {
    box.appendChild(chk('bad', '讀取診斷失敗', e.message));
    return;
  }
  const c = d.ai || d.claude, e = d.env;
  const platform=c.provider==='codex'?'Codex':'Claude Code';
  const prefix=c.provider==='codex'?'CODEX':'CLAUDE';
  const realMode = c.mode === 'real';

  // 頂列 pill
  const pill = (cls, text) => {
    const s = document.createElement('span');
    s.className = 'pill ' + cls;
    s.innerHTML = '<span class="dot"></span>';
    s.appendChild(document.createTextNode(text));
    return s;
  };
  pills.appendChild(pill(c.found ? 'ok' : 'bad', c.found ? 'CLI 找到' : 'CLI 找不到'));
  pills.appendChild(pill(realMode ? 'ok' : 'warn', 'MODE ' + c.mode));
  pills.appendChild(pill(c.version && c.version.ok ? 'ok' : 'bad', c.version && c.version.ok ? '可執行' : '無法執行'));

  if (!c.found){
    banner.innerHTML = '<div class="banner bad">✖ 這台機器上找不到 <code>' + c.bin + '</code>。'
      + '請先安裝並登入 ' + platform + '，或用 <code>' + prefix + '_BIN</code> 指定執行檔的絕對路徑。'
      + '在這之前對話功能不會有作用。</div>';
  } else if (!realMode){
    banner.innerHTML = '<div class="banner warn">⚠ 目前 <code>' + prefix + '_MODE=' + c.mode + '</code>，對話功能會被拒絕。'
      + '找到執行檔了，把 <code>.env</code> 的 <code>' + prefix + '_MODE</code> 設成 <code>real</code>'
      + '（或維持 <code>auto</code>，它偵測到執行檔就會自己用 real）後重啟伺服器。</div>';
  }

  box.appendChild(chk('', 'AI 平台', platform));
  box.appendChild(chk(c.found ? 'ok' : 'bad', 'CLI 執行檔', c.resolvedPath || ('找不到（' + c.bin + '）')));
  box.appendChild(chk(
    c.version && c.version.ok ? 'ok' : 'bad',
    'CLI 版本',
    c.version && c.version.ok ? c.version.version : (c.version && c.version.error) || '未執行'));
  box.appendChild(chk(realMode ? 'ok' : 'warn', '執行模式',
    c.mode + '（.env 設定為 ' + c.modeConfigured + '）'));
  box.appendChild(chk('', '需要經過 shell', c.needsShell ? '是（.cmd/.bat 只能走 shell）' : '否（直接 spawn）'));
  if(c.provider==='codex')box.appendChild(chk('', '登入方式', '使用本機 Codex CLI 的登入與設定'));
  else {
    box.appendChild(chk(e.hasAnthropicApiKey ? 'ok' : '', 'ANTHROPIC_API_KEY',
      e.hasAnthropicApiKey ? '有設定（模型清單可撈真實資料）' : '沒設定（模型清單只有別名，不影響對話）'));
    box.appendChild(chk(e.apiKeyPassedToClaude ? 'warn' : 'ok', 'claude 的驗證方式',
      e.apiKeyPassedToClaude
        ? 'CLAUDE_USE_API_KEY=true —— API key 會傳給 claude（走 API 計費）'
        : '用 claude 自己的登入（API key 不會傳進去，不影響你的訂閱）'));
  }
  box.appendChild(chk('', 'Node / 平台', e.node + ' / ' + e.platform));
  box.appendChild(chk('', '綁定位址', e.host + ':' + e.port));
  box.appendChild(chk('', 'Jira 模式', e.jiraMode));
  box.appendChild(chk('', '對話沙箱目錄', d.chat.cwd));
  try{
    const j=await (await fetch('/api/jev/diag')).json();
    // Jev 是選配模組，沒啟用就整塊不顯示
    $('jev-test-box').style.display=j.enabled?'':'none';
    if(j.enabled)box.appendChild(chk(j.configured?'ok':'warn','Jev API',j.configured?'已設定 TYPESAFE_API_KEY；按下方按鈕會呼叫真實 API':j.mode==='mock'?'未設定金鑰；按下方按鈕會顯示 Mock 示範':'未設定 TYPESAFE_API_KEY'));
  }catch(error){box.appendChild(chk('bad','Jev API','診斷失敗：'+error.message));}

  sessionId = d.chat.sessionId;
  updateSess();
  canChat = realMode && c.found;
  syncSend();
}

/* ---------- 對話渲染 ---------- */
const conv = $('conv');
function clearEmpty(){ const e = conv.querySelector('.empty'); if (e) e.remove(); }
function atBottom(){ return conv.scrollHeight - conv.scrollTop - conv.clientHeight < 40; }
function add(el){
  const stick = atBottom();
  clearEmpty();
  conv.appendChild(el);
  if (stick) conv.scrollTop = conv.scrollHeight;
}
function row(cls, text){
  const d = document.createElement('div');
  d.className = 'ev ' + cls;
  d.textContent = text;
  return d;
}
const TOOL_ICONS = { Read:'📖', Write:'✍', Edit:'✎', Bash:'▶', Glob:'🔍', Grep:'🔍',
                     WebSearch:'🌐', WebFetch:'🌐', Task:'🤖', TodoWrite:'☑' };
function toolSummary(raw){
  try {
    const i = JSON.parse(raw);
    for (const f of ['file_path','command','pattern','path','description','url','query'])
      if (typeof i[f] === 'string' && i[f].trim()) return i[f].trim();
    return Object.keys(i).map(k => k + '=' + String(i[k]).slice(0,40)).join(' ');
  } catch (_) { return String(raw || ''); }
}

socket.on('chat:event', (ev) => {
  if (ev.kind === 'you')            add(row('you', ev.text));
  else if (ev.kind === 'reset')     add(row('divider', '新的對話'));
  else if (ev.kind === 'launch'){
    const bits = [ev.bin, (ev.args||[]).join(' ')].join(' ');
    add(row('sys', '$ ' + bits + (ev.resumeFrom ? '   (接續 session)' : '')));
  }
  else if (ev.kind === 'system'){
    if (ev.subtype === 'init'){
      const d = document.createElement('div');
      d.className = 'ev sys';
      d.innerHTML = '<b>AI 已啟動</b> ';
      d.appendChild(document.createTextNode(
        (ev.model || '') + (ev.toolCount ? ' · ' + ev.toolCount + ' 個工具' : '')));
      add(d);
    } else if (ev.subtype === 'api_retry'){
      add(row('sys', 'API 重試 ' + ev.attempt + '/' + ev.maxRetries + ' · ' + (ev.error||'')));
    } else add(row('sys', ev.text || ev.subtype || ''));
  }
  else if (ev.kind === 'thinking')  add(row('think', '💭 ' + ev.text));
  else if (ev.kind === 'text')      add(row('say', ev.text));
  else if (ev.kind === 'tool_use'){
    const d = document.createElement('div');
    d.className = 'ev tool';
    d.innerHTML = '<span>' + (TOOL_ICONS[ev.name] || '🔧') + '</span><span class="tn"></span><span class="ta"></span>';
    d.querySelector('.tn').textContent = ev.name;
    d.querySelector('.ta').textContent = toolSummary(ev.text);
    add(d);
  }
  else if (ev.kind === 'tool_result') add(row('tres' + (ev.isError ? ' err' : ''), ev.text || '(沒有輸出)'));
  else if (ev.kind === 'result'){
    const parts = [ev.isError ? '✖ 結束（有錯誤）' : '✔ 完成'];
    if (ev.numTurns) parts.push(ev.numTurns + ' 輪');
    if (ev.durationMs) parts.push((ev.durationMs/1000).toFixed(1) + 's');
    if (ev.costUsd != null) parts.push('$' + ev.costUsd.toFixed(4));
    add(row('res' + (ev.isError ? ' bad' : ''), parts.join('   ')));
  }
  else if (ev.kind === 'exit'){
    running = false;
    if (ev.sessionId) sessionId = ev.sessionId;
    updateSess();
    syncSend();
    add(row('sys', '程序結束，回傳碼 ' + ev.code));
  }
  else add(row('raw ' + (ev.stream || ''), ev.text || ''));
});

function updateSess(){
  $('sessinfo').textContent = sessionId
    ? 'session ' + String(sessionId).slice(0, 8) + '… · 下一句會接續'
    : '尚無 session · 下一句是新對話';
}

/* ---------- 動作 ---------- */
async function send(){
  const text = $('msg').value.trim();
  if (!text || running) return;
  running = true;
  syncSend();
  try{
    const r = await fetch('/api/chat', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message: text, model: $('model').value.trim() }),
    });
    const d = await r.json();
    if (!r.ok){
      running = false; syncSend();
      add(row('raw stderr', d.error || '送出失敗'));
      return;
    }
    $('msg').value = '';
  }catch(e){
    running = false; syncSend();
    add(row('raw stderr', '送出失敗：' + e.message));
  }
}

$('send').onclick = send;
$('msg').addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter'){ e.preventDefault(); send(); }
});
$('stop').onclick = async () => {
  try { await fetch('/api/chat/stop', { method:'POST' }); } catch(_){}
};
$('reset').onclick = async () => {
  try { await fetch('/api/chat/reset', { method:'POST' }); sessionId = null; updateSess(); } catch(_){}
};
$('redetect').onclick = loadDiag;
$('jev-test').onclick = async()=>{
  const button=$('jev-test'),result=$('jev-test-result');
  button.disabled=true;button.textContent='測試中…';result.className='jev-test-result';result.textContent='正在檢查 Jev 回應…';
  try{
    const response=await fetch('/api/jev/test',{method:'POST'}),data=await response.json();
    if(!response.ok)throw Error(data.error||'測試失敗');
    result.classList.add(data.mock?'warn':'ok');
    result.textContent=data.mock?data.message:`連線成功 · ${data.model}`;
  }catch(error){result.classList.add('bad');result.textContent='連線失敗：'+error.message;}
  finally{button.disabled=false;button.textContent='重新測試 Jev';}
};

/* ---------- 模型清單 ---------- */
(async () => {
  try{
    const d = await (await fetch('/api/models')).json();
    const dl = $('modelopts');
    const seen = new Set();
    const add2 = (v, label) => {
      if (!v || seen.has(v)) return; seen.add(v);
      const o = document.createElement('option');
      o.value = v; o.textContent = label || v; dl.appendChild(o);
    };
    for (const a of d.aliases || []) add2(a.value, a.label + (a.hint ? ' — ' + a.hint : ''));
    for (const m of d.models || []) add2(m.id, m.displayName);
    for (const id of d.seen || []) add2(id, id + '（跑過）');
  }catch(_){}
})();

loadDiag();

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// 連線測試使用獨立暫存目錄，不寫工單，也不佔用專案鎖。
function installConnectionRoutes(app, deps) {
  const { io, aiSettings, aiMode, resolveBin, needsShell, shellQuote, claudeEnv,
    runCodex, codexOptions, killTree, makeLineReader, clip, normalizeClaudeMessage,
    CLAUDE_BIN, CODEX_BIN, CLAUDE_NEEDS_SHELL, CLAUDE_USE_API_KEY, runtimeSettings,
    HOST, PORT, jiraMode } = deps;
  const CHAT_CWD = path.join(os.tmpdir(), 'rpg-dashboard-chat');

  // 連線測試一次只執行一段對話。
  const chat = { proc: null, sessionId: null, seq: 0, running: false };

  function chatEmit(ev) {
    chat.seq += 1;
    io.emit('chat:event', { seq: chat.seq, ts: Date.now(), ...ev });
  }

  function cliVersion(bin=CLAUDE_BIN) {
    return new Promise((resolve) => {
      const useShell = needsShell(bin);
      let p;
      try {
        p = spawn(useShell ? shellQuote(bin) : bin, ['--version'],
          { shell: useShell, timeout: 15000, windowsHide:true });
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('error', (e) => resolve({ ok: false, error: e.message }));
      p.on('close', (code) => resolve({
        ok: code === 0,
        code,
        version: out.trim() || null,
        error: code === 0 ? null : (err.trim() || `回傳碼 ${code}`),
      }));
    });
  }

  app.get('/api/diag', async (req, res) => {
    const provider=aiSettings.get(),bin=provider==='codex'?CODEX_BIN:CLAUDE_BIN;
    const resolved = resolveBin(bin);
    const ver = resolved ? await cliVersion(resolved) : { ok: false, error: '找不到執行檔' };
    const ai={provider,bin,resolvedPath:resolved,found:!!resolved,needsShell:needsShell(bin),mode:aiMode(provider),modeConfigured:runtimeSettings.get('mode'),version:ver};
    const claudeResolved=provider==='claude'?resolved:resolveBin(CLAUDE_BIN);
    const claudeVer=provider==='claude'?ver:claudeResolved?await cliVersion(claudeResolved):{ok:false,error:'找不到執行檔'};
    res.json({
      ai,
      claude: {
        bin: CLAUDE_BIN,
        resolvedPath: claudeResolved,
        found: !!claudeResolved,
        needsShell: CLAUDE_NEEDS_SHELL,
        mode: aiMode('claude'),
        modeConfigured: runtimeSettings.get('mode'),
        version: claudeVer,
      },
      env: {
        node: process.version,
        platform: process.platform,
        hasAnthropicApiKey: !!process.env.ANTHROPIC_API_KEY,
        apiKeyPassedToClaude: CLAUDE_USE_API_KEY,
        host: HOST,
        port: PORT,
        jiraMode: jiraMode(),
      },
      chat: { cwd: CHAT_CWD, sessionId: chat.provider===provider ? chat.sessionId : null, running: chat.running },
    });
  });

  // 連線測試對話：{ message, model?, newSession? }
  app.post('/api/chat', (req, res) => {
    const { message, model, newSession } = req.body || {};
    const text = String(message || '').trim();
    if (!text) return res.status(400).json({ error: '請輸入內容' });
    if (chat.running) return res.status(409).json({ error: '上一句還在跑，請等它結束或按停止' });
    const provider=aiSettings.get();
    if (aiMode(provider) !== 'real') {
      return res.status(400).json({
        error: `目前 ${provider.toUpperCase()}_MODE=${aiMode(provider)}，連線測試需要已安裝並登入該平台 CLI 的 real 模式。`,
      });
    }
    if (newSession || chat.provider!==provider) chat.sessionId = null;
    chat.provider=provider;

    try { fs.mkdirSync(CHAT_CWD, { recursive: true }); } catch (_) {}

    if(provider==='codex') {
      chat.running=true;
      chatEmit({kind:'you',text});
      chatEmit({kind:'launch',provider,bin:CODEX_BIN,args:['app-server'],cwd:CHAT_CWD,resumeFrom:chat.sessionId});
      try {
        runCodex({...codexOptions(CHAT_CWD),prompt:text,model:String(model || '').trim(),resumeFrom:chat.sessionId,readOnly:true,
          onProcess:proc=>{chat.proc=proc;},
          emit:ev=>{if(ev.sessionId)chat.sessionId=ev.sessionId;chatEmit({...ev,provider});},
          done:()=>{chat.running=false;chat.proc=null;}});
        return res.json({ok:true,sessionId:chat.sessionId});
      }catch(error){chat.running=false;chat.proc=null;return res.status(500).json({error:error.message});}
    }

    // argv 全是固定字面值或受控值；使用者輸入一律走 stdin
    const promptArg = '回答 stdin 傳入的問題。這是連線測試，請簡短回覆。';
    const args = [
      '-p',
      CLAUDE_NEEDS_SHELL ? `"${promptArg}"` : promptArg,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'dontAsk',      // 不給它動手的權限，也不會卡在詢問
    ];
    const m = String(model || '').trim();
    if (m && /^[A-Za-z0-9._@-]+$/.test(m)) args.push('--model', m);
    if (chat.sessionId) args.push('--resume', chat.sessionId);

    chat.running = true;
    chatEmit({ kind: 'you', text });
    chatEmit({
      kind: 'launch', cwd: CHAT_CWD, bin: CLAUDE_BIN,
      args: args.map((a) => a.replace(/^"|"$/g, '')),
      resumeFrom: chat.sessionId, model: m || null,
    });

    let proc;
    try {
      proc = spawn(CLAUDE_NEEDS_SHELL ? shellQuote(CLAUDE_BIN) : CLAUDE_BIN, args,
        { cwd: CHAT_CWD, env: claudeEnv(), shell: CLAUDE_NEEDS_SHELL });
    } catch (err) {
      chat.running = false;
      chatEmit({ kind: 'raw', stream: 'stderr', text: `啟動失敗：${err.message}` });
      return res.status(500).json({ error: `啟動失敗：${err.message}` });
    }
    chat.proc = proc;

    const feed = makeLineReader((line) => {
      let msg;
      try { msg = JSON.parse(line); }
      catch (_) { return chatEmit({ kind: 'raw', stream: 'stdout', ...clip(line, 4000) }); }
      for (const ev of normalizeClaudeMessage(msg)) {
        if (ev.sessionId) chat.sessionId = ev.sessionId;   // 下一句就能接續
        chatEmit(ev);
      }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.write(text);
    proc.stdin.end();
    proc.stdout.on('data', (d) => feed(d.toString()));
    proc.stderr.on('data', (d) => chatEmit({ kind: 'raw', stream: 'stderr', ...clip(d.toString(), 4000) }));
    proc.on('error', (err) => {
      chat.running = false; chat.proc = null;
      chatEmit({ kind: 'raw', stream: 'stderr', text: `執行錯誤：${err.message}` });
    });
    proc.on('close', (code) => {
      chat.running = false; chat.proc = null;
      chatEmit({ kind: 'exit', code, sessionId: chat.sessionId });
    });

    res.json({ ok: true, sessionId: chat.sessionId, resumed: !!chat.sessionId });
  });

  app.post('/api/chat/stop', (req, res) => {
    if (!chat.proc) return res.status(400).json({ error: '目前沒有在跑' });
    killTree(chat.proc);
    chatEmit({ kind: 'raw', stream: 'stderr', text: '已送出停止指令' });
    res.json({ ok: true });
  });

  app.post('/api/chat/reset', (req, res) => {
    chat.sessionId = null;
    chatEmit({ kind: 'reset' });
    res.json({ ok: true });
  });
}

module.exports = { installConnectionRoutes };

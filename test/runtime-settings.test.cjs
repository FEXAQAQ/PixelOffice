const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeSettings } = require('../src/server/runtime-settings');

test('runtime settings fall back to env, persist only overrides and reject invalid values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixeloffice-runtime-'));
  const file = path.join(dir, 'runtime.json');
  try {
    // env 提供開機預設值；沒設定或值不合法時退回各項目的保底值
    const settings = createRuntimeSettings(file, { mode: 'mock', accessMode: 'auto', jiraBoardId: '77' });
    assert.deepEqual(settings.all(), { mode: 'mock', accessMode: 'auto', jiraBoardId: '77', jev: 'off' });
    assert.deepEqual(settings.overridden(), { mode: false, accessMode: false, jiraBoardId: false, jev: false });
    assert.equal(fs.existsSync(file), false, '沒人改過設定就不該產生檔案');

    settings.set('mode', 'real');
    settings.set('jiraBoardId', '123');
    assert.equal(settings.get('jiraBoardId'), '123');

    // 只有被覆寫的項目會落地，其餘仍由 env 決定
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'real', jiraBoardId: '123' });

    // 換一組 env 重新載入：覆寫留著，未覆寫的跟著新的 env 走
    const reloaded = createRuntimeSettings(file, { mode: 'mock', accessMode: 'auto', jiraBoardId: '77' });
    assert.deepEqual(reloaded.all(), { mode: 'real', accessMode: 'auto', jiraBoardId: '123', jev: 'off' });
    assert.equal(reloaded.defaults().jiraBoardId, '77');

    // 看板 ID 只收數字；清空是合法的（等同未設定）
    reloaded.set('jiraBoardId', '');
    assert.equal(reloaded.get('jiraBoardId'), '');
    assert.throws(() => reloaded.set('jiraBoardId', 'abc'), /數字/);
    assert.throws(() => reloaded.set('jiraBoardId', '12a'), /數字/);

    assert.throws(() => reloaded.set('mode', 'auto'), /mock \/ real/);
    assert.throws(() => reloaded.set('unknown', 'mock'), /未知的設定項目/);
    // 被拒絕的寫入不能污染既有設定
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { mode: 'real', jiraBoardId: '' });

    // 設定檔內容壞掉時忽略不合法的鍵，而不是整個爆掉
    fs.writeFileSync(file, JSON.stringify({ mode: 'banana', jiraBoardId: 99 }));
    assert.deepEqual(createRuntimeSettings(file, { mode: 'real', accessMode: 'auto', jiraBoardId: '5' }).all(),
      { mode: 'real', accessMode: 'auto', jiraBoardId: '5', jev: 'off' });

    // 舊版 Jira MCP 設定會自動遷移為全域 real。
    fs.writeFileSync(file, JSON.stringify({ claude: 'auto', codex: 'auto', jira: 'mcp', jiraBoardId: '197' }));
    assert.deepEqual(createRuntimeSettings(file, { mode: 'mock', accessMode: 'auto', jiraBoardId: '' }).all(),
      { mode: 'real', accessMode: 'auto', jiraBoardId: '197', jev: 'off' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

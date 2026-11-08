const path = require('path');
const { normalizeLook, validateRoles } = require('../../../public/js/office-roles');

function installSettingsRoutes(app, {
  loadProjects, saveProjects, loadEngineers, saveEngineers,
  engineersView, engineerState, lockedPaths, io, pushLocks, pmSay, pushEngineers,
  loadRoles, saveRoles, pushRoles,
}) {
  app.get('/api/roles', (req, res) => res.json({ roles: loadRoles() }));

  app.put('/api/roles', (req, res) => {
    const roles = req.body && req.body.roles;
    const error = roles === undefined ? '格式錯誤' : validateRoles(roles);
    if (error) return res.status(400).json({ error });
    try {
      const saved = saveRoles(roles);
      pushRoles();
      res.json({ ok: true, roles: saved });
    } catch (err) {
      res.status(500).json({ error: `寫入 roles.json 失敗：${err.message}` });
    }
  });

  app.get('/api/engineers', (req, res) => res.json(engineersView()));

  app.get('/api/projects', (req, res) => res.json(loadProjects()));

  let idSeq = 0;
  function newId(prefix) {
    idSeq += 1;
    return `${prefix}_${Date.now().toString(36)}${idSeq}`;
  }

  app.put('/api/projects', (req, res) => {
    const incoming = (req.body && req.body.projects) || [];
    if (!Array.isArray(incoming)) return res.status(400).json({ error: '格式錯誤' });

    // 驗證
    for (const p of incoming) {
      if (!String(p.name || '').trim()) return res.status(400).json({ error: '每個專案都必須有名稱' });
      if (!String(p.path || '').trim()) return res.status(400).json({ error: `「${p.name}」缺少專案路徑` });
    }
    // 執行中的專案不可被刪除（否則鎖與 log 會對不上）
    const busy = lockedPaths();
    const keptPaths = new Set(incoming.map((p) => path.resolve(String(p.path || ''))));
    for (const [bp, info] of Object.entries(busy)) {
      if (!keptPaths.has(bp)) {
        return res.status(400).json({
          error: `專案路徑 ${bp} 正由 ${info.engineerName} 執行 ${info.taskKey}，無法刪除或修改其路徑`,
        });
      }
    }

    try {
      const saved = saveProjects(incoming.map((p) => ({ ...p, id: p.id || newId('p') })));
      io.emit('projects:update', { projects: saved });
      pushLocks();
      pmSay(`專案設定已更新（共 ${saved.length} 個專案）`, 'success');
      res.json({ ok: true, projects: saved });
    } catch (err) {
      res.status(500).json({ error: `寫入 projects.json 失敗：${err.message}` });
    }
  });

  // 只改一位工程師的外觀；look 為 null 時清除自訂，回到自動產生的外觀。
  app.put('/api/engineers/:id/look', (req, res) => {
    const look = req.body ? req.body.look : undefined;
    if (look !== null && !normalizeLook(look)) return res.status(400).json({ error: '外觀設定不正確' });
    const list = loadEngineers();
    if (!list.some((e) => e.id === req.params.id)) return res.status(404).json({ error: '找不到這位工程師' });
    try {
      saveEngineers(list.map((e) => (e.id === req.params.id ? { ...e, look } : e)));
      pushEngineers();
      res.json({ ok: true, look: normalizeLook(look) });
    } catch (err) {
      res.status(500).json({ error: `寫入 engineers.json 失敗：${err.message}` });
    }
  });

  app.put('/api/engineers', (req, res) => {
    const incoming = (req.body && req.body.engineers) || [];
    if (!Array.isArray(incoming)) return res.status(400).json({ error: '格式錯誤' });
    if (!incoming.length) return res.status(400).json({ error: '至少要有一位工程師' });
    if (incoming.length > 6) return res.status(400).json({error:'工程師最多 6 位'});
    for (const e of incoming) {
      if (!String(e.name || '').trim()) return res.status(400).json({ error: '每位工程師都必須有名稱' });
    }

    // 執行中的工程師不可刪除
    const keptIds = new Set(incoming.map((e) => e.id).filter(Boolean));
    for (const [id, st] of Object.entries(engineerState)) {
      if (st.status === 'working' && !keptIds.has(id)) {
        const cur = loadEngineers().find((x) => x.id === id);
        return res.status(400).json({
          error: `${cur ? cur.name : id} 正在執行 ${st.task ? st.task.key : '任務'}，無法刪除`,
        });
      }
    }

    try {
      const saved = saveEngineers(incoming.map((e) => ({ ...e, id: e.id || newId('e') })));
      // 清掉已被移除的工程師的執行期狀態
      for (const id of Object.keys(engineerState)) {
        if (!saved.find((e) => e.id === id)) delete engineerState[id];
      }
      pushEngineers();
      pmSay(`工程師名單已更新（共 ${saved.length} 位）`, 'success');
      res.json({ ok: true, engineers: saved });
    } catch (err) {
      res.status(500).json({ error: `寫入 engineers.json 失敗：${err.message}` });
    }
  });

}

module.exports = { installSettingsRoutes };

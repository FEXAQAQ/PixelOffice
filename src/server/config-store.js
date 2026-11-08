const fs = require('fs');
const { normalizeAutomation } = require('./workflow/config');
const { normalizeLook, cleanRoles } = require('../../public/js/office-roles');

const DEFAULT_ENGINEERS = [
  { id: 'devA', name: 'Dev A' },
  { id: 'devB', name: 'Dev B' },
  { id: 'devC', name: 'Dev C' },
];

function createConfigStore({ projectsFile, engineersFile, rolesFile }) {
  function loadProjects() {
    try {
      const cfg = JSON.parse(fs.readFileSync(projectsFile, 'utf8'));
      return { projects: Array.isArray(cfg.projects) ? cfg.projects : [] };
    } catch (err) {
      // 沒有這個檔是正常的（新環境還沒設定過任何專案），只有內容壞掉才值得提醒。
      if (err.code !== 'ENOENT') console.warn(`[warn] 無法讀取 ${projectsFile}：${err.message}`);
      return { projects: [] };
    }
  }

  function saveProjects(projects) {
    const clean = projects.map((p) => ({
      id: p.id,
      name: String(p.name || '').trim(),
      path: String(p.path || '').trim(),
      type: String(p.type || '').trim(),
      automation: normalizeAutomation(p.automation),
    }));
    fs.writeFileSync(projectsFile, JSON.stringify({
      _comment: '專案路徑與自動開發設定，可從畫面上的「設定」修改。',
      projects: clean,
    }, null, 2), 'utf8');
    return clean;
  }

  function resolveProject(projectId) {
    return loadProjects().projects.find((project) => project.id === projectId) || null;
  }

  function loadEngineers() {
    try {
      const cfg = JSON.parse(fs.readFileSync(engineersFile, 'utf8'));
      const list = Array.isArray(cfg.engineers) ? cfg.engineers : [];
      return list.filter((engineer) => engineer && engineer.id).map((engineer) => ({
        id: engineer.id,
        name: String(engineer.name || engineer.id),
        model: String(engineer.model || '').trim(),
        codexModel: String(engineer.codexModel || '').trim(),
        ...(normalizeLook(engineer.look) ? { look: normalizeLook(engineer.look) } : {}),
      }));
    } catch (_) {
      try { saveEngineers(DEFAULT_ENGINEERS); } catch (_) {}
      return DEFAULT_ENGINEERS.slice();
    }
  }

  function saveEngineers(list) {
    // 設定畫面不帶外觀；沒送 look 時沿用檔案裡原本的，避免存名單就把自訂外觀洗掉。
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(engineersFile, 'utf8')).engineers || []; } catch (_) {}
    const clean = list.filter((engineer) => engineer && engineer.id).map((engineer) => {
      const look = normalizeLook(engineer.look !== undefined ? engineer.look : (saved.find((e) => e && e.id === engineer.id) || {}).look);
      return {
        id: engineer.id,
        name: String(engineer.name || '').trim() || engineer.id,
        model: String(engineer.model || '').trim(),
        codexModel: String(engineer.codexModel || '').trim(),
        ...(look ? { look } : {}),
      };
    });
    fs.writeFileSync(engineersFile, JSON.stringify({
      _comment: '工程師名單；model / codexModel 留空時使用對應 CLI 的預設模型；look 可自訂外觀（skin 0–5、hair 0–7、outfit 5/6、accessory ""/"tie"），省略則自動產生。',
      engineers: clean,
    }, null, 2), 'utf8');
    return clean;
  }

  // PM / BOSS 的自訂名稱與外觀；沒有檔案代表全部用預設（office-roles.js 的 ROLES）。
  function loadRoles() {
    try {
      return cleanRoles(JSON.parse(fs.readFileSync(rolesFile, 'utf8')).roles);
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[warn] 無法讀取 ${rolesFile}：${err.message}`);
      return {};
    }
  }

  function saveRoles(roles) {
    const clean = cleanRoles(roles);
    fs.writeFileSync(rolesFile, JSON.stringify({
      _comment: 'PM／BOSS 的名稱與外觀，可從「編輯辦公室」修改；省略的欄位使用預設。',
      roles: clean,
    }, null, 2), 'utf8');
    return clean;
  }

  return { loadProjects, saveProjects, resolveProject, loadEngineers, saveEngineers, loadRoles, saveRoles };
}

module.exports = { createConfigStore };

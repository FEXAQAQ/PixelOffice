const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../public/js/office-roles');
const E = require('../public/js/office-engine');
const { createConfigStore } = require('../src/server/config-store');
const { installSettingsRoutes } = require('../src/server/features/settings-routes');
const ids = ['dev0', 'dev1', 'dev2'];
const plain = {hairColor: '', accessories: []};

function tempStore(engineers = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-'));
  const engineersFile = path.join(dir, 'engineers.json');
  fs.writeFileSync(engineersFile, JSON.stringify({engineers}));
  const store = createConfigStore({projectsFile: path.join(dir, 'p.json'), engineersFile, rolesFile: path.join(dir, 'roles.json')});
  return {dir, store, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}
/** Mounts the settings routes on a fake app and returns a caller for one route. */
function routes(store, pushes) {
  const handlers = {}, app = new Proxy({}, {get: (_, method) => (route, handler) => { handlers[method + ' ' + route] = handler; }});
  installSettingsRoutes(app, {...store, engineersView() {}, engineerState: {}, lockedPaths() {}, io: {}, pushLocks() {}, pmSay() {},
    pushEngineers() { pushes.engineers++; }, pushRoles() { pushes.roles++; }});
  return (route, req) => {
    const res = {code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }};
    handlers[route]({params: {}, ...req}, res); return res;
  };
}

test('default role looks match the previously hard-coded PM and BOSS sprites', () => {
  assert.deepEqual(R.roleLook(null, 'pm'), {...E.appearance(0, true), ...plain});
  assert.deepEqual(R.roleLook(null, 'boss'), {...E.appearance(7), hairColor: '', accessories: ['tie']});
});
test('role names and looks fall back to defaults and accept overrides', () => {
  const roles = {pm: {name: '  小美 '}, boss: {look: {skin: 3, hair: 2, outfit: 5}}};
  assert.equal(R.roleName(roles, 'pm'), '小美');
  assert.equal(R.roleName(roles, 'boss'), 'BOSS');
  assert.equal(R.roleName({pm: {name: '   '}}, 'pm'), 'PM');
  assert.equal(R.roleName(undefined, 'pm'), 'PM');
  assert.deepEqual(R.roleLook(roles, 'boss'), {skin: 3, hair: 2, outfit: 5, ...plain});
  assert.deepEqual(R.roleLook({boss: {look: {skin: 9, hair: 0, outfit: 5}}}, 'boss'), R.ROLES.boss.look);
  const look = R.roleLook(null, 'boss'); look.accessories.push('glasses');
  assert.deepEqual(R.ROLES.boss.look.accessories, ['tie'], 'callers get a copy of the default look');
});
test('normalizeLook rejects bad values and upgrades the single-accessory format', () => {
  assert.equal(R.normalizeLook({skin: 6, hair: 0, outfit: 5}), null);
  assert.equal(R.normalizeLook({skin: 0, hair: 8, outfit: 5}), null);
  assert.equal(R.normalizeLook({skin: 0, hair: 0, outfit: 1}), null);
  assert.equal(R.normalizeLook({skin: 0, hair: 0, outfit: 5, accessories: ['hat']}), null);
  assert.equal(R.normalizeLook({skin: 0, hair: 0, outfit: 5, hairColor: 'plaid'}), null);
  assert.equal(R.normalizeLook({skin: 0, hair: 0, outfit: 5, accessories: ['toString']}), null);
  assert.equal(R.normalizeLook('x'), null);
  assert.deepEqual(R.normalizeLook({skin: 1, hair: 7, outfit: 6, accessory: 'tie'}).accessories, ['tie']);
  assert.deepEqual(R.normalizeLook({skin: 1, hair: 7, outfit: 6, accessory: ''}).accessories, []);
  assert.deepEqual(R.normalizeLook({skin: 0, hair: 0, outfit: 5, hairColor: 'pink', accessories: ['headphones', 'tie', 'tie']}),
    {skin: 0, hair: 0, outfit: 5, hairColor: 'pink', accessories: ['tie', 'headphones']}, 'deduplicated, in registry order');
});
test('validateRoles and cleanRoles', () => {
  assert.equal(R.validateRoles({pm: {name: '小美'}, boss: {name: '老闆', look: {skin: 1, hair: 1, outfit: 6, accessories: ['tie']}}}), '');
  assert.match(R.validateRoles({pm: {name: 'x'.repeat(R.NAME_MAX + 1)}}), /PM 名稱最多/);
  assert.match(R.validateRoles({pm: {look: {skin: 0}}}), /PM 外觀/);
  assert.match(R.validateRoles({qa: {name: 'QA'}}), /角色設定/);
  assert.match(R.validateRoles([]), /角色設定/);
  assert.deepEqual(R.cleanRoles({pm: {name: ' PM '}, boss: {name: ' 老闆 ', look: {skin: 2, hair: 3, outfit: 5, accessory: 'tie'}}}),
    {boss: {name: '老闆', look: {skin: 2, hair: 3, outfit: 5, hairColor: '', accessories: ['tie']}}});
  assert.deepEqual(R.cleanRoles(undefined), {});
});
test('engineer look survives a settings save that does not send it', () => {
  const {store, cleanup} = tempStore([{id: 'devA', name: 'A', look: {skin: 2, hair: 3, outfit: 6}}, {id: 'devB', name: 'B', look: {skin: 99}}]);
  assert.deepEqual(store.loadEngineers()[0].look, {skin: 2, hair: 3, outfit: 6, ...plain});
  assert.equal(store.loadEngineers()[1].look, undefined);
  store.saveEngineers([{id: 'devA', name: 'A2'}, {id: 'devB', name: 'B'}]);
  assert.deepEqual(store.loadEngineers()[0], {id: 'devA', name: 'A2', model: '', codexModel: '', look: {skin: 2, hair: 3, outfit: 6, ...plain}});
  cleanup();
});
test('rolePosition follows the desk, uses the fallback seat, or is absent', () => {
  const layout = E.defaultLayout(ids);
  const pmDesk = layout.furniture.find(f => f.type === 'pmdesk');
  assert.deepEqual(E.rolePosition(layout, 'pm'), {x: pmDesk.x + 1, y: pmDesk.y - 1});
  const bare = {...layout, furniture: layout.furniture.filter(f => !['pmdesk', 'bossdesk'].includes(f.type))};
  assert.deepEqual(E.rolePosition(bare, 'pm'), R.ROLES.pm.fallbackSeat);
  assert.equal(E.rolePosition(bare, 'boss'), null);
  assert.deepEqual(E.rolePositions(bare).map(p => p.role), ['pm']);
  assert.deepEqual(E.aisleEntry(layout), {x: pmDesk.x + 2, y: pmDesk.y - 1});
});
test('seat rules apply to every role and report custom role names', () => {
  const layout = E.defaultLayout(ids), roles = {pm: {name: '小美'}, boss: {name: '老闆'}};
  const boss = layout.furniture.find(f => f.type === 'bossdesk');
  layout.furniture.push({...boss, id: 'boss-desk-2', x: 8, y: 10});
  assert.equal(E.validate(layout, ids, roles), '只能保留一個 老闆 辦公桌。');
  assert.equal(E.validate(layout, ids), '只能保留一個 BOSS 辦公桌。', 'defaults without a roles block');
  layout.furniture.pop();
  const pm = E.rolePosition(layout, 'pm');
  boss.x = pm.x - 1; boss.y = pm.y + 1;
  assert.match(E.validate(layout, ids, roles), /小美 與 老闆 不能共用座位|老闆 與 小美 不能共用座位/);
  const fresh = E.defaultLayout(ids), entry = E.aisleEntry(fresh);
  fresh.furniture.push({id: 'blocker', type: 'plant', x: entry.x, y: entry.y, rotation: 0});
  assert.equal(E.validate(fresh, ids, roles), '請保留 小美 旁的主走道。');
});
test('a legacy layout that still carries roles stays valid', () => {
  const layout = E.defaultLayout(ids);
  layout.roles = {pm: {name: '小美'}};
  assert.equal(E.validate(layout, ids), '');
});
test('every role declares a known action, chair and a desk type the engine accepts', () => {
  for (const role of Object.values(R.ROLES)) {
    assert.ok(['claim', 'worklog'].includes(role.action), role.id);
    assert.ok(['office', 'executive'].includes(role.chair), role.id);
    assert.ok(E.TYPES.includes(role.deskType), role.id);
    assert.ok(R.normalizeLook(role.look), role.id);
  }
});
test('randomLook always produces a valid look and eventually uses every option', () => {
  let n = 7; const random = () => ((n = (n * 16807) % 2147483647) - 1) / 2147483646;
  const colors = new Set(), worn = new Set();
  for (let i = 0; i < 400; i++) {
    const look = R.randomLook(random);
    assert.deepEqual(R.normalizeLook(look), look);
    colors.add(look.hairColor); look.accessories.forEach(a => worn.add(a));
  }
  assert.equal(colors.size, Object.keys(R.HAIR_COLORS).length);
  assert.equal(worn.size, Object.keys(R.ACCESSORIES).length);
});
test('PUT /api/engineers/:id/look saves, clears and rejects looks', () => {
  const {store, cleanup} = tempStore([{id: 'devA', name: 'A', model: 'opus'}]), pushes = {engineers: 0, roles: 0};
  const call = routes(store, pushes), put = (id, body) => call('put /api/engineers/:id/look', {params: {id}, body});
  const look = {skin: 2, hair: 1, outfit: 6, hairColor: 'blonde', accessories: ['glasses', 'tie']};
  assert.equal(put('devA', {look}).code, 200);
  assert.deepEqual(store.loadEngineers()[0], {id: 'devA', name: 'A', model: 'opus', codexModel: '', look: {...look, accessories: ['tie', 'glasses']}});
  assert.equal(put('devA', {look: {skin: 99}}).code, 400);
  assert.equal(put('nobody', {look: null}).code, 404);
  assert.equal(put('devA', {look: null}).code, 200);
  assert.equal(store.loadEngineers()[0].look, undefined);
  assert.equal(pushes.engineers, 2);
  cleanup();
});
test('GET/PUT /api/roles stores cleaned role settings and broadcasts them', () => {
  const {dir, store, cleanup} = tempStore(), pushes = {engineers: 0, roles: 0}, call = routes(store, pushes);
  assert.deepEqual(call('get /api/roles', {}).body, {roles: {}});
  const saved = call('put /api/roles', {body: {roles: {pm: {name: ' 小美 '}, boss: {name: 'BOSS', look: {skin: 0, hair: 1, outfit: 5, accessories: ['tie']}}}}});
  assert.equal(saved.code, 200);
  assert.deepEqual(saved.body.roles, {pm: {name: '小美'}, boss: {look: {skin: 0, hair: 1, outfit: 5, hairColor: '', accessories: ['tie']}}});
  assert.deepEqual(call('get /api/roles', {}).body.roles, saved.body.roles);
  assert.ok(fs.existsSync(path.join(dir, 'roles.json')));
  assert.equal(call('put /api/roles', {body: {roles: {pm: {name: 'x'.repeat(20)}}}}).code, 400);
  assert.equal(call('put /api/roles', {body: {}}).code, 400);
  assert.equal(pushes.roles, 1);
  call('put /api/roles', {body: {roles: {}}});
  assert.deepEqual(store.loadRoles(), {}, 'an empty block resets every role to its defaults');
  cleanup();
});

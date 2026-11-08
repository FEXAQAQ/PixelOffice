const {test} = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/js/office-engine');
const engineers = Array.from({length: 3}, (_, i) => ({id: 'dev' + i, name: 'Dev ' + i, status: 'idle'}));
const ids = engineers.map(e => e.id);
test('every appearance uses a complete outfit, including roster overflow and PM', () => {
  for (let i = 0; i < 100; i++) {
    const look = E.appearance(i);
    assert.ok([5, 6].includes(look.outfit));
    assert.ok(look.skin >= 0 && look.skin < 6);
    assert.ok(look.hair >= 0 && look.hair < 8);
    assert.equal(E.appearance(i, true).outfit, 5);
  }
  assert.equal(E.appearance(-1).outfit, 5);
});
function seeded() { let n = 12345; return () => ((n = (n * 16807) % 2147483647) - 1) / 2147483646; }
test('sofa has four valid directions with matching horizontal and vertical footprints', () => {
  const layout = E.defaultLayout(ids), sofa = layout.furniture.find(f => f.type === 'sofa');
  for (const rotation of [0, 1, 2, 3]) {
    sofa.rotation = rotation;
    assert.deepEqual(E.size(sofa), rotation % 2 ? {w: 1, h: 2} : {w: 2, h: 1});
    assert.equal(E.validate(layout, ids), '');
  }
  sofa.rotation = 4;
  assert.match(E.validate(layout, ids), /家具資料/);
});
test('fridge turns through four facings without changing its 2 × 2 footprint', () => {
  const layout = E.defaultLayout(ids), fridge = layout.furniture.find(f => f.type === 'fridge');
  for (const rotation of [0, 1, 2, 3]) {
    fridge.rotation = rotation;
    assert.deepEqual(E.size(fridge), {w: 2, h: 2});
    assert.equal(E.validate(layout, ids), '');
  }
  fridge.rotation = 4;
  assert.match(E.validate(layout, ids), /家具資料/);
});
test('new office furniture is accepted and uses its expected footprint', () => {
  const dimensions = {filingcabinet: [1, 1], printer: [1, 1], watercooler: [1, 1], meetingtable: [3, 2]};
  for (const [type, [w, h]] of Object.entries(dimensions)) {
    const item = {id: 'new-office-item', type, x: 1, y: 3, rotation: 0};
    assert.deepEqual(E.size(item), {w, h});
    const layout = E.defaultLayout(ids);
    let placed = false;
    for (let y = 3; y < layout.rows - h && !placed; y++) for (let x = 1; x < layout.cols - w && !placed; x++) {
      item.x = x; item.y = y;
      const candidate = E.clone(layout); candidate.furniture.push({...item});
      placed = E.validate(candidate, ids) === '';
    }
    assert.ok(placed, `${type} can be placed in the default office`);
  }
});
test('windows migrate once, retain removal and reject doorway and overlap placement',()=>{
  const legacy=E.defaultLayout(ids);delete legacy.windowVersion;legacy.furniture=legacy.furniture.filter(f=>f.type!=='window');
  const migrated=E.reconcile(legacy,ids);assert.equal(migrated.furniture.filter(f=>f.type==='window').length,3);
  const win=migrated.furniture.find(f=>f.type==='window');win.x=5;
  assert.equal(E.validate(migrated,ids),'');assert.ok(!E.blocked(migrated).has('5,1'));
  win.x=2;assert.match(E.validate(migrated,ids),/入口/);
  win.x=10;assert.match(E.validate(migrated,ids),/重疊/);
  migrated.furniture=migrated.furniture.filter(f=>f.type!=='window');
  assert.equal(E.reconcile(JSON.parse(JSON.stringify(migrated)),ids).furniture.filter(f=>f.type==='window').length,0);
});
test('PM seat follows its desk, reserves the new cell and validates rotated access', () => {
  const layout = E.defaultLayout(ids), desk = layout.furniture.find(f=>f.type==='pmdesk');
  layout.furniture = layout.furniture.filter(f => !f.id.startsWith('boss-')); // free the bottom-left corner
  const previous = E.rolePosition(layout, 'pm');
  desk.x=4; desk.y=12; desk.rotation=1;
  assert.deepEqual(E.rolePosition(layout, 'pm'), {x:3,y:13});
  assert.ok(E.blocked(layout).has('3,13'));
  assert.ok(!E.blocked(layout).has(E.key(previous)));
  assert.equal(E.validate(layout,ids),'');
  desk.x=1;
  assert.match(E.validate(layout,ids), /PM 座位/);
});
test('BOSS office sits bottom-left, reserves its seat and migrates into saved layouts once', () => {
  const layout = E.defaultLayout(ids), boss = E.rolePosition(layout, 'boss');
  assert.deepEqual(boss, {x: 3, y: layout.rows - 4});
  assert.ok(E.blocked(layout).has(E.key(boss)));
  assert.ok(!E.blocked(layout).has(E.key(layout.furniture.find(f => f.type === 'carpet'))), 'carpet stays walkable');
  assert.ok(E.path(layout, {x: 9, y: layout.rows - 4}, {x: 5, y: layout.rows - 4}), 'doorway reachable from the lounge');
  layout.furniture.push({id: 'second', type: 'bossdesk', x: 10, y: 12, rotation: 0});
  assert.match(E.validate(layout, ids), /BOSS/);
  for (const [type, w, h] of [['bossdesk', 3, 1], ['carpet', 3, 2], ['trophycase', 1, 1], ['globe', 1, 1], ['safe', 1, 1]]) assert.deepEqual(E.size({type, rotation: 0}), {w, h});

  const legacy = E.defaultLayout(ids); delete legacy.bossVersion;
  legacy.furniture = legacy.furniture.filter(f => !f.id.startsWith('boss-'));
  const migrated = E.reconcile(legacy, ids);
  assert.equal(migrated.furniture.filter(f => f.id.startsWith('boss-')).length, E.bossSuite(legacy.rows).length);
  const crowded = E.clone(legacy); crowded.furniture.push({id: 'mine', type: 'plant', x: 3, y: crowded.rows - 3, rotation: 0});
  const fallback = E.reconcile(crowded, ids);
  assert.ok(fallback.furniture.some(f => f.id === 'mine'), 'hand-placed furniture survives');
  assert.equal(fallback.furniture.filter(f => f.type === 'bossdesk').length, 1);
  assert.equal(E.validate(fallback, ids), '');
  migrated.furniture = migrated.furniture.filter(f => f.type !== 'bossdesk');
  assert.equal(E.rolePosition(E.reconcile(migrated, ids), 'boss'), null, 'a removed desk stays removed');
});
function tick(sim, seconds, reduced = false) { for (let i = 0; i < seconds * 20; i++) sim.step(.05, reduced); }

test('default room and growing roster have reachable individual seats', () => {
  for (const count of [0, 1, 3, 7, 20]) {
    const roster = Array.from({length: count}, (_, i) => 'dev' + i), layout = E.defaultLayout(roster);
    assert.equal(E.validate(layout, roster), '');
  }
  const saved = E.defaultLayout(ids); saved.furniture[0].x = 2;
  const enlarged = E.reconcile(saved, [...ids, 'new']);
  assert.equal(enlarged.furniture[0].x, 2);
  assert.equal(E.validate(enlarged, [...ids, 'new']), '');
  assert.equal(E.reconcile(enlarged, ids).furniture.filter(f => f.type === 'desk').length, 6);
});

test('path steps are orthogonal, avoid furniture, and respect occupied cells', () => {
  const layout = E.defaultLayout(ids), start = {x: 6, y: 7}, goal = {x: 16, y: 7};
  const route = E.path(layout, start, goal), walls = E.blocked(layout);
  assert.ok(route.length > 10);
  let p = start;
  for (const q of route) {
    assert.equal(Math.abs(p.x - q.x) + Math.abs(p.y - q.y), 1);
    assert.ok(!walls.has(E.key(q))); p = q;
  }
  assert.equal(E.path(layout, start, goal, new Set([E.key(goal)])), null);
});

test('editor rejects overlapping furniture, blocked seats and sealed walkways', () => {
  const layout = E.defaultLayout(ids);
  layout.furniture.push({id: 'bad', type: 'plant', ...E.seat(layout.furniture.find(f => f.type === 'desk')), rotation: 0});
  assert.match(E.validate(layout, ids), /座位/);
  layout.furniture.pop();
  const occupied = E.blocked(layout);
  for (let x = 1; x < 19; x++) if(!occupied.has(x+',8')) layout.furniture.push({id: 'wall' + x, type: 'wall', x, y: 8, rotation: 0});
  assert.match(E.validate(layout, ids), /堵住/);
  const invalid = E.defaultLayout(ids); invalid.furniture[0].x = -1;
  assert.match(E.validate(invalid, ids), /室內/);
  assert.deepEqual(E.reconcile({version: 999}, ids), E.defaultLayout(ids));
});

test('idle walking, interrupt mid-step, return to desk, work, and leave on completion', () => {
  const sim = new E.Simulation(E.defaultLayout(ids), seeded()); sim.sync(engineers);
  let a = sim.agents.get(ids[0]);
  for (let i = 0; i < 300 && !a.next; i++) sim.step(.05);
  assert.ok(a.next); sim.step(.05);
  const before = {x: a.x, y: a.y};
  sim.sync(engineers.map((e, i) => i ? e : {...e, status: 'working', task: {key: 'TEST-1'}}));
  assert.deepEqual({x: a.x, y: a.y}, before, 'sync must not teleport a walking agent');
  for (let i = 0; i < 2000 && a.mode !== 'working'; i++) sim.step(.05);
  assert.equal(a.mode, 'working'); assert.deepEqual(a.cell, a.home);
  const atDesk = {x: a.x, y: a.y}; tick(sim, 3);
  assert.deepEqual({x: a.x, y: a.y}, atDesk);
  sim.sync(engineers); assert.equal(a.mode, 'resting'); tick(sim, 1);
  assert.deepEqual({x: a.x, y: a.y}, atDesk); tick(sim, 10);
  assert.ok(a.mode === 'walking' || a.mode === 'idle');
});

test('simulation never overlaps reserved cells or slides diagonally', () => {
  const many = Array.from({length: 9}, (_, i) => ({id: 'e' + i, name: 'E' + i, status: 'idle'}));
  const layout = E.defaultLayout(many.map(e => e.id)), sim = new E.Simulation(layout, seeded()); sim.sync(many);
  const walls = E.blocked(layout);
  for (let i = 0; i < 2400; i++) {
    const previous = new Map([...sim.agents].map(([id, a]) => [id, {x: a.x, y: a.y}]));
    sim.step(.05); const occupied = new Set();
    for (const a of sim.agents.values()) {
      const before = previous.get(a.id);
      assert.ok(a.x === before.x || a.y === before.y, 'movement follows one axis');
      for (const p of [a.cell, ...(a.next ? [a.next] : [])]) {
        assert.ok(!occupied.has(E.key(p)), 'each cell belongs to at most one agent');
        assert.ok(!walls.has(E.key(p))); occupied.add(E.key(p));
      }
    }
  }
});

test('reduced motion stops wandering, and agent removal clears reservations', () => {
  const sim = new E.Simulation(E.defaultLayout(ids), seeded()); sim.sync(engineers);
  tick(sim, 30, true);
  for (const a of sim.agents.values()) { assert.deepEqual(a.cell, a.home); assert.equal(a.next, null); }
  sim.sync([engineers[0]]); assert.equal(sim.agents.size, 1);
});

test('all wandering agents can return at once, including a rotated desk', () => {
  const roster = Array.from({length: 12}, (_, i) => ({id: 'dev' + i, name: 'Dev ' + i, status: 'idle'}));
  const layout = E.defaultLayout(roster.map(e => e.id));
  Object.assign(layout.furniture.find(f => f.type === 'desk'),{x:5,y:11,rotation:1});
  assert.equal(E.validate(layout, roster.map(e => e.id)), '');
  const sim = new E.Simulation(layout, seeded()); sim.sync(roster); tick(sim, 30);
  sim.sync(roster.map(e => ({...e, status: 'working'}))); tick(sim, 90);
  for (const a of sim.agents.values()) { assert.equal(a.mode, 'working'); assert.deepEqual(a.cell, a.home); }
  assert.equal(sim.agents.get('dev0').direction, 1);
});

test('completion during return and immediate reassignment do not teleport', () => {
  const sim = new E.Simulation(E.defaultLayout(ids), seeded()); sim.sync(engineers); tick(sim, 10);
  const a = sim.agents.get(ids[0]);
  for (const status of ['working', 'idle', 'working']) {
    const before = {x: a.x, y: a.y};
    sim.sync(engineers.map((e, i) => i ? e : {...e, status}));
    assert.deepEqual({x: a.x, y: a.y}, before); tick(sim, .25);
  }
  tick(sim, 30); assert.equal(a.mode, 'working'); assert.deepEqual(a.cell, a.home);
});

test('six reserved face-to-face seats survive roster changes without growing room',()=>{const initial=E.defaultLayout(ids);const desks=initial.furniture.filter(f=>f.type==='desk');assert.equal(desks.length,6);assert.deepEqual(desks.map(f=>E.seat(f).y),[6,6,6,9,9,9]);const all=Array.from({length:6},(_,i)=>'dev'+i),grown=E.reconcile(initial,all);assert.equal(grown.rows,initial.rows);assert.equal(E.validate(grown,all),'');const sim=new E.Simulation(grown);sim.sync(all.map(id=>({id,status:'working'})));tick(sim,1);assert.deepEqual([...sim.agents.values()].map(a=>a.direction),[0,0,0,2,2,2]);const reduced=E.reconcile(grown,ids);assert.equal(reduced.furniture.filter(f=>f.type==='desk'&&f.agentId===null).length,3);});

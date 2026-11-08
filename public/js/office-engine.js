/* Shared by the canvas scene and node:test. All positions are grid cells. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./office-roles'));
  else root.OfficeEngine = factory(root.OfficeRoles);
})(typeof globalThis === 'object' ? globalThis : this, function (R) {
  'use strict';
  const COLS = 20, CELL = 32;
  /** Furniture that turns through four facings (Q/R); others only swap width and height. */
  const FOUR_WAY = ['sofa', 'fridge'];
  const TYPES = ['desk', 'plant', 'shelf', 'sofa', 'wall', 'rug', 'aquarium', 'coffee', 'fridge', 'table', 'pmdesk', 'window', 'whiteboard', 'tv', 'recordplayer', 'filingcabinet', 'printer', 'watercooler', 'meetingtable', 'bossdesk', 'carpet', 'trophycase', 'globe', 'safe'];
  // Walkable floor coverings; everything else blocks the tiles it occupies.
  const FLOORING = ['rug', 'carpet'];
  const ROLE_IDS = Object.keys(R.ROLES), ROLE_DESKS = ROLE_IDS.map(id => R.ROLES[id].deskType);
  // Generated engineer look; PM / BOSS looks come from OfficeRoles.
  function appearance(index = 0, pm = false) {
    const look = R.autoLook(index);
    return pm ? {...look, outfit: 5} : look;
  }
  const key = p => p.x + ',' + p.y;
  const same = (a, b) => a.x === b.x && a.y === b.y;
  const clone = value => JSON.parse(JSON.stringify(value));
  function size(f) {
    let w = ['desk', ...ROLE_DESKS, 'meetingtable', 'carpet'].includes(f.type) ? 3 : ['shelf', 'sofa', 'rug', 'aquarium', 'table', 'fridge', 'window', 'whiteboard', 'tv'].includes(f.type) ? 2 : 1;
    let h = ['rug', 'fridge', 'meetingtable', 'carpet'].includes(f.type) ? 2 : 1;
    return f.rotation % 2 ? {w: h, h: w} : {w, h};
  }
  function cells(f) {
    const {w, h} = size(f), result = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) result.push({x: f.x + x, y: f.y + y});
    return result;
  }
  function seat(f) {
    // Below a horizontal desk, to the right of a vertical desk.
    return f.facing==='south' ? (f.rotation ? {x:f.x-1,y:f.y+1} : {x:f.x+1,y:f.y-1}) : {x:f.x+1,y:f.y+1};
  }
  // Bottom-left private office, mirroring the PM room: doorway on its right wall.
  function bossSuite(rows) {
    return [
      {id:'boss-carpet',type:'carpet',x:2,y:rows-5,rotation:0},
      {id:'boss-desk',type:'bossdesk',x:2,y:rows-3,rotation:0},
      {id:'boss-trophy',type:'trophycase',x:1,y:rows-6,rotation:0},
      {id:'boss-books',type:'shelf',x:2,y:rows-6,rotation:0},
      {id:'boss-globe',type:'globe',x:5,y:rows-6,rotation:0},
      {id:'boss-safe',type:'safe',x:1,y:rows-3,rotation:0},
      {id:'boss-plant',type:'plant',x:1,y:rows-2,rotation:0},
      {id:'boss-plant-b',type:'plant',x:5,y:rows-2,rotation:0},
      ...[1,2,3,4,5,6].map(x=>({id:'boss-top-'+x,type:'wall',x,y:rows-7,rotation:0})),
      ...[rows-6,rows-5,rows-2].map(y=>({id:'boss-side-'+y,type:'wall',x:6,y,rotation:0}))
    ];
  }
  function defaultLayout(ids) {
    const rows = Math.max(20, 12 + Math.ceil(ids.length / 3) * 4);
    return {version: 1, windowVersion: 1, bossVersion: 1, cols: COLS, rows, floor: 'wood', furniture: [
      {id:'entry-mat',type:'rug',x:2,y:3,rotation:0},
      {id:'aquarium',type:'aquarium',x:5,y:3,rotation:0},
      {id:'plant-a',type:'plant',x:1,y:4,rotation:0},
      {id:'books',type:'shelf',x:10,y:3,rotation:0},
      {id:'whiteboard',type:'whiteboard',x:7,y:3,rotation:0},
      {id:'tv',type:'tv',x:10,y:rows-5,rotation:0},
      {id:'recordplayer',type:'recordplayer',x:4,y:8,rotation:0},
      {id:'plant-b',type:'plant',x:18,y:3,rotation:0},
      {id:'coffee-counter',type:'table',x:1,y:7,rotation:0},
      {id:'coffee',type:'coffee',x:3,y:7,rotation:0},
      {id:'fridge',type:'fridge',x:1,y:9,rotation:0},
      {id:'tea-plant',type:'plant',x:4,y:10,rotation:0},
      {id:'lounge',type:'sofa',x:7,y:rows-5,rotation:0},
      {id:'rug',type:'rug',x:7,y:rows-4,rotation:0},
      {id:'lounge-table',type:'table',x:7,y:rows-3,rotation:0},
      {id:'pm-desk',type:'pmdesk',x:15,y:rows-3,rotation:0},
      ...[13,14,15,16,17,18].map(x=>({id:'pm-top-'+x,type:'wall',x,y:rows-7,rotation:0})),
      ...[rows-6,rows-5,rows-2].map(y=>({id:'pm-side-'+y,type:'wall',x:13,y,rotation:0})),
      {id:'pm-plant',type:'plant',x:18,y:rows-2,rotation:0},
      ...Array.from({length:Math.max(6,ids.length)},(_,i)=>({id:'desk-slot:'+i,agentId:ids[i]||null,type:'desk',x:7+i%3*3,y:i<6?7+Math.floor(i/3):12+Math.floor((i-6)/3)*4,rotation:0,facing:i<3?'south':'north'})),
      ...[7,11,15].map(x=>({id:'window-'+x,type:'window',x,y:1,rotation:0})),
      ...bossSuite(rows)
    ]};
  }
  function blocked(layout) {
    const set = new Set(rolePositions(layout).map(key));
    layout.furniture.filter(f => ![...FLOORING,'window'].includes(f.type)).forEach(f => cells(f).forEach(p => set.add(key(p))));
    return set;
  }
  const inside = (layout, p) => p.x >= 1 && p.x < layout.cols - 1 && p.y >= 3 && p.y < layout.rows - 1;
  // Role holders sit behind their desk: above a horizontal desk, left of a vertical one.
  const managerSeat = desk => desk.rotation ? {x:desk.x-1,y:desk.y+1} : {x:desk.x+1,y:desk.y-1};
  /** Seat of a registered role, or null when the role has no desk and no fallback seat. */
  function rolePosition(layout, id) {
    const role = R.ROLES[id], desk = layout.furniture.find(f => f.type === role.deskType);
    return desk ? managerSeat(desk) : role.fallbackSeat ? {...role.fallbackSeat} : null;
  }
  /** Seats of every role present in the office, each tagged with its role id. */
  function rolePositions(layout) {
    return ROLE_IDS.map(id => { const p = rolePosition(layout, id); return p && {...p, role: id}; }).filter(Boolean);
  }
  /** The walkway cell beside the aisle role's seat, from which every desk must be reachable. */
  function aisleEntry(layout) {
    const id = ROLE_IDS.find(id => R.ROLES[id].aisle), p = id && rolePosition(layout, id);
    if (!p) return null;
    return layout.furniture.find(f => f.type === R.ROLES[id].deskType)?.rotation ? {x:p.x,y:p.y+1} : {x:p.x+1,y:p.y};
  }
  function path(layout, start, goal, extra = new Set()) {
    const walls = blocked(layout);
    if (!inside(layout, start) || !inside(layout, goal) || walls.has(key(goal)) || extra.has(key(goal))) return null;
    const queue = [start], parents = new Map([[key(start), null]]);
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i];
      if (same(at, goal)) {
        const result = [];
        let p = at;
        while (parents.get(key(p))) { result.push(p); p = parents.get(key(p)); }
        return result.reverse();
      }
      for (const [dx, dy] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
        const next = {x: at.x + dx, y: at.y + dy}, k = key(next);
        if (inside(layout, next) && !walls.has(k) && !extra.has(k) && !parents.has(k)) {
          parents.set(k, at); queue.push(next);
        }
      }
    }
    return null;
  }
  /** '' when the layout is usable. `roles` only supplies the names used in the messages. */
  function validate(layout, ids, roles) {
    if (layout && layout.name !== undefined && (typeof layout.name !== 'string' || layout.name.length > 30)) return '辦公室名稱最多 30 個字元。';
    if (!layout || layout.version !== 1 || layout.cols !== COLS || !Number.isInteger(layout.rows) || layout.rows < 14 || layout.rows > 200 || !['wood', 'stone'].includes(layout.floor) || !Array.isArray(layout.furniture) || layout.furniture.length > 500) return '配置格式不正確。';
    const name = id => R.roleName(roles, id);
    for (const id of ROLE_IDS) if (layout.furniture.filter(f=>f.type===R.ROLES[id].deskType).length > 1) return `只能保留一個 ${name(id)} 辦公桌。`;
    const seats = rolePositions(layout), entry = aisleEntry(layout);
    for (const p of seats) {
      if (!inside(layout, p)) return `${name(p.role)} 座位必須在室內。`;
      if (R.ROLES[p.role].aisle && !inside(layout, entry)) return `${name(p.role)} 座位與進出空間必須在室內。`;
      const other = seats.find(q => q !== p && same(q, p));
      if (other) return `${name(other.role)} 與 ${name(p.role)} 不能共用座位。`;
    }
    const occupied = new Set(seats.map(key)), seen = new Set(), assigned = new Set(), windows = new Set();
    const holders = seats.map(p => name(p.role)).join('／');
    for (const f of layout.furniture) {
      if (!f || typeof f.id !== 'string' || seen.has(f.id) || !TYPES.includes(f.type) || !Number.isInteger(f.x) || !Number.isInteger(f.y) || !(FOUR_WAY.includes(f.type) ? [0, 1, 2, 3] : [0, 1]).includes(f.rotation)) return '家具資料不正確。';
      seen.add(f.id);
      if (f.type === 'window') {
        if (f.y!==1 || f.rotation!==0 || f.x<5 || f.x+2>layout.cols-1) return '窗戶請放在上方牆面，並避開左上入口（不可旋轉）。';
        for(const p of cells(f)){if(windows.has(key(p)))return '窗戶不可重疊。';windows.add(key(p));}
        continue;
      }
      if (f.type === 'desk') {
        if (f.agentId!=null && (typeof f.agentId !== 'string' || assigned.has(f.agentId))) return '每位工程師需要獨立工位。';
        if(f.agentId!=null)assigned.add(f.agentId);
      }
      for (const p of cells(f)) {
        if (!inside(layout, p)) return '家具必須放在室內。';
        if (!FLOORING.includes(f.type)) {
          if (occupied.has(key(p))) return `家具不可重疊或占用 ${holders} 的位置。`;
          occupied.add(key(p));
        }
      }
    }
    const aisleRole = seats.find(p => R.ROLES[p.role].aisle);
    if (entry && occupied.has(key(entry))) return `請保留 ${name(aisleRole.role)} 旁的主走道。`;
    const deskSeats = new Set();
    for (const f of layout.furniture.filter(f => f.type === 'desk')) {
      const p = seat(f);
      if (!inside(layout, p) || occupied.has(key(p)) || deskSeats.has(key(p))) return '請留出座位與進出空間。';
      deskSeats.add(key(p));
      if (entry && !path(layout, entry, p)) return '家具堵住了回座路線，請保留走道。';
    }
    if (ids.some(id => !assigned.has(id))) return '每位工程師都需要一張工作桌。';
    return '';
  }
  // Keep an existing room when the roster changes, placing new desks in a new row.
  function reconcile(saved, ids) {
    if (!saved || validate(saved, [])) return defaultLayout(ids);
    const layout = clone(saved);
    // Upgrade only the untouched former default; retain hand-placed windows.
    const windows=layout.furniture.filter(f=>f.type==='window').sort((a,b)=>a.x-b.x);
    if(windows.length===3 && windows.every((f,i)=>f.x===[7,10,16][i] && f.y===1 && f.rotation===0))windows.forEach((f,i)=>{f.x=[7,11,15][i];});
    if (!layout.windowVersion) {
      if(!layout.furniture.some(f=>f.type==='window')) layout.furniture.push(...[7,11,15].map(x=>({id:'window-'+x,type:'window',x,y:1,rotation:0})));
      layout.windowVersion=1;
    }
    // Add the BOSS office once. Keep hand-placed furniture: use the whole suite only when it
    // fits, otherwise just the desk in the first free spot. A later removal is respected.
    if (!layout.bossVersion) {
      if (!layout.furniture.some(f=>f.type==='bossdesk')) {
        const fits = extra => !validate({...layout, furniture:[...layout.furniture, ...extra]}, []);
        const suite = bossSuite(layout.rows);
        if (fits(suite)) layout.furniture.push(...suite);
        else for (let y = layout.rows - 3; y >= 4; y--) {
          const x = Array.from({length: COLS - 4}, (_, i) => i + 1).find(x => fits([{id:'boss-desk',type:'bossdesk',x,y,rotation:0}]));
          if (x !== undefined) { layout.furniture.push({id:'boss-desk',type:'bossdesk',x,y,rotation:0}); break; }
        }
      }
      layout.bossVersion=1;
    }
    layout.furniture.forEach(f=>{if(f.type==='desk' && !ids.includes(f.agentId))f.agentId=null;});
    const missing = ids.filter(id => !layout.furniture.some(f => f.agentId === id));
    for(const f of layout.furniture.filter(f=>f.type==='desk' && f.agentId==null)){if(!missing.length)break;f.agentId=missing.shift();}
    if (missing.length) {
      const firstY = layout.rows;
      layout.rows += Math.ceil(missing.length / 3) * 4 + 1;
      missing.forEach((id, i) => layout.furniture.push({id: 'desk:' + id, type: 'desk', agentId: id, x: 3 + i % 3 * 6, y: firstY + Math.floor(i / 3) * 4, rotation: 0}));
    }
    return validate(layout, ids) ? defaultLayout(ids) : layout;
  }
  class Simulation {
    constructor(layout, random = Math.random) {
      this.layout = clone(layout); this.random = random; this.agents = new Map(); this.time = 0;
    }
    sync(engineers) {
      const ids = new Set(engineers.map(e => e.id));
      for (const id of this.agents.keys()) if (!ids.has(id)) this.agents.delete(id);
      engineers.forEach((e, index) => {
        const desk = this.layout.furniture.find(f => f.type === 'desk' && f.agentId === e.id);
        if (!desk) return;
        const home = seat(desk), working = e.status === 'working';
        let a = this.agents.get(e.id);
        if (!a) {
          a = {id: e.id, x: home.x, y: home.y, cell: {...home}, next: null, route: [], home, direction: desk.facing==='south' ? (desk.rotation?1:0) : (desk.rotation?3:2), mode: working ? 'working' : 'idle', working, timer: 1 + index * .9, index};
          this.agents.set(e.id, a);
        }
        a.name = e.name; a.look = e.look; a.task = e.task && e.task.key; a.index = index; a.home = home; a.desk = desk;
        if (working !== a.working) {
          a.working = working; a.route = []; a.timer = 0;
          a.mode = working ? 'returning' : 'resting';
          // Finish the current tile before changing direction: no teleport / diagonal drift.
          if (!working) a.timer = 2.5;
        }
      });
    }
    occupancy(except) {
      const set = new Set();
      for (const a of this.agents.values()) if (a !== except) {
        set.add(key(a.cell)); if (a.next) set.add(key(a.next));
      }
      return set;
    }
    wander(a) {
      const avoid = this.occupancy(a);
      for (const other of this.agents.values()) avoid.add(key(other.home));
      const options = [];
      for (let y = Math.max(3, a.home.y - 3); y <= Math.min(this.layout.rows - 2, a.home.y + 3); y++) {
        for (let x = Math.max(1, a.home.x - 5); x <= Math.min(18, a.home.x + 5); x++) options.push({x, y});
      }
      for (let i = 0; i < 30; i++) {
        const goal = options[Math.floor(this.random() * options.length)];
        if (same(a.cell, goal)) continue;
        const route = path(this.layout, a.cell, goal, avoid);
        if (route && route.length) { a.route = route; a.mode = 'walking'; return; }
      }
      a.timer = 1;
    }
    step(dt, reducedMotion = false) {
      dt = Math.min(Math.max(dt, 0), .1); this.time += dt;
      for (const a of this.agents.values()) {
        if (a.next) {
          const distance = Math.abs(a.next.x - a.x) + Math.abs(a.next.y - a.y), advance = Math.min(distance, dt * 2.1);
          a.x += Math.sign(a.next.x - a.x) * advance; a.y += Math.sign(a.next.y - a.y) * advance;
          if (distance <= advance + .00001) { a.cell = {...a.next}; a.x = a.next.x; a.y = a.next.y; a.next = null; }
          continue;
        }
        if (a.working && same(a.cell, a.home)) {
          a.mode = 'working'; a.direction = a.desk.facing==='south' ? (a.desk.rotation?1:0) : (a.desk.rotation?3:2); a.route = []; continue;
        }
        a.timer -= dt;
        if (a.timer > 0) continue;
        if (a.working) {
          a.mode = 'returning';
          if (!a.route.length) a.route = path(this.layout, a.cell, a.home, this.occupancy(a)) || [];
        } else if (!a.route.length) {
          if (a.mode === 'walking') { a.mode = 'idle'; a.timer = 2 + this.random() * 4; continue; }
          if (reducedMotion) { a.mode = 'idle'; continue; }
          this.wander(a);
        }
        if (a.route.length) {
          const target = a.route[0];
          if (this.occupancy(a).has(key(target))) { a.route = []; a.timer = .4 + this.random() * .5; continue; }
          a.next = a.route.shift();
          a.direction = a.next.x > a.x ? 1 : a.next.x < a.x ? 3 : a.next.y > a.y ? 0 : 2;
        }
      }
    }
  }
  return {COLS, CELL, TYPES, FOUR_WAY, FLOORING, appearance, key, same, clone, size, cells, seat, rolePosition, rolePositions, aisleEntry, bossSuite, defaultLayout, blocked, path, validate, reconcile, Simulation};
});

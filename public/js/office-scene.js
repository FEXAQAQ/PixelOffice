/* Canvas is presentation only. Task execution remains in the dashboard. */
(function () {
  'use strict';
  const E = window.OfficeEngine, R = window.OfficeRoles, SPRITES = window.OfficeSprites;
  const STORAGE = 'rpg-office-layout-v1';
  const COLORS = ['#5aa9ff', '#3ecf8e', '#b47cff', '#ffb454', '#ff8fa3', '#5ee0d0'];
  const LABELS = {desk: '工作桌', plant: '盆栽', shelf: '書櫃', sofa: '沙發', wall: '隔間', rug: '地毯', aquarium: '魚缸', coffee: '咖啡機', fridge: '冰箱', table: '茶几／邊桌', window: '窗戶', whiteboard: '移動式白板', tv: '電視', recordplayer: '唱片機', filingcabinet: '檔案櫃', printer: '印表機', watercooler: '飲水機', meetingtable: '會議桌', bossdesk: 'BOSS 辦公桌', carpet: '高級地毯', trophycase: '獎盃櫃', globe: '地球儀', safe: '保險箱'};
  // Palette groups; every type in LABELS except the engineers' desks appears exactly once.
  const FURNITURE_GROUPS = [['結構', ['wall', 'window']], ['桌椅', ['sofa', 'table', 'meetingtable', 'bossdesk']], ['收納', ['shelf', 'filingcabinet', 'trophycase', 'safe']], ['設備', ['coffee', 'fridge', 'watercooler', 'printer', 'tv', 'recordplayer', 'whiteboard']], ['裝飾', ['plant', 'rug', 'carpet', 'aquarium', 'globe']]];
  window.OfficeScene = {
    props: {engineers: {type: Array, default: () => []}, tasks: {type: Array, default: () => []}, selected: String, connectState: String, visible: {type:Boolean, default:true}, roles: {type:Object, default:()=>({})}},
    emits: ['select', 'role-action', 'toast'],
    data() {
      return {sceneTheme:'forest',ambienceMode:"auto",ambienceMotion:true,clockNow: new Date(), layout: null, officeName: 'THE BUILDERS GUILD', editing: false, editTab: 'layout', furnitureIcons: {}, tool: 'select', selectedFurniture: '', draft: null, ready: false,
        loadError: false, labels: [], worldHeight:448, viewportWidth:640, viewportHeight:448, demo: false, demoWorking: false, demoId: '', reducedMotion: false, floor: 'wood', undoStack: [],
        lookTarget: '', engineerLooks: {}, pendingLooks: {}, draftRoles: {}, pendingRoles: null, fishGameOpen: false, fishUpdatedAt: 0, fishStorageError: false, fishFood: [], fishSchool: []};
    },
    computed: {
      // 對外收三態，對內維持 boolean —— 模擬要暫停的條件是「沒連上」，
      // 這點在 connecting 和 offline 都成立，跟標籤要不要喊「斷線」是兩回事。
      connected() { return this.connectState === 'online'; },
      taskBadges() {
        return Object.fromEntries(this.currentEngineers().map(e => {
          // 跟任務追蹤的 monitorTasks 同一套條件：已驗收的單不算，否則標籤和點進去看到的會對不上。
          const task = this.tasks.find(t => t.engineerId === e.id && (t.status === 'running' || (window.TaskStatus?.FINISHED || []).includes(t.status)));
          const state = e.status === 'working' ? 'running' : task?.status;
          const badge = ['running', ...(window.TaskStatus?.ACTIVE || [])].includes(state)
            ? {kind:'running', icon:'◌', text:'開發中'}
            : (window.TaskStatus?.REQUEUEABLE || []).includes(state)
              ? {kind:'failed', icon:'!', text:'失敗'}
              : state === 'done' ? {kind:'done', icon:'✓', text:'完成'} : null;
          return [e.id, badge];
        }));
      },
      ambiencePeriod() { if(this.ambienceMode!=='auto')return this.ambienceMode;const h=this.clockNow.getHours();return h<5||h>=19?'night':h<11?'morning':h<16?'noon':'sunset'; },
      ambienceAnimated() { return this.ambienceMotion && !this.reducedMotion && this.visible && !this.editing; },
      clockText() { return this.clockNow.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false}); },
      clockDate() { return this.clockNow.toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit',weekday:'short'}); },
      roleDefaults() { return R.ROLES; },
      nameMax() { return R.NAME_MAX; },
      shownLayout() { return this.editing ? this.draft : this.layout; },
      // PM / BOSS names and looks live on the server; while editing, the draft is shown instead.
      savedRoles() { return this.pendingRoles || this.roles; },
      shownRoles() { return this.editing ? this.draftRoles : this.savedRoles; },
      // Name cards for every role seated in the room.
      roleSeats() { const l = this.shownLayout; return l ? E.rolePositions(l).map(p => ({...p, name: R.roleName(this.shownRoles, p.role), color: R.ROLES[p.role].labelColor})) : []; },
      lookOptions() { return {skins: R.SKINS, hairs: R.HAIRS, outfits: R.OUTFITS, accessories: Object.entries(R.ACCESSORIES), hairColors: Object.entries(R.HAIR_COLORS)}; },
      // Look editor targets: role ids, or 'eng:<id>' for engineers.
      lookTargets() { return [...Object.keys(R.ROLES).map(id => ({key: id, name: R.roleName(this.draftRoles, id)})), ...this.engineers.map(e => ({key: 'eng:' + e.id, name: e.name}))]; },
      currentLook() { return this.editing && this.lookTarget ? this.lookOf(this.lookTarget) : null; },
      currentLookName() { return this.lookTargets.find(t => t.key === this.lookTarget)?.name || ''; },
      displayName() { return (this.editing ? this.draft.name?.trim() : this.officeName) || 'THE BUILDERS GUILD'; },
      furnitureGroups() { return FURNITURE_GROUPS.map(([name, types]) => ({name, tools: types.map(type => [type, this.furnitureName({type})])})); },
      sceneScale() { return Math.min(this.viewportWidth / 640, this.viewportHeight / this.worldHeight); },
      chosen() { return this.draft && this.draft.furniture.find(f => f.id === this.selectedFurniture); },
      chosenName() { return this.chosen ? this.furnitureName(this.chosen) : '未選取家具'; },
      editTabs() { return [['layout', '佈置'], ['looks', '角色外觀'], ['names', '名稱']]; }
    },
    watch: {
      engineers: {deep: true, handler() { this.prunePendingLooks(); if (this.sim) this.syncRoster(); }},
      roles() { this.pendingRoles = null; },
      connected(value) { if (value && this.sim) this.syncRoster(); }
    },
    mounted() {
      this.restoreAmbience();
      this.clockTimer=setInterval(()=>{this.clockNow=new Date();this.updateFishSatiety();},1000);
      this.alive = true; this.lastFrame = 0; this.stateClock = 0;
      this.resizeObserver = new ResizeObserver(entries => {
        const {width, height} = entries[0].contentRect;
        // Hidden workspace tabs report zero; retain the last usable size until shown.
        if (width > 0 && height > 0) { this.viewportWidth = width; this.viewportHeight = height; }
      });
      this.resizeObserver.observe(this.$refs.viewport);
      this.motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
      this.motionListener = () => { this.reducedMotion = this.motionQuery.matches; };
      this.motionListener(); this.motionQuery.addEventListener('change', this.motionListener);
      this.restoreFishTank();
      let saved = null;
      try { const raw = localStorage.getItem(STORAGE); if (raw) saved = JSON.parse(raw); }
      catch (_) { this.flash('無法讀取已儲存配置，暫時使用預設辦公室。', 'error'); }
      this.savedLayout = saved;
      this.migrateLegacyRoles(saved);
      this.layout = E.reconcile(saved, this.engineers.map(e => e.id));
      this.officeName = this.layout.name || 'THE BUILDERS GUILD';
      this.sim = new E.Simulation(this.layout); this.sim.sync(this.engineers);
      try { this.furnitureIcons = this.makeFurnitureIcons(); } catch (_) { /* Text-only palette still works. */ }
      this.rosterKey = this.engineers.map(e => e.id).join('\0');
      this.floor = this.layout.floor;
      SPRITES.load().then(() => { if (this.alive) this.ready = true; }).catch(() => { if (this.alive) this.loadError = true; });
      this.frame = timestamp => {
        if (!this.alive) return;
        const dt = this.lastFrame ? Math.min((timestamp - this.lastFrame) / 1000, .1) : 0;
        this.lastFrame = timestamp;
        if (!this.editing && (this.connected || this.demo) && !document.hidden) this.sim.step(dt, this.reducedMotion);
        if (this.visible) {
          this.labels = [...this.sim.agents.values()].map(a=>({id:a.id,name:a.name,x:Math.round((a.x+.5)*32),y:Math.round((a.y+1)*32+5),color:COLORS[a.index%COLORS.length],task:a.working ? a.task || '執行中' : ''}));
          this.draw();
        }
        this.raf = requestAnimationFrame(this.frame);
      };
      this.raf = requestAnimationFrame(this.frame);
    },
    beforeUnmount() {
      clearInterval(this.clockTimer);
      this.updateFishSatiety();this.saveFishTank();
      cancelAnimationFrame(this.fishGameFrame);
      this.alive = false; cancelAnimationFrame(this.raf);
      this.resizeObserver.disconnect();
      this.motionQuery.removeEventListener('change', this.motionListener);
    },
    methods: {
      restoreFishTank() {
        this.fishSchool = [
          {id:1,name:'蜜桃魚',kind:'fish',x:18,y:36,speed:8.5,direction:1,color:'#ff9d66'},
          {id:2,name:'檸檬魚',kind:'fish',x:72,y:58,speed:6.5,direction:-1,color:'#f7d36a'},
          {id:3,name:'薄荷魚',kind:'fish',x:42,y:68,speed:7.5,direction:1,color:'#78d4ca'},
          {id:4,name:'櫻花蝦',kind:'shrimp',x:28,y:86,speed:5,direction:1,color:'#ff857e'},
          {id:5,name:'玫瑰蝦',kind:'shrimp',x:70,y:89,speed:4,direction:-1,color:'#f3a3aa'}
        ].map(fish=>({...fish,satiety:100,dead:false}));
        this.fishUpdatedAt = Date.now();
        try {
          const saved = JSON.parse(localStorage.getItem('pixeloffice-aquarium-v1') || 'null');
          if (saved && Number.isFinite(saved.updatedAt) && saved.updatedAt>0 && Array.isArray(saved.school)) {
            this.fishSchool.forEach(fish=>{
              const old=saved.school.find(item=>item && item.id===fish.id);
              if (old && Number.isFinite(old.satiety)) {
                fish.satiety=Math.max(0,Math.min(100,old.satiety));
                fish.dead=old.dead===true || fish.satiety===0;
                if(fish.dead)fish.satiety=0;
              }
            });
            this.fishUpdatedAt=Math.min(Date.now(),saved.updatedAt);
          }
        } catch (_) {}
        this.updateFishSatiety();
        this.fishSchool.forEach(fish=>{if(fish.dead)fish.y=12;});
        this.saveFishTank();
      },
      updateFishSatiety(now=Date.now()) {
        const elapsed=Math.max(0,now-this.fishUpdatedAt);
        this.fishSchool.forEach(fish=>{
          if(fish.dead)return;
          fish.satiety=Math.max(0,fish.satiety-elapsed/86400000*50);
          if(fish.satiety===0)fish.dead=true;
        });
        this.fishUpdatedAt=Math.max(this.fishUpdatedAt,now);
      },
      saveFishTank() {
        try { localStorage.setItem('pixeloffice-aquarium-v1',JSON.stringify({updatedAt:this.fishUpdatedAt,school:this.fishSchool}));this.fishStorageError=false; }
        catch (_) {this.fishStorageError=true;}
      },
      openFishGame() {
        this.updateFishSatiety();this.saveFishTank();
        this.fishSchool.forEach(fish=>{if(fish.dead)fish.y=12;});
        this.fishGameOpen=true;this.fishFood=[];this.fishGameLast=performance.now();
        cancelAnimationFrame(this.fishGameFrame);
        this.fishGameFrame=requestAnimationFrame(this.tickFishGame);
        this.$nextTick(()=>this.$refs.fishGame?.focus());
      },
      closeFishGame() {
        this.updateFishSatiety();this.saveFishTank();this.fishGameOpen=false;
        cancelAnimationFrame(this.fishGameFrame);
      },
      dropFishFood(event) {
        this.updateFishSatiety();
        if(!this.fishSchool.some(fish=>!fish.dead) || this.fishFood.length>=25)return;
        const box=event.currentTarget.getBoundingClientRect();
        const x=event.detail===0 ? 50 : Math.max(4,Math.min(96,(event.clientX-box.left)/box.width*100));
        this.fishFood.push({id:Date.now()+Math.random(),x,y:15,age:0});
      },
      tickFishGame(now) {
        if(!this.fishGameOpen)return;
        const dt=Math.max(0,Math.min((now-this.fishGameLast)/1000,.05));this.fishGameLast=now;
        this.updateFishSatiety();
        this.fishSchool.forEach(fish=>{
          if(fish.dead){fish.y=Math.max(12,fish.y-dt*9);return;}
          const target=fish.satiety<100 ? this.fishFood.filter(food=>fish.kind!=='shrimp' || food.y>75).reduce((best,food)=>!best || Math.hypot(food.x-fish.x,food.y-fish.y)<Math.hypot(best.x-fish.x,best.y-fish.y) ? food : best,null) : null;
          if(target){
            const dx=target.x-fish.x,dy=target.y-fish.y,distance=Math.hypot(dx,dy);
            fish.direction=dx>=0 ? 1 : -1;
            if(distance<5){this.fishFood=this.fishFood.filter(food=>food.id!==target.id);fish.satiety=Math.min(100,fish.satiety+25);this.saveFishTank();}
            else{fish.x+=dx/distance*fish.speed*dt;fish.y+=dy/distance*fish.speed*dt;}
          }else{
            fish.x=Math.max(6,Math.min(94,fish.x+fish.direction*fish.speed*.45*dt));
            if(fish.x>=94 || fish.x<=6)fish.direction*=-1;
            const restingY=fish.kind==='shrimp' ? 87 : 32+fish.id*10;
            fish.y+=Math.sign(restingY-fish.y)*Math.min(Math.abs(restingY-fish.y),dt*3);
          }
        });
        this.fishFood.forEach(food=>{food.y=Math.min(91,food.y+9*dt);food.age+=dt;});
        this.fishFood=this.fishFood.filter(food=>food.age<40);
        this.fishGameFrame=requestAnimationFrame(this.tickFishGame);
      },
      restoreAmbience() {
        try {
          const saved = JSON.parse(localStorage.getItem('rpg-courtyard-ambience-v1') || 'null');
          if (!saved) return;
          if (['forest', 'city'].includes(saved.scene)) this.sceneTheme = saved.scene;
          if (['auto', 'morning', 'noon', 'sunset', 'night'].includes(saved.mode)) this.ambienceMode = saved.mode;
          this.ambienceMotion = saved.motion !== false;
        } catch (_) { /* Keep the default scene when saved preferences are unavailable. */ }
      },
      // Messages go to the dashboard's toasts, so they float instead of pushing the room down.
      flash(message, type = 'success') { this.$emit('toast', message, type); },
      saveAmbience() { try{localStorage.setItem('rpg-courtyard-ambience-v1',JSON.stringify({scene:this.sceneTheme,mode:this.ambienceMode,motion:this.ambienceMotion}));}catch{this.flash('瀏覽器無法儲存場景偏好，本次設定仍會套用。', 'error');} },
      furnitureName(f) { const role = Object.values(R.ROLES).find(r => r.deskType === f.type); return role ? R.roleName(this.shownRoles, role.id)+' 辦公桌' : f.type==='desk' ? (this.engineers.find(e=>e.id===f.agentId)?.name || '預留')+' 工作桌' : LABELS[f.type]; },
      currentEngineers() {
        return this.engineers.map(e => this.demo && e.id === this.demoId ? {...e, status: this.demoWorking ? 'working' : 'idle', task: this.demoWorking ? {key: '動畫試演'} : null} : e);
      },
      syncRoster() {
        const ids = this.engineers.map(e => e.id), signature = ids.join('\0');
        if (signature !== this.rosterKey) {
          if (this.editing) { this.editing = false; this.draft = null; this.flash('工程師名單已更新，已退出編輯模式。'); }
          // The initial Socket.io snapshot can arrive after mount; retain saved seat positions.
          this.layout = E.reconcile(this.rosterKey ? this.layout : this.savedLayout, ids);
          this.officeName = this.layout.name || 'THE BUILDERS GUILD';
          this.sim = new E.Simulation(this.layout); this.rosterKey = signature;
          this.floor = this.layout.floor;
        }
        if (this.demo && (!ids.includes(this.demoId) || this.engineers.some(e => e.id === this.demoId && e.status === 'working'))) {
          this.demo = false; this.flash('已結束試演，恢復真實任務狀態。');
        }
        this.sim.sync(this.currentEngineers());
      },
      toggleDemo() {
        if (this.demo) { this.demo = false; this.demoWorking = false; }
        else {
          const e = this.engineers.find(e => e.id === this.selected && e.status !== 'working') || this.engineers.find(e => e.status !== 'working');
          if (!e) { this.flash('工程師都在執行任務，請稍後再試演。'); return; }
          this.demo = true; this.demoWorking = false; this.demoId = e.id;
        }
        this.sim.sync(this.currentEngineers());
      },
      demoTask() { this.demoWorking = !this.demoWorking; this.sim.sync(this.currentEngineers()); },
      beginEdit() {
        if (this.demo) { this.demo = false; this.sim.sync(this.engineers); }
        this.draft = E.clone(this.layout); this.draftRoles = this.editableRoles(this.savedRoles); this.lookTarget = ''; this.engineerLooks = {}; this.editing = true; this.editTab = 'layout'; this.selectedFurniture = ''; this.tool = 'select'; this.undoStack = [];
      },
      // Every role gets an entry while editing; blank or default names are dropped on save.
      editableRoles(roles) { return Object.fromEntries(Object.keys(R.ROLES).map(id => [id, {...(roles?.[id] || {}), name: R.roleName(roles, id)}])); },
      // Names and looks used to sit in this browser's layout; hand them to the server once.
      async migrateLegacyRoles(saved) {
        const legacy = saved && R.cleanRoles(saved.roles);
        if (!legacy || !Object.keys(legacy).length) return;
        try {
          const current = await (await fetch('/api/roles')).json();
          if (!Object.keys(current.roles || {}).length) await this.putRoles(legacy);
          delete saved.roles; if (this.layout) delete this.layout.roles;
          localStorage.setItem(STORAGE, JSON.stringify(saved));
        } catch (_) { /* Retry on the next load; the local copy is untouched. */ }
      },
      async putRoles(roles) {
        const r = await fetch('/api/roles', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({roles})});
        if (!r.ok) throw Error((await r.json().catch(() => ({}))).error || '角色設定儲存失敗');
      },
      cancelEdit() { this.editing = false; this.draft = null; this.engineerLooks = {}; },
      saveEdit() {
        this.draft.name = (this.draft.name || '').trim() || 'THE BUILDERS GUILD';
        delete this.draft.roles;
        const roleError = R.validateRoles(this.draftRoles);
        if (roleError) { this.flash(roleError, 'error'); return; }
        const error = E.validate(this.draft, this.engineers.map(e => e.id), this.draftRoles);
        if (error) { this.flash(error, 'error'); return; }
        try { localStorage.setItem(STORAGE, JSON.stringify(this.draft)); }
        catch (_) { this.flash('瀏覽器無法儲存配置。請確認儲存空間或隱私設定，編輯內容仍保留。', 'error'); return; }
        this.layout = E.clone(this.draft); this.savedLayout = E.clone(this.layout);
        this.officeName = this.layout.name;
        this.sim = new E.Simulation(this.layout); this.sim.sync(this.engineers);
        const looks = this.engineerLooks, roles = R.cleanRoles(this.draftRoles);
        this.floor = this.layout.floor; this.cancelEdit(); this.flash('辦公室已儲存。');
        // Role and engineer looks are shared by everyone, so they go to the server.
        if (JSON.stringify(roles) !== JSON.stringify(R.cleanRoles(this.roles))) {
          this.pendingRoles = roles;
          this.putRoles(roles).catch(err => { this.pendingRoles = null; this.flash(err.message, 'error'); });
        }
        if (Object.keys(looks).length) { this.pendingLooks = {...this.pendingLooks, ...looks}; this.saveEngineerLooks(looks); }
      },
      autoEngineerLook(id) { return E.appearance(this.engineers.findIndex(e => e.id === id) + 1); },
      /** Resolved look for a role id or 'eng:<id>': unsaved edit, then saved value, then the generated default. */
      lookOf(key) {
        if (!key.startsWith('eng:')) return R.roleLook(this.shownRoles, key);
        const id = key.slice(4);
        for (const pending of this.editing ? [this.engineerLooks, this.pendingLooks] : [this.pendingLooks]) if (id in pending) return pending[id] || this.autoEngineerLook(id);
        return R.normalizeLook(this.engineers.find(e => e.id === id)?.look) || this.autoEngineerLook(id);
      },
      setLook(patch) {
        const look = {...this.currentLook, ...patch}, key = this.lookTarget;
        if (key.startsWith('eng:')) this.engineerLooks = {...this.engineerLooks, [key.slice(4)]: look};
        else this.draftRoles[key] = {...this.draftRoles[key], look};
      },
      shuffleLook() { this.setLook(R.randomLook()); },
      toggleAccessory(name, on) {
        const worn = this.currentLook.accessories.filter(a => a !== name);
        this.setLook({accessories: on ? [...worn, name] : worn});
      },
      resetLook() {
        const key = this.lookTarget;
        if (key.startsWith('eng:')) this.engineerLooks = {...this.engineerLooks, [key.slice(4)]: null};
        else { const {look, ...rest} = this.draftRoles[key]; this.draftRoles[key] = rest; }
      },
      async saveEngineerLooks(looks) {
        const failed = [];
        for (const [id, look] of Object.entries(looks)) {
          try {
            const r = await fetch('/api/engineers/' + encodeURIComponent(id) + '/look', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({look})});
            if (!r.ok) failed.push(id);
          } catch (_) { failed.push(id); }
        }
        if (!failed.length) return;
        const rest = {...this.pendingLooks}; failed.forEach(id => delete rest[id]); this.pendingLooks = rest;
        this.flash('部分工程師外觀未能儲存：' + failed.map(id => this.engineers.find(e => e.id === id)?.name || id).join('、'), 'error');
      },
      // Drop optimistic looks once the server's roster reflects them.
      prunePendingLooks() {
        const ids = Object.keys(this.pendingLooks).filter(id => {
          const e = this.engineers.find(e => e.id === id);
          return e && JSON.stringify(R.normalizeLook(e.look)) !== JSON.stringify(this.pendingLooks[id]);
        });
        if (ids.length !== Object.keys(this.pendingLooks).length) this.pendingLooks = Object.fromEntries(ids.map(id => [id, this.pendingLooks[id]]));
      },
      drawLookPreview() {
        const canvas = this.$refs.lookPreview;
        if (!canvas || !this.currentLook || !this.ready) return;
        const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.clearRect(0, 0, canvas.width, canvas.height);
        const step = this.reducedMotion ? 0 : Math.floor(performance.now() / 125) % 6;
        for (let direction = 0; direction < 4; direction++) SPRITES.paint(c, this.currentLook, direction, step, direction * 64, 0);
      },
      changeDraft(next) {
        const error = E.validate(next, this.engineers.map(e => e.id), this.draftRoles);
        if (error) { this.flash(error, 'error'); return false; }
        this.undoStack.push(E.clone(this.draft)); if (this.undoStack.length > 30) this.undoStack.shift();
        this.draft = next; return true;
      },
      undo() { if (this.undoStack.length) { this.draft = this.undoStack.pop(); } },
      resetDraft() { const next = E.defaultLayout(this.engineers.map(e => e.id)); next.name = this.draft.name; this.changeDraft(next); this.selectedFurniture = ''; },
      setFloor(value) { const next = E.clone(this.draft); next.floor = value; this.changeDraft(next); },
      rotate(step = 1) {
        if (!this.chosen) return;
        const next = E.clone(this.draft), f = next.furniture.find(f => f.id === this.selectedFurniture);
        const directions = E.FOUR_WAY.includes(f.type) ? 4 : 2;
        f.rotation = (f.rotation + step + directions) % directions; this.changeDraft(next);
      },
      remove() {
        if (!this.chosen) return;
        if (this.chosen.type === 'desk') { this.flash('工程師的工作桌可以移動或旋轉，需要保留供角色回座。', 'error'); return; }
        const next = E.clone(this.draft); next.furniture = next.furniture.filter(f => f.id !== this.selectedFurniture);
        if (this.changeDraft(next)) this.selectedFurniture = '';
      },
      clickScene(event) {
        const canvas = this.$refs.canvas, rect = canvas.getBoundingClientRect();
        const x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
        const tile = {x: Math.floor(x / E.CELL), y: Math.floor(y / E.CELL)};
        if (this.editing) {
          this.editTab = 'layout';
          if (this.tool !== 'select') {
            const next = E.clone(this.draft), id = 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
            next.furniture.push({id, type: this.tool, ...tile, rotation: 0});
            if (this.changeDraft(next)) this.selectedFurniture = id;
          } else {
            const hit = [...this.draft.furniture].reverse().find(f => E.cells(f).some(p => E.same(p, tile)));
            if (hit && hit.id !== this.selectedFurniture) { this.selectedFurniture = hit.id; }
            else if (this.chosen) {
              const next = E.clone(this.draft), f = next.furniture.find(f => f.id === this.selectedFurniture);
              f.x = tile.x; f.y = tile.y; this.changeDraft(next);
            }
          }
          return;
        }
        const onSeat = p => Math.abs(x-(p.x+.5)*32)<30 && y>p.y*32-36 && y<(p.y+1)*32;
        const seated = E.rolePositions(this.layout).find(onSeat);
        if (seated) { this.$emit('role-action', R.ROLES[seated.role].action); return; }
        const deskRole = Object.values(R.ROLES).find(r => r.clickDesk && this.layout.furniture.some(f => f.type === r.deskType && E.cells(f).some(p => E.same(p, tile))));
        if (deskRole) { this.$emit('role-action', deskRole.action); return; }
        const hit = [...this.sim.agents.values()].sort((a, b) => b.y - a.y).find(a => Math.abs(x - (a.x + .5) * 32) < 24 && y > a.y * 32 - 36 && y < a.y * 32 + 32);
        if (hit) { this.$emit('select', hit.id); return; }
        const aquarium = this.layout.furniture.find(f => f.type === 'aquarium' && E.cells(f).some(p => E.same(p, tile)));
        if (aquarium) { this.openFishGame(); return; }
        const desk = this.layout.furniture.find(f => f.type === 'desk' && E.cells(f).some(p => E.same(p, tile)));
        if (desk?.agentId) this.$emit('select', desk.agentId);
      },
      keyScene(event) {
        if (!this.editing) return;
        if (event.key.toLowerCase() === 'r') { event.preventDefault(); this.rotate(1); }
        if (event.key.toLowerCase() === 'q') { event.preventDefault(); this.rotate(-1); }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); this.remove(); }
        if (event.key === 'Escape') { this.selectedFurniture = ''; this.tool = 'select'; }
        if (event.key.startsWith('Arrow') && this.chosen) {
          event.preventDefault(); const next = E.clone(this.draft), f = next.furniture.find(f => f.id === this.selectedFurniture);
          const delta = {ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0]}[event.key];
          f.x += delta[0]; f.y += delta[1]; this.changeDraft(next);
        }
      },
      paintWindow(c, x, y) {
        const rect = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
        rect(x, y, 60, 40, '#c9ba90'); rect(x + 4, y + 4, 52, 31, '#78a6af');
        rect(x + 4, y + 23, 52, 12, '#98bbaa'); rect(x + 28, y + 2, 4, 36, '#d9c99c');
        rect(x + 3, y + 16, 53, 3, '#d9c99c');
      },
      paintFurniture(c, f) {
        const rect = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
        const x = f.x * 32, y = f.y * 32, {w: fw, h: fh} = E.size(f), W = fw * 32, H = fh * 32;
        if (f.type === 'rug') {
          rect(x, y, W, H, '#722f35'); rect(x + 3, y + 3, W - 6, H - 6, '#d4b47c'); rect(x + 6, y + 6, W - 12, H - 12, '#ab454b');
          return;
        }
        if (f.type === 'carpet') {
          // Burgundy Persian-style carpet with a gold border, medallion and fringe.
          rect(x, y, W, H, '#3d1c2a'); rect(x + 3, y + 3, W - 6, H - 6, '#d8b25a'); rect(x + 5, y + 5, W - 10, H - 10, '#6d2233');
          rect(x + 10, y + 10, W - 20, H - 20, '#842c3f'); rect(x + 12, y + 12, W - 24, H - 24, '#6d2233');
          rect(x + W / 2 - 10, y + H / 2 - 2, 20, 4, '#d8b25a'); rect(x + W / 2 - 2, y + H / 2 - 10, 4, 20, '#d8b25a');
          rect(x + W / 2 - 5, y + H / 2 - 5, 10, 10, '#1f4d4a'); rect(x + W / 2 - 2, y + H / 2 - 2, 4, 4, '#e8cf8a');
          for (const [cx, cy] of [[x + 8, y + 8], [x + W - 12, y + 8], [x + 8, y + H - 12], [x + W - 12, y + H - 12]]) rect(cx, cy, 4, 4, '#d8b25a');
          const along = f.rotation ? H : W;
          for (let i = 3; i < along - 2; i += 6) {
            if (f.rotation) { rect(x - 2, y + i, 2, 2, '#efe0b4'); rect(x + W, y + i, 2, 2, '#efe0b4'); }
            else { rect(x + i, y - 2, 2, 2, '#efe0b4'); rect(x + i, y + H, 2, 2, '#efe0b4'); }
          }
          return;
        }
        rect(x + 4, y + H - 2, W, 6, '#4a3a3244');
        if (f.type === 'desk' || f.type === 'pmdesk') {
          rect(x + 5, y + H - 8, 6, 16, '#5c4535'); rect(x + W - 11, y + H - 8, 6, 16, '#5c4535');
          rect(x, y + 2, W, H - 4, '#634d36'); rect(x, y - 3, W, H - 5, '#d3ad76'); rect(x + 2, y - 2, W - 4, 3, '#ead095');
          const a = this.sim.agents.get(f.agentId), on = a && a.mode === 'working' && !this.editing;
          const reverse=f.facing==='south', mx = x + W / 2 - 15, my = f.rotation ? y + H / 2 - 12 : reverse ? y+4 : y-8;
          rect(mx + 10, my + (reverse?14:23), 7, 5, '#58615a'); rect(mx, my, 30, reverse?14:24, '#374842'); rect(mx + 3, my + 3, 24, reverse?8:17, reverse ? '#52615a' : on ? '#477f6b' : '#233e3b');
          if (on && !reverse) {
            rect(mx + 6, my + 7, 14, 2, '#b8ebad'); rect(mx + 6, my + 12, this.reducedMotion ? 10 : 8 + Math.floor(this.sim.time * 3) % 8, 2, '#92d6b5');
          } else rect(mx + 9, my + 10, 10, 1, '#52756a');
          if (f.rotation) rect(x + W - 7, y + H / 2 - 11, 6, 23, '#a5b29c');
          else rect(x + W / 2 - 12, reverse ? y-3 : y+H-6, 24, 6, '#a5b29c');
          rect(x + 6, y + 7, 7, 8, '#e9d4a7'); rect(x + 12, y + 8, 3, 4, '#a38052');
        } else if (f.type === 'bossdesk') {
          // Walnut executive desk with gold trim; the BOSS faces the room, so we see the laptop lid.
          rect(x + 5, y + H - 8, 7, 14, '#34201a'); rect(x + W - 12, y + H - 8, 7, 14, '#34201a');
          rect(x - 2, y + 2, W + 4, H - 3, '#4a2b1e'); rect(x + 4, y + H - 11, W - 8, 7, '#5e3827');
          rect(x - 3, y - 5, W + 6, H - 5, '#7a482c'); rect(x - 1, y - 3, W + 2, 3, '#a56b43');
          rect(x - 3, y + H - 12, W + 6, 2, '#d8b25a');
          const cx = Math.round(x + W / 2);
          if (!f.rotation) {
            rect(cx - 13, y - 4, 26, 15, '#2f3736'); rect(cx - 11, y - 2, 22, 11, '#3f4a48'); rect(cx - 2, y + 2, 4, 4, '#d6dfda');
            rect(cx - 15, y + 11, 30, 2, '#9aa7a1');
            rect(cx - 12, y + 14, 24, 5, '#d8b25a'); rect(cx - 9, y + 16, 18, 1, '#6b4a1c');
            rect(x + 7, y + 8, 10, 3, '#2d2118'); rect(x + 11, y - 5, 2, 13, '#c9a24c');
            rect(x + 5, y - 11, 14, 7, '#2f6b4f'); rect(x + 6, y - 5, 12, 1, '#f5e39a');
            rect(x + W - 30, y + 1, 15, 11, '#f1e8cf'); rect(x + W - 28, y + 4, 10, 1, '#8c8470'); rect(x + W - 28, y + 7, 7, 1, '#8c8470');
            rect(x + W - 11, y - 1, 6, 9, '#262626'); rect(x + W - 10, y - 5, 1, 4, '#d8b25a'); rect(x + W - 8, y - 6, 1, 5, '#c0c0c0');
          } else {
            rect(cx - 9, y + H / 2 - 14, 16, 24, '#2f3736'); rect(cx - 7, y + H / 2 - 12, 12, 20, '#3f4a48');
            rect(cx - 8, y + 4, 14, 12, '#f1e8cf'); rect(cx - 3, y + H - 30, 5, 12, '#d8b25a');
          }
        } else if (f.type === 'trophycase') {
          rect(x + 3, y - 26, 26, 56, '#4a2b1e'); rect(x + 5, y - 24, 22, 45, '#9fcac6');
          rect(x + 5, y - 8, 22, 2, '#4a2b1e'); rect(x + 5, y + 6, 22, 2, '#4a2b1e');
          rect(x + 11, y - 21, 10, 6, '#e6c257'); rect(x + 9, y - 20, 2, 3, '#e6c257'); rect(x + 21, y - 20, 2, 3, '#e6c257');
          rect(x + 15, y - 15, 2, 4, '#c9a23f'); rect(x + 12, y - 11, 8, 3, '#8a6a2a');
          rect(x + 8, y - 4, 6, 6, '#e6c257'); rect(x + 10, y - 6, 2, 2, '#b8433f');
          rect(x + 18, y - 5, 6, 7, '#c3cacd'); rect(x + 20, y - 7, 2, 2, '#3f6db8');
          rect(x + 9, y + 10, 14, 9, '#8a5a32'); rect(x + 11, y + 12, 10, 5, '#e6c257');
          rect(x + 7, y - 22, 2, 40, '#d6efeb'); rect(x + 3, y + 21, 26, 9, '#34201a'); rect(x + 14, y + 24, 4, 2, '#d8b25a');
        } else if (f.type === 'globe') {
          rect(x + 9, y + 25, 14, 5, '#34201a'); rect(x + 15, y + 6, 3, 20, '#7a4a2a');
          rect(x + 11, y - 20, 11, 2, '#3a79a0'); rect(x + 8, y - 18, 17, 18, '#3f86ad'); rect(x + 11, y, 11, 2, '#3a79a0');
          rect(x + 10, y - 16, 6, 4, '#78ab58'); rect(x + 17, y - 11, 6, 6, '#78ab58'); rect(x + 12, y - 7, 3, 3, '#78ab58');
          rect(x + 11, y - 17, 3, 2, '#b9dcef');
          rect(x + 6, y - 14, 2, 12, '#c9a24c'); rect(x + 25, y - 14, 2, 12, '#c9a24c'); rect(x + 8, y + 3, 17, 2, '#c9a24c'); rect(x + 15, y - 23, 3, 3, '#c9a24c');
        } else if (f.type === 'safe') {
          rect(x + 3, y - 10, 26, 40, '#2a2f31'); rect(x + 5, y - 8, 22, 34, '#495155'); rect(x + 7, y - 6, 18, 30, '#3b4245');
          rect(x + 11, y + 1, 10, 10, '#c9ccc6'); rect(x + 13, y + 3, 6, 6, '#8d928d'); rect(x + 15, y + 2, 2, 3, '#2a2f31');
          rect(x + 22, y + 3, 2, 9, '#d8b25a'); rect(x + 9, y - 3, 14, 2, '#5d676a');
          rect(x + 6, y + 29, 4, 2, '#1c2022'); rect(x + 22, y + 29, 4, 2, '#1c2022');
        } else if (f.type === 'whiteboard') {
          rect(x+6,y+H-16,4,15,'#74867d'); rect(x+W-10,y+H-16,4,15,'#74867d');
          rect(x+3,y+H-3,12,4,'#33473f'); rect(x+W-15,y+H-3,12,4,'#33473f');
          rect(x,y-27,W,H+9,'#82958c'); rect(x+3,y-24,W-6,H+3,'#edf0d8');
          rect(x+7,y-18,W-14,3,'#658d86'); rect(x+7,y-10,Math.max(8,W-26),2,'#8ca49b');
          rect(x+8,y,7,7,'#e4be72'); rect(x+19,y,Math.max(4,W-29),2,'#668b96');
          rect(x-1,y+H-18,W+2,4,'#a9b7a9'); rect(x+7,y+H-20,8,2,'#c16d56');
        } else if (f.type === 'tv') {
          rect(x+3,y+H-10,W-6,11,'#78573f'); rect(x+6,y+H-8,W-12,6,'#aa835a');
          rect(x+W/2-3,y+H-21,6,12,'#465951'); rect(x+W/2-11,y+H-12,22,3,'#34483f');
          rect(x,y-25,W,H+5,'#243b34'); rect(x+3,y-22,W-6,H-2,'#4d8190');
          rect(x+6,y-19,W-12,6,'#78a7af'); rect(x+6,y-10,Math.max(6,W/2),3,'#acc3b4');
          rect(x+W-7,y+H-24,2,2,'#b7cf88');
        } else if (f.type === 'recordplayer') {
          rect(x+2,y+5,28,25,'#72503a'); rect(x+4,y+9,24,15,'#9f7950');
          rect(x,y-9,32,18,'#d0a772'); rect(x+2,y-7,28,14,'#91734d');
          rect(x+7,y-5,12,2,'#263d36'); rect(x+4,y-3,18,7,'#263d36'); rect(x+7,y+4,12,2,'#263d36');
          rect(x+10,y-1,6,3,'#cb8663'); rect(x+12,y,2,1,'#f0d8a7');
          rect(x+25,y-5,3,3,'#d8d6b8'); rect(x+23,y-3,2,7,'#c2cbb7'); rect(x+19,y+3,6,2,'#c2cbb7');
          rect(x+7,y+13,18,2,'#5b4634'); rect(x+7,y+18,18,2,'#5b4634');
          rect(x+4,y+29,4,3,'#3e4d3a'); rect(x+24,y+29,4,3,'#3e4d3a');
        } else if (f.type === 'table') {
          rect(x + 5, y + H - 8, 5, 12, '#594532'); rect(x + W - 10, y + H - 8, 5, 12, '#594532');
          rect(x, y + 2, W, H - 5, '#78573d'); rect(x, y - 2, W, H - 6, '#c9a579');
          rect(x + 2, y - 2, W - 4, 3, '#e4c89a');
          rect(x + 7, y + 6, 12, 8, '#edf0d8'); rect(x + 9, y + 8, 8, 1, '#81998d');
          rect(x + W - 12, y + H - 19, 7, 7, '#eee0bd'); rect(x + W - 6, y + H - 18, 3, 4, '#aa8258');
        } else if (f.type === 'aquarium') {
          // Glass tank, water, gravel, plants and two fish above a wooden cabinet.
          rect(x + 2, y + H - 14, W - 4, 15, '#694f38');
          rect(x + 5, y + H - 11, W - 10, 9, '#a78050');
          rect(x, y - 20, W, H + 7, '#2a5155');
          rect(x + 3, y - 16, W - 6, H - 1, '#79c5c1');
          rect(x + 5, y - 12, W - 10, H - 9, '#367f92');
          rect(x + 5, y + H - 23, W - 10, 7, '#c9b680');
          rect(x + 9, y + H - 34, 3, 14, '#75ae77');
          rect(x + 6, y + H - 30, 4, 4, '#92c484');
          rect(x + W - 14, y + H - 37, 3, 17, '#447e64');
          rect(x + 1, y - 22, W - 2, 5, '#bed8bf');
          rect(x + 4, y - 14, 2, H - 5, '#c2ede0');
          const t = this.reducedMotion ? 0 : this.sim.time;
          rect(x + W * .38, y + H - 29, 10, 7, '#647f78');
          rect(x + W * .52, y + H - 25, 13, 3, '#795c3d');
          for (const [i, fish] of this.fishSchool.entries()) {
            const fx = x + 10 + (Math.sin(t * .65 + i * 2.7) + 1) * .5 * Math.max(0, W - 28);
            const fy = fish.dead ? y - 12 : fish.kind === 'shrimp' ? y + H - 23 : y - 7 + i * Math.max(4, (H - 24) * .25);
            const color = fish.dead ? '#aeb7ac' : fish.color;
            rect(fx, fy, 7, fish.kind === 'shrimp' ? 2 : 4, color);
            rect(fx - 3, fy - 1, 3, fish.kind === 'shrimp' ? 3 : 6, color);
            rect(fx + 5, fy, 1, 1, '#293f45');
          }
          const bubbleY = y + H - 27 - (t * 8 % Math.max(8, H - 20));
          rect(x + W - 9, bubbleY, 2, 2, '#b7ece3');
        } else if (f.type === 'coffee') {
          rect(x + 2, y + 12, 28, 18, '#6e4d38');
          rect(x, y + 9, 32, 5, '#d1a977');
          rect(x + 5, y - 17, 22, 27, '#293b3b');
          rect(x + 7, y - 19, 18, 5, '#b2bab0');
          rect(x + 8, y - 12, 15, 7, '#64796e');
          rect(x + 19, y - 10, 3, 3, '#a5d990');
          rect(x + 10, y - 2, 11, 10, '#172725');
          rect(x + 14, y - 3, 3, 4, '#c5b994');
          rect(x + 11, y + 3, 8, 6, '#eee0bd');
          rect(x + 18, y + 4, 3, 3, '#c7b993');
          rect(x + 6, y + 10, 20, 3, '#87958b');
          rect(x + 13, y + 20, 6, 2, '#c6a06c');
        } else if (f.type === 'fridge' && f.rotation) {
          // Side and back views; rotation 3 mirrors the left-facing side view.
          c.save();
          if (f.rotation === 3) { c.translate(2 * x + W, 0); c.scale(-1, 1); }
          rect(x + 2, y - 18, W - 4, H + 18, '#758d87');
          rect(x + 4, y - 20, W - 8, H + 17, '#bfcabb');
          const divider = y - 15 + Math.round(H * .35);
          if (f.rotation === 2) {
            for (let i = 0; i < 6; i++) rect(x + 12, y - 10 + i * 9, W - 24, 2, '#8a9d93');
            rect(x + 10, y - 12, 2, H + 2, '#8a9d93'); rect(x + W - 12, y - 12, 2, H + 2, '#8a9d93');
          } else {
            rect(x + 4, y - 20, 8, H + 17, '#edf0db'); rect(x + 12, y - 20, 2, H + 17, '#94a99e');
            rect(x + 4, divider, 8, 3, '#94a99e');
            rect(x, divider - 11, 4, 8, '#637d76'); rect(x, divider + 7, 4, 12, '#637d76');
            rect(x + 20, y - 12, W - 30, 2, '#d3dccb'); rect(x + 20, divider + 8, W - 30, 2, '#d3dccb');
          }
          rect(x + 6, y + H - 2, W - 12, 3, '#516b64');
          c.restore();
        } else if (f.type === 'fridge') {
          rect(x + 2, y - 18, W - 4, H + 18, '#758d87');
          rect(x + 4, y - 20, W - 8, H + 17, '#d7e0cf');
          rect(x + 6, y - 17, W - 13, H + 11, '#edf0db');
          const divider = y - 15 + Math.round(H * .35);
          rect(x + 4, divider, W - 8, 3, '#94a99e');
          rect(x + W - 11, divider - 11, 3, 8, '#637d76');
          rect(x + W - 11, divider + 7, 3, 12, '#637d76');
          rect(x + 9, divider + 9, 9, 11, '#f3d895');
          rect(x + 12, divider + 7, 3, 3, '#b96553');
          rect(x + 6, y + H - 2, W - 12, 3, '#516b64');
        } else if (f.type === 'plant') {
          rect(x + 10, y + 12, 16, 18, '#875139'); rect(x + 8, y + 9, 20, 6, '#ce8e5c');
          rect(x + 16, y - 14, 4, 26, '#66834d'); rect(x + 5, y - 14, 13, 14, '#6c985b'); rect(x + 19, y - 22, 9, 19, '#48734c'); rect(x + 10, y - 25, 10, 14, '#90ad65');
        } else if (f.type === 'shelf') {
          rect(x, y - 22, W, H + 20, '#624c39'); rect(x + 3, y - 19, W - 6, H + 12, '#a77d50');
          for (let i = 0; i < Math.floor((W - 8) / 7); i++) rect(x + 5 + i * 7, y - 15, 5, 21, ['#718f80', '#c1b179', '#966556'][i % 3]);
          rect(x, y + 7, W, 4, '#e1b783');
        } else if (f.type === 'filingcabinet') {
          rect(x + 4, y - 22, 24, 52, '#354b48'); rect(x + 6, y - 20, 20, 48, '#879d93');
          for (let i = 0; i < 3; i++) {
            rect(x + 8, y - 17 + i * 14, 16, 11, '#b6c3ae');
            rect(x + 13, y - 13 + i * 14, 6, 2, '#50695f');
          }
          rect(x + 5, y + 27, 22, 3, '#2f4540');
        } else if (f.type === 'printer') {
          rect(x + 4, y + 9, 24, 21, '#596b65'); rect(x + 6, y + 12, 20, 15, '#87978e');
          rect(x + 7, y - 10, 18, 12, '#d4d9c7'); rect(x + 10, y - 6, 12, 6, '#f0efdc');
          rect(x + 2, y - 1, 28, 17, '#3d544e'); rect(x + 4, y + 1, 24, 11, '#c0cbbb');
          rect(x + 8, y + 12, 16, 3, '#4b6259'); rect(x + 23, y + 4, 3, 3, '#8dca97');
        } else if (f.type === 'watercooler') {
          rect(x + 5, y + 5, 22, 25, '#bdc9ba'); rect(x + 8, y + 8, 16, 18, '#e0e4cf');
          rect(x + 8, y - 14, 16, 20, '#4a8894'); rect(x + 10, y - 17, 12, 4, '#a9d6d0');
          rect(x + 11, y - 10, 3, 12, '#83bec0'); rect(x + 10, y + 10, 4, 3, '#b96359');
          rect(x + 18, y + 10, 4, 3, '#7aacc0'); rect(x + 13, y + 17, 6, 8, '#718d83');
        } else if (f.type === 'meetingtable') {
          rect(x + 8, y + H - 12, 7, 14, '#644b36'); rect(x + W - 15, y + H - 12, 7, 14, '#644b36');
          rect(x + 2, y + 4, W - 4, H - 9, '#634b36');
          rect(x, y, W, H - 8, '#b88c5c'); rect(x + 3, y + 3, W - 6, H - 14, '#d3ab77');
          rect(x + 5, y + 3, W - 10, 3, '#e7c696');
          rect(x + W / 2 - 9, y + H / 2 - 9, 18, 13, '#536c64');
          rect(x + W / 2 - 6, y + H / 2 - 7, 12, 8, '#78938a');
          rect(x + 14, y + 16, 14, 10, '#f1e5c8'); rect(x + 17, y + 19, 8, 2, '#a69c80');
        } else if (f.type === 'sofa') {
          // Draw one 64 × 32 sofa, then turn the whole sprite with its footprint.
          c.save();
          if (f.rotation === 1) { c.translate(x + W, y); c.rotate(Math.PI / 2); }
          else if (f.rotation === 2) { c.translate(x + W, y + H); c.rotate(Math.PI); }
          else if (f.rotation === 3) { c.translate(x, y + H); c.rotate(-Math.PI / 2); }
          else c.translate(x, y);
          rect(2, 2, 60, 28, '#344f49');
          rect(-2, -9, 68, 14, '#344f49'); rect(2, -7, 60, 9, '#769183');
          rect(8, 6, 48, 20, '#a4b39a'); rect(32, 8, 2, 16, '#6b8577');
          rect(2, 2, 8, 28, '#526e60'); rect(54, 2, 8, 28, '#526e60');
          rect(3, 4, 2, 24, '#769183'); rect(55, 4, 2, 24, '#769183');
          c.restore();
        } else {
          rect(x, y - 28, W, H + 24, '#3d5249'); rect(x + 3, y - 25, W - 6, H + 18, '#a5b3a0'); rect(x, y - 30, W, 5, '#d0c9a4');
        }
      },
      /** Palette icons are drawn with the scene's own painters, so they always match the room. */
      makeFurnitureIcons() {
        const icons = {}, PAD = 24;
        for (const type of Object.keys(LABELS)) {
          if (type === 'desk') continue;
          const f = {id: 'icon-' + type, type, x: 0, y: 0, rotation: 0}, {w, h} = type === 'window' ? {w: 2, h: 1.25} : E.size(f);
          const src = document.createElement('canvas'); src.width = w * 32 + PAD * 2; src.height = h * 32 + PAD * 2;
          const c = src.getContext('2d'); c.imageSmoothingEnabled = false; c.translate(PAD, PAD);
          if (type === 'window') this.paintWindow(c, 0, 0); else this.paintFurniture(c, f);
          // Crop to what was actually painted, then fit it into a square icon.
          const {data} = c.getImageData(0, 0, src.width, src.height);
          let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1;
          for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) if (data[(y * src.width + x) * 4 + 3] > 96) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
          if (x1 < 0) continue;
          const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = document.createElement('canvas'), SIZE = 48; out.width = out.height = SIZE;
          const scale = Math.min(SIZE / cw, SIZE / ch), o = out.getContext('2d'); o.imageSmoothingEnabled = cw > SIZE || ch > SIZE;
          o.drawImage(src, x0, y0, cw, ch, (SIZE - cw * scale) / 2, (SIZE - ch * scale) / 2, cw * scale, ch * scale);
          icons[type] = out.toDataURL();
        }
        return icons;
      },
      draw() {
        const canvas = this.$refs.canvas; if (!canvas) return;
        const layout = this.editing ? this.draft : this.layout;
        if (!layout) return;
        const w = layout.cols * 32, h = layout.rows * 32;
        if (this.worldHeight!==h) this.worldHeight=h;
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false;
        const rect = (x, y, w, h, color) => { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); };
        rect(0, 0, w, h, '#282c29');
        for (let y = 2; y < layout.rows - 1; y++) for (let x = 1; x < layout.cols - 1; x++) {
          const stone = layout.floor === 'stone';
          rect(x * 32, y * 32, 32, 32, stone ? ((x + y) % 2 ? '#6a7976' : '#74837e') : (y % 2 ? '#98744f' : '#a17c54'));
          rect(x * 32, y * 32 + 30, 32, 2, stone ? '#526460' : '#75573e');
          rect(x * 32 + (y % 2 ? 16 : 0), y * 32, 1, 30, stone ? '#61726b' : '#896647');
          if (!stone) rect(x * 32 + 4, y * 32 + 9, 12, 1, '#aa8358');
        }
        rect(20, 10, w - 40, 60, '#4c6054'); rect(20, 67, w - 40, 8, '#d1b17a'); rect(20, 75, w - 40, 5, '#5c4735');
        rect(24, h - 32, w - 48, 7, '#d1b17a'); rect(24, 78, 8, h - 110, '#d1b17a'); rect(w - 32, 78, 8, h - 110, '#d1b17a');
        layout.furniture.filter(f=>f.type==='window').forEach(f => this.paintWindow(c, f.x * 32, 20));
        // Recess the doorway into the wall; its sill meets the wall/floor seam at y=80.
        // Cover the skirting inside the opening so it cannot run behind the door.
        rect(62, 16, 68, 64, '#293d35');
        rect(62, 16, 68, 5, '#bfa67f');
        rect(62, 21, 5, 59, '#9c8665'); rect(125, 21, 5, 59, '#9c8665');
        rect(68, 22, 56, 54, '#b49469'); rect(68, 22, 3, 54, '#806b50');
        rect(75, 27, 42, 26, '#78a3ac'); rect(78, 30, 3, 20, '#b8d6d0');
        rect(75, 57, 42, 2, '#947953'); rect(115, 62, 5, 4, '#f3d699');
        rect(67, 76, 58, 4, '#d6bc91'); rect(67, 80, 58, 2, '#574a38');
        const drawSprite = (a, look) => {
          const x = Math.round((a.x + .5) * 32 - 32), y = Math.round((a.y + 1) * 32 - 59);
          rect(x + 22, y + 54, 22, 5, '#483e3655');
          if (!this.ready) { rect(x + 24, y + 15, 16, 30, '#d8c498'); return; }
          const moving = !!a.next && !this.editing && !this.reducedMotion;
          SPRITES.paint(c, look, a.direction || 0, moving ? Math.floor(this.sim.time * 8) % 6 : 0, x, y);
          if (a.mode === 'working') {
            const beat = this.reducedMotion ? 0 : Math.floor(this.sim.time * 5) % 2 * 2;
            rect(x + 20, y + 39 + beat, 5, 4, '#ebc2a2'); rect(x + 41, y + 41 - beat, 5, 4, '#ebc2a2');
          }
        };
        const chairs = {
          office: (x, y) => { rect(x+5, y+4, 24, 23, '#59796b'); rect(x+8, y+3, 18, 4, '#92a389'); },
          // High-back leather executive chair with brass studs.
          executive: (x, y) => {
            rect(x + 4, y - 12, 24, 36, '#3a1c15'); rect(x + 6, y - 10, 20, 32, '#6b2f24'); rect(x + 8, y - 8, 16, 2, '#8c4a36');
            for (const sx of [7, 15, 23]) rect(x + sx, y - 9, 2, 2, '#d8b25a');
            rect(x + 2, y + 14, 28, 9, '#4a241b'); rect(x + 14, y + 23, 4, 6, '#262626'); rect(x + 8, y + 28, 16, 3, '#262626');
          },
        };
        const drawFurniture = f => this.paintFurniture(c, f);
        layout.furniture.filter(f => E.FLOORING.includes(f.type)).forEach(drawFurniture);
        // A role's chair only exists with its desk; the PM's fallback seat has none.
        const roleSeats = E.rolePositions(layout).map(p => ({...p, desk: layout.furniture.find(f => f.type === R.ROLES[p.role].deskType)}));
        roleSeats.forEach(p => { if (p.desk) chairs[R.ROLES[p.role].chair](p.x * 32, p.y * 32); });
        // Seats sit behind the people. Furniture and characters sort by their feet.
        layout.furniture.filter(f => f.type === 'desk').forEach(f => {
          const p = E.seat(f), x = p.x * 32 + 4, y = p.y * 32;
          rect(x + 4, y + 13, 18, 13, '#3d524c'); rect(x + 1, y + (f.facing==='south'?14:1), 24, 14, '#59796b'); rect(x + 4, y + (f.facing==='south'?25:2), 18, 3, '#92a389');
        });
        const items = layout.furniture.filter(f => ![...E.FLOORING,'window'].includes(f.type)).map(f => ({depth: (f.y + E.size(f).h) * 32, draw: () => drawFurniture(f)}));
        roleSeats.forEach(p => items.push({depth: (p.y+1)*32, draw: () => drawSprite({...p, direction: p.desk?.rotation ? 1 : 0}, R.roleLook(this.shownRoles, p.role))}));
        this.sim.agents.forEach(a => items.push({depth: (a.y + 1) * 32, draw: () => drawSprite(a, this.lookOf('eng:' + a.id))}));
        items.sort((a, b) => a.depth - b.depth).forEach(item => item.draw());
        if (this.editing) {
          c.strokeStyle = '#fff3'; c.lineWidth = 1;
          for (let x = 1; x < layout.cols; x++) { c.beginPath(); c.moveTo(x * 32 + .5, 80); c.lineTo(x * 32 + .5, h - 32); c.stroke(); }
          for (let y = 3; y < layout.rows; y++) { c.beginPath(); c.moveTo(32, y * 32 + .5); c.lineTo(w - 32, y * 32 + .5); c.stroke(); }
          if (this.chosen) {
            const f = this.chosen, s = E.size(f); c.strokeStyle = '#ffe4a3'; c.lineWidth = 3; c.strokeRect(f.x * 32 + 1, f.y * 32 + 1, s.w * 32 - 2, s.h * 32 - 2);
          }
          this.drawLookPreview();
        }
      }
    },
    template: `
      <div class="scene-shell" :class="{'is-editing':editing}">
        <div class="scene-toolbar">
          <span v-if="editing" class="scene-editing-badge">編輯中</span>
          <span class="scene-location" :title="displayName">{{displayName}} <small>協作辦公室</small></span>
          <time class="scene-clock" :datetime="clockNow.toISOString()" :aria-label="clockDate+' '+clockText+'，裝置本地時間'" title="裝置本地時間">
            <span class="scene-clock-date">{{clockDate}}</span><span class="scene-clock-time">{{clockText}}</span>
          </time>
          <!-- Scene look is a viewing preference; tuck it away so editing shows only edit actions. -->
          <template v-if="!editing">
          <div class="scene-theme-switch" role="group" aria-label="背景場景">
            <button type="button" :aria-pressed="sceneTheme==='forest'" @click="sceneTheme='forest';saveAmbience()"><span aria-hidden="true">♧</span> 森林</button>
            <button type="button" :aria-pressed="sceneTheme==='city'" @click="sceneTheme='city';saveAmbience()"><span aria-hidden="true">▥</span> 都市</button>
          </div>
          <label class="ambience-select">光影 <select aria-label="場景時段" v-model="ambienceMode" @change="saveAmbience"><option value="auto">跟隨時間</option><option value="morning">早晨</option><option value="noon">中午</option><option value="sunset">日落</option><option value="night">晚上</option></select></label>
          <label class="ambience-motion"><input type="checkbox" v-model="ambienceMotion" @change="saveAmbience" />動態</label>
          </template>
          <button v-if="!editing" class="scene-btn" @click="beginEdit">編輯辦公室</button>
          <span v-else class="scene-edit-actions"><button class="scene-btn" @click="cancelEdit">取消</button><button class="scene-btn primary" @click="saveEdit">儲存配置</button></span>
        </div>
        <div class="scene-stage" :class="{editing}">
          <div v-if="editing" class="scene-edit-panel">
            <div class="scene-editor-tabs" role="tablist" aria-label="編輯項目">
              <button v-for="t in editTabs" :key="t[0]" type="button" role="tab" :id="'scene-tab-'+t[0]" :aria-selected="editTab===t[0]" aria-controls="scene-editor-panel" @click="editTab=t[0]">{{t[1]}}</button>
            </div>
            <div id="scene-editor-panel" class="scene-editor" role="tabpanel" :aria-labelledby="'scene-tab-'+editTab">
              <template v-if="editTab==='layout'">
                <div class="scene-palette" role="group" aria-label="家具工具">
                  <button class="scene-btn palette-select" :aria-pressed="tool==='select'" @click="tool='select'">選取／移動</button>
                  <div v-for="group in furnitureGroups" :key="group.name" class="palette-group" role="group" :aria-label="group.name">
                    <span class="palette-group-name" aria-hidden="true">{{group.name}}</span>
                    <button v-for="entry in group.tools" :key="entry[0]" class="scene-btn palette-item" :aria-pressed="tool===entry[0]" @click="tool=entry[0];selectedFurniture=''"><img v-if="furnitureIcons[entry[0]]" :src="furnitureIcons[entry[0]]" alt="" width="24" height="24" />{{entry[1]}}</button>
                  </div>
                </div>
                <div class="scene-tools"><label>地板 <select :value="draft.floor" @change="setFloor($event.target.value)"><option value="wood">木地板</option><option value="stone">石磚</option></select></label>
                  <label>家具 <select v-model="selectedFurniture" @change="tool='select'"><option value="">選取家具</option><option v-for="f in draft.furniture" :key="f.id" :value="f.id">{{furnitureName(f)}} ({{f.x}},{{f.y}})</option></select></label>
                  <button class="scene-btn" @click="resetDraft">預設配置</button>
                </div>
                <p>窗戶放在上方牆面，避開入口；沙發可轉四個朝向。角色暫停，任務持續執行。配置只存在此瀏覽器。</p>
              </template>
              <template v-else-if="editTab==='looks'">
                <div class="scene-tools scene-looks" role="group" aria-label="角色外觀">
                  <label>角色 <select v-model="lookTarget"><option value="">選擇角色</option><option v-for="t in lookTargets" :key="t.key" :value="t.key">{{t.name}}</option></select></label>
                  <template v-if="currentLook">
                    <canvas ref="lookPreview" class="look-preview" width="256" height="64" :aria-label="currentLookName+' 的外觀預覽：正面、右側、背面、左側'"></canvas>
                    <label>膚色 <select :value="currentLook.skin" @change="setLook({skin:+$event.target.value})"><option v-for="n in lookOptions.skins" :key="n" :value="n-1">{{n}}</option></select></label>
                    <label>髮型 <select :value="currentLook.hair" @change="setLook({hair:+$event.target.value})"><option v-for="n in lookOptions.hairs" :key="n" :value="n-1">{{n}}</option></select></label>
                    <label>服裝 <select :value="currentLook.outfit" @change="setLook({outfit:+$event.target.value})"><option v-for="(o,i) in lookOptions.outfits" :key="o" :value="o">款式 {{i+1}}</option></select></label>
                    <label>髮色 <select :value="currentLook.hairColor" @change="setLook({hairColor:$event.target.value})"><option v-for="c in lookOptions.hairColors" :key="c[0]" :value="c[0]">{{c[1].label}}</option></select></label>
                    <span class="look-accessories">配件 <label v-for="a in lookOptions.accessories" :key="a[0]"><input type="checkbox" :checked="currentLook.accessories.includes(a[0])" @change="toggleAccessory(a[0],$event.target.checked)" />{{a[1]}}</label></span>
                    <button class="scene-btn" @click="shuffleLook">隨機</button><button class="scene-btn" @click="resetLook">恢復預設</button>
                  </template>
                </div>
                <p>外觀存到伺服器，所有人都看得到。</p>
              </template>
              <template v-else>
                <div class="scene-tools"><label>辦公室名稱 <input v-model="draft.name" maxlength="30" placeholder="THE BUILDERS GUILD" /></label>
                  <label v-for="(role,id) in roleDefaults" :key="id">{{role.name}} 名稱 <input v-model="draftRoles[id].name" :maxlength="nameMax" :placeholder="role.name" /></label></div>
                <p>辦公室名稱存在此瀏覽器；角色名稱存到伺服器，所有人都看得到。</p>
              </template>
            </div>
            <div class="scene-selection" :class="{active:chosen||tool!=='select'}" role="group" aria-label="選取的家具">
              <template v-if="chosen">
                <span class="scene-selection-label">已選取 <b>{{chosenName}}</b> <small>點目的格或用方向鍵移動</small></span>
                <button class="scene-btn" :disabled="chosen.type==='window'" @click="rotate(-1)">左轉 <kbd>Q</kbd></button>
                <button class="scene-btn" :disabled="chosen.type==='window'" @click="rotate(1)">右轉 <kbd>R</kbd></button>
                <button class="scene-btn danger" :disabled="chosen.type==='desk'" :title="chosen.type==='desk'?'工程師的工作桌需保留，可移動或旋轉':''" @click="remove">刪除 <kbd>Del</kbd></button>
                <button class="scene-btn" @click="selectedFurniture=''">取消選取 <kbd>Esc</kbd></button>
              </template>
              <template v-else-if="tool!=='select'">
                <span class="scene-selection-label">放置 <b>{{furnitureName({type:tool})}}</b> <small>點地板放置</small></span>
                <button class="scene-btn" @click="tool='select'">結束放置 <kbd>Esc</kbd></button>
              </template>
              <span v-else class="scene-selection-label"><small>點選場景中的家具即可移動、旋轉或刪除</small></span>
              <button class="scene-btn scene-undo" :disabled="!undoStack.length" @click="undo">復原</button>
            </div>
          </div>
          <div class="scene-canvas-col">
            <div v-if="loadError" class="scene-feedback error" role="alert">人物素材載入失敗，請確認素材路徑並重新整理。</div>
            <div ref="viewport" class="scene-viewport" :class="{editing,'ambience-animated':ambienceAnimated}" :data-period="ambiencePeriod" :data-scene="sceneTheme">
              <div class="courtyard-atmosphere" aria-hidden="true">
                <div v-for="period in ['morning','noon','sunset','night']" :key="period" class="ambience-light" :class="'light-'+period" :style="{opacity:ambiencePeriod===period?1:0}"></div>
                <div class="courtyard-mist"></div><div class="courtyard-shadows"></div>
                <svg v-if="sceneTheme==='city'" class="courtyard-lights" viewBox="0 0 1440 600" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="courtyard-lamp-glow"><stop stop-color="#ffe2a0" stop-opacity=".72"/><stop offset="1" stop-color="#ffc66d" stop-opacity="0"/></radialGradient></defs><circle cx="212" cy="389" r="64" fill="url(#courtyard-lamp-glow)"/><circle cx="1058" cy="389" r="64" fill="url(#courtyard-lamp-glow)"/><path fill="#ffe9b2" d="M202 386h21v6h-21zM1048 386h21v6h-21z"/></svg>
                <i v-for="n in (sceneTheme==='forest' ? 8 : 0)" :key="n" class="courtyard-firefly" :style="{left:(n<=4?5+n*4:76+(n-4)*4)+'%',top:(22+(n*13)%59)+'%',animationDelay:(-n*2.7)+'s',animationDuration:(16+n*1.3)+'s'}"></i>
              </div>
              <div class="scene-world" :class="{'compact-world':sceneScale<.8}" :style="{width:640*sceneScale+'px',height:worldHeight*sceneScale+'px'}">
              <canvas ref="canvas" width="640" height="448" tabindex="0" @click="clickScene" @keydown="keyScene" aria-label="像素辦公室。可點選人物或工作桌。編輯時選取家具後用方向鍵移動。"></canvas>
              <div class="world-sign" :style="{left:64*sceneScale+'px',top:4*sceneScale+'px',width:64*sceneScale+'px',height:18*sceneScale+'px'}" aria-hidden="true"><b>入口</b></div>
              <span v-for="seat in roleSeats" :key="seat.role" class="world-role-name" :style="{left:(seat.x+.5)*32*sceneScale+'px',top:((seat.y+1)*32+7)*sceneScale+'px',color:seat.color||null}" aria-hidden="true">{{seat.name}}</span>
              <div v-for="label in labels" :key="label.id" class="world-label" :style="{left:label.x*sceneScale+'px',top:label.y*sceneScale+'px','--agent-color':label.color,'--task-offset':80*sceneScale+'px'}" aria-hidden="true"><span class="world-name">{{label.name}}</span><span v-if="taskBadges[label.id]" class="world-task-status" :class="[taskBadges[label.id].kind, {'is-paused': !connected || editing || !visible}]" :title="label.task || taskBadges[label.id].text"><span class="task-status-icon">{{taskBadges[label.id].icon}}</span>{{taskBadges[label.id].text}}</span></div>
              </div>
            </div>
          </div>
        </div>
        <div v-if="fishGameOpen" class="fish-game-backdrop" role="presentation" @click.self="closeFishGame">
          <section ref="fishGame" class="fish-game" role="dialog" aria-modal="true" aria-labelledby="fish-game-title" tabindex="-1" @keydown.esc="closeFishGame">
            <header class="fish-game-head"><div><span>LITTLE AQUATIC GARDEN</span><h2 id="fish-game-title">魚蝦的水中花園</h2></div><button type="button" @click="closeFishGame" aria-label="關閉水族箱">×</button></header>
            <p class="fish-care-guide">每天記得來餵食！飽足感每天下降 50 點，歸零會死亡。<br>點水面投飼料，每口恢復 25 點；蝦子會吃沉到底部的飼料。</p>
            <button type="button" class="fish-tank" @click="dropFishFood" aria-label="水族箱：點擊或按 Enter、空白鍵投下飼料">
              <span class="fish-tank-floor" aria-hidden="true"></span>
              <span v-for="n in 3" :key="'plant'+n" class="aquatic-plant" :class="'plant-'+n" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="aquatic-rock rock-one" aria-hidden="true"></span><span class="aquatic-rock rock-two" aria-hidden="true"></span><span class="aquatic-wood" aria-hidden="true"></span><span class="aquatic-moss" aria-hidden="true"></span>
              <i v-for="food in fishFood" :key="food.id" class="fish-food" :style="{left:food.x+'%',top:food.y+'%'}"></i>
              <i v-for="fish in fishSchool" :key="fish.id" class="game-fish" :class="{'faces-left':fish.direction<0,'game-shrimp':fish.kind==='shrimp','is-dead':fish.dead}" :style="{left:fish.x+'%',top:fish.y+'%','--fish-color':fish.color}"><span></span></i>
            </button>
            <div class="fish-health-list"><div v-for="fish in fishSchool" :key="fish.id" class="fish-health" :class="{'is-hungry':fish.satiety<30}"><span>{{fish.name}}</span><meter min="0" max="100" low="30" high="70" optimum="100" :value="fish.satiety" :aria-label="fish.name+'飽足感'"></meter><b>{{fish.dead ? '已死亡' : Math.ceil(fish.satiety)+'%'}}</b></div></div>
            <p class="fish-care-note">飽足感低於 30% 時記得補充飼料。關閉頁面後也會繼續消耗；死亡的魚蝦會漂在水面，無法再餵食。</p>
            <p v-if="fishStorageError" class="fish-care-note" role="alert">瀏覽器無法儲存，目前的飼養進度可能在重新整理後遺失。</p>
          </section>
        </div>
      </div>`
  };
})();

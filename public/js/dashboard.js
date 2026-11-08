const { createApp, reactive, ref, computed, watch, nextTick } = Vue;
const { PixelAgent, toolIcon, toolSummary, stripAnsi } = window.DashboardUI;

createApp({
  components: { PixelAgent, OfficeScene: window.OfficeScene },
  setup(){
    const socket = io();
    const engineerAction=ref(null),actionBusy=ref(false),actionResult=ref(''),actionError=ref(''),actionBase=ref('');
    const resultTab=ref('report'),resultReport=ref(''),reportMock=ref(false),actionOverview=ref(null),deliveryInfo=ref(null),draftKind=ref('commit'),drafts=reactive({commit:'',mr:''}),draftMocks=reactive({commit:false,mr:false});
    const jevReview=ref(null),jevLoading=ref(false),jevError=ref('');
    const showResultFeedback=ref(false),acceptConfirm=ref(false);
    function openEngineerAction(){const t=currentTask.value;if(!t)return;engineerAction.value={id:t.engineerId,name:t.engineerName,key:t.key,summary:t.summary,cardId:t.cardId};resultTab.value='report';resultReport.value=t.resultReport||`- ${t.resultSummary||'這個舊任務沒有自動成果報告。'}`;reportMock.value=!!t.resultReportMock;actionOverview.value=null;deliveryInfo.value=null;jevReview.value=null;jevError.value='';drafts.commit='';drafts.mr='';draftKind.value='commit';actionError.value=t.resultReportError||'';actionResult.value='';actionBase.value=t.automation?.baseBranch||'develop';showResultFeedback.value=false;acceptConfirm.value=false;}
    async function runJevReview(){const key=engineerAction.value?.key;if(!key||jevLoading.value)return;jevLoading.value=true;jevError.value='';jevReview.value=null;try{const r=await fetch('/api/tasks/'+encodeURIComponent(key)+'/jev-review',{method:'POST'});const d=await r.json();if(!r.ok)throw Error(d.error||'Jev 檢查失敗');jevReview.value=d;}catch(e){jevError.value=e.message;}finally{jevLoading.value=false;}}
    function selectResultTab(id){resultTab.value=id;actionError.value='';if(id==='changes'&&!actionOverview.value)runEngineerAction('overview');}
    async function submitResultFeedback(){const key=engineerAction.value?.key;if(key && await sendFeedback(key)){engineerAction.value=null;showResultFeedback.value=false;}}
    async function confirmResultAcceptance(){const key=engineerAction.value?.key;if(key && await acceptTask(key)){engineerAction.value=null;acceptConfirm.value=false;}}
    async function runEngineerAction(kind){
      const a=engineerAction.value;if(!a||actionBusy.value)return;actionBusy.value=true;actionError.value='';actionResult.value='';
      if(kind==='report'){resultReport.value='';reportMock.value=false;}if(kind==='overview')actionOverview.value=null;if(kind==='delivery')deliveryInfo.value=null;
      try{const r=await fetch('/api/engineers/'+encodeURIComponent(a.id)+'/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,key:a.key,baseBranch:actionBase.value.trim(),remote:'origin',message:kind==='commit-now'?drafts.commit:''})});const d=await r.json();if(!r.ok)throw Error(d.error||'操作失敗');
        if(kind==='report'){resultReport.value=d.text;reportMock.value=!!d.mock;}else if(kind==='overview')actionOverview.value=d;else if(kind==='delivery')deliveryInfo.value=d;else if(kind==='commit'||kind==='mr'){drafts[kind]=d.text;draftMocks[kind]=!!d.mock;}else{actionResult.value=d.text;actionOverview.value=null;deliveryInfo.value=null;delete review[a.key];}
      }catch(e){actionError.value=e.message;}finally{actionBusy.value=false;}
    }
    async function copyActionResult(){try{await navigator.clipboard.writeText(drafts[draftKind.value]);toast('草稿已複製');}catch{actionError.value='無法使用剪貼簿，請選取文字手動複製。';}}
    // 工程師提問（AskUserQuestion）的作答草稿：approvalId → 問題全文 → {picked, other}
    const questionDrafts=reactive({});
    const pendingApprovals=ref([]), approvalSending=ref(false), branchMode=ref('auto'), branchName=ref('');
    socket.on('approvals:update',items=>{for(const it of items)if(it.kind==='question' && !questionDrafts[it.id])questionDrafts[it.id]=Object.fromEntries(it.questions.map(q=>[q.question,{picked:[],other:''}]));pendingApprovals.value=items;});
    socket.on('task:requeued',({key})=>{tasks.value=tasks.value.filter(t=>t.key!==key || t.status==='running');delete review[key];});
    // 草稿在 approvals:update 收到問題時就建好，畫面渲染時只讀不建。
    const NO_DRAFT={picked:[],other:''};
    // 提問只顯示在該任務的對話視窗；彈窗只留給工具／Git 核准
    const toolApprovals=computed(()=>pendingApprovals.value.filter(a=>a.kind!=='question'));
    const questionsFor=cardId=>pendingApprovals.value.filter(a=>a.kind==='question' && a.cardId===cardId);
    const engineerHasQuestion=engId=>pendingApprovals.value.some(a=>a.kind==='question' && tasks.value.some(t=>t.cardId===a.cardId && t.engineerId===engId));
    const questionDraft=(item,q)=>questionDrafts[item.id]?.[q.question] || NO_DRAFT;
    const questionPicked=(item,q,label)=>questionDraft(item,q).picked.includes(label);
    function toggleQuestionOption(item,q,label){
      const d=questionDraft(item,q);if(d===NO_DRAFT)return;
      if(!q.multiSelect){d.picked=d.picked[0]===label?[]:[label];return;}
      d.picked=d.picked.includes(label)?d.picked.filter(l=>l!==label):[...d.picked,label];
    }
    const questionReady=item=>(item.questions||[]).every(q=>{const d=questionDraft(item,q);return d.picked.length || d.other.trim();});
    async function postApproval(item,body,done){
      approvalSending.value=true;
      try{const r=await fetch('/api/approvals/'+item.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'問題已逾時或由其他視窗處理');delete questionDrafts[item.id];toast(done);}
      catch(e){toast(e.message,'error');}finally{approvalSending.value=false;}
    }
    const answerQuestion=item=>postApproval(item,{answers:questionDrafts[item.id]||{}},'已送出回答，工程師繼續工作');
    const skipQuestion=item=>postApproval(item,{approved:false},'已略過，工程師會自行判斷');
    async function decideApproval(approved){
      const item=toolApprovals.value[0];if(!item)return;
      approvalSending.value=true;
      try{const r=await fetch('/api/approvals/'+item.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approved})});if(!r.ok)throw Error('確認已逾時或由其他視窗處理');}catch(e){toast(e.message,'error');}finally{approvalSending.value=false;}
    }
    // socket.io 的連線是非同步的，開場那幾十毫秒其實是「還沒連上」，不是「斷線」。
    // 兩者都塞進 connected=false 的話，每次重整都會先閃一下錯誤狀態才轉正常。
    const connectState = ref('connecting'); // connecting | online | offline
    const connected = computed(() => connectState.value === 'online');
    const connectLabel = computed(() => ({connecting:'連線中…', online:'已連線', offline:'連線中斷'})[connectState.value]);
    const connectPill = computed(() => ({connecting:'warn', online:'ok', offline:'off'})[connectState.value]);

    const engineers = reactive({});
    const sys = reactive({ modules:{}, jiraMode:'', claudeMode:'', aiProvider:'claude', aiMode:'' });
    const projects = ref([]);
    const locks = ref({});          // projectId -> {engineerName, taskKey}
    const board = ref([]);
    const tasks = ref([]);
    const logs = reactive({});        // cardId -> [事件]
    const opened = reactive({});      // ev.seq -> 是否展開（思考 / 工具 / 結果）
    const dropped = reactive({});     // cardId -> 因為超過上限而沒載入的筆數
    const eventsLoaded = reactive({}); // cardId -> 是否已經從 API 補撈過
    const stopAsk = ref(null);        // 正在確認中止的 cardId
    const stopping = ref(false);
    // 驗收
    const review = reactive({});         // key -> { isRepo, branch, dirty[], stat, canFeedback }
    const reviewLoading = reactive({});  // key -> 正在讀
    const fbText = reactive({});         // key -> 回饋草稿
    const fbSending = ref(false);
    const accepting = ref(false);
    const dirtyInfo = ref(null);         // 指派時工作區不乾淨的資訊
    // 模型清單（claude CLI 沒有列出模型的指令，所以由後端湊：別名 + Models API + 跑過的）
    const modelInfo = reactive({ aliases: [], models: null, seen: [], error: '', note: '' });
    const autoscroll = reactive({});
    // 分頁：每位工程師一個
    const activeTab = ref(null);
    const mainView = ref('studio');
    const layoutQuery = window.matchMedia('(max-width:959px)');
    const compactLayout = ref(layoutQuery.matches);
    const syncLayout = () => { compactLayout.value = layoutQuery.matches; };
    layoutQuery.addEventListener('change', syncLayout);
    Vue.onBeforeUnmount(() => layoutQuery.removeEventListener('change', syncLayout));
    const overviewFilter = ref(null);
    // 檢查成果的分頁；選配模組沒啟用就不出現，編號跟著重排。
    const resultTabs = computed(() => [
      {id:'report',label:'成果報告'},{id:'changes',label:'變更與紀錄'},
      ...(sys.modules.jev ? [{id:'jev',label:'Jev 小助手'}] : []),
      {id:'delivery',label:'交付'},
    ].map((t,i) => ({...t,label:`${i+1}. ${t.label}`})));
    watch(() => sys.modules.jev, on => { if (!on && resultTab.value === 'jev') resultTab.value = 'report'; });
    // 任務卡片依接取來源過濾，跟待指派看板同一套規則：mock 的示範單不該出現在
    // 正式模式的監看裡。來源不明的舊任務一律保留（理由同看板：不用猜的藏資料）。
    // tasks 本身保留全量 —— 事件是用 cardId 去找卡片改狀態的，過濾掉就對不上了。
    const visibleTasks = computed(() => tasks.value.filter(t => !t.source || !sys.jiraMode || t.source === sys.jiraMode));
    const overviewTasks = computed(()=>visibleTasks.value.filter(t=>overviewFilter.value==='failed' ? REQUEUEABLE.includes(t.status) : t.status===overviewFilter.value));
    function openOverviewTask(t){selectCard[t.engineerId]=t.cardId;inspectEngineer(t.engineerId);overviewFilter.value=null;}
    const reviewCount = computed(() => visibleTasks.value.filter(t=>t.status==='done').length);
    function inspectEngineer(id){ mainView.value='tasks'; switchTab(id); }
    const selectCard = reactive({});   // engineerId -> 目前檢視的 cardId
    const unread = reactive({});       // engineerId -> 有新輸出但不在該分頁
    const pmLogs = ref([]);
    // PM / BOSS 的名稱與外觀（config/roles.json），辦公室場景與 PM 回報共用
    const roles = ref({});
    const pmName = computed(() => window.OfficeRoles.roleName(roles.value, 'pm'));
    const now = ref(Date.now());
    const termRefs = {};
    const pmScroll = ref(null);
    const toasts = ref([]);
    let toastId = 0;

    // 設定
    const showSettings = ref(false);
    const setTab = ref('runtime');
    const draftProjects = ref([]);
    const draftEngineers = ref([]);
    const draftAi = reactive({provider:'claude'});
    // 執行期模式（mock / real / auto）。modesInfo 保留伺服器回報的可選值、
    // env 預設值與 Jira 憑證缺漏，讓畫面能解釋「為什麼不能選 real」。
    const draftModes = reactive({mode:'mock',accessMode:'auto',jiraBoardId:'',jev:'off'});
    const modesInfo = reactive({values:{},defaults:{},overridden:{},effective:{}});
    const aiLoading = ref(false);
    const aiReady = ref(false);
    const setErr = ref('');
    const setSaving = ref(false);

    // 指定單號
    const showByKey = ref(false);
    const keyText = ref('');
    const keyInput = ref(null);
    const byKeyLoading = ref(false);
    const byKeyErr = ref('');
    const byKeyMissing = ref([]);

    // 接取 modal
    const showClaim = ref(false);
    const loadingJira = ref(false);
    const jiraTasks = ref([]);
    const jiraFetchedAt = ref(0);
    const jiraSprint = ref(null);
    const taskStatusLabel = TaskStatus.label;
    const {REQUEUEABLE, ARCHIVABLE, FINISHED, RESETTABLE} = TaskStatus;
    const jiraError = ref('');
    const jql = ref('');
    const selected = ref(new Set());
    const claiming = ref(false);
    const mcpLog = ref([]);
    const mcpBox = ref(null);

    // 指派 modal
    const confirmKey = ref(null);   // 刊版上正在確認放棄的任務
    const assignTarget = ref(null);
    const pickedEng = ref(null);
    const pickedProject = ref(null);
    const assigning = ref(false);

    /* ---------- computed ---------- */
    const engineerList = computed(() => Object.values(engineers).sort((a,b)=>a.id.localeCompare(b.id)));
    const idleCount    = computed(() => engineerList.value.filter(e=>e.status==='idle').length);
    const runningCount = computed(() => visibleTasks.value.filter(t=>t.status==='running').length);
    const finishedCount= computed(() => visibleTasks.value.filter(t=>REQUEUEABLE.includes(t.status)||ARCHIVABLE.includes(t.status)).length);
    /* ---------- 分頁 ---------- */
    // 沒手動選過時，預設顯示第一個正在執行的工程師，否則第一位
    const effectiveTab = computed(() => {
      if (activeTab.value && engineers[activeTab.value]) return activeTab.value;
      const list = engineerList.value;
      const busy = list.find(e => e.status === 'working');
      return (busy || list[0] || {}).id || null;
    });
    const tabEngineerName = computed(() => {
      const e = engineers[effectiveTab.value];
      return e ? e.name : '這位工程師';
    });
    // 任務監看只顯示工程師目前執行中或等待驗收的單，不保留結束紀錄。
    const monitorTasks = id => visibleTasks.value.filter(t => t.engineerId === id && (t.status === 'running' || FINISHED.includes(t.status)));
    const currentTask = computed(() => {
      const list = monitorTasks(effectiveTab.value);
      if (!list.length) return null;
      const picked = list.find(t => t.cardId === selectCard[effectiveTab.value]);
      return picked || list[0];
    });
    const resultTask = computed(() => tasks.value.find(t => t.cardId === engineerAction.value?.cardId && t.key === engineerAction.value?.key) || null);
    function tasksOf(id){ return monitorTasks(id); }
    function tabState(id){
      const t = tasksOf(id)[0];
      return t ? t.status : 'idle';
    }
    function tabSub(id){
      const e = engineers[id];
      if (e && e.status === 'working' && e.task) return e.task.key;
      const t = tasksOf(id)[0];
      if (t) return t.status === 'done' ? '待驗收' : t.key;
      return '待命中';
    }
    function switchTab(id){
      activeTab.value = id;
      unread[id] = false;
      // 切過去時 DOM 是新的，把 Terminal 捲到最新
      nextTick(()=>{
        const t = currentTask.value;
        if (t && autoscroll[t.cardId] !== false){
          const el = termRefs[t.cardId];
          if (el) el.scrollTop = el.scrollHeight;
        }
      });
    }

    // 別名優先（永遠指向最新），再接真實清單，最後接實跑看到過的
    const modelOptions = computed(() => {
      const out = [], seen = new Set();
      const add = (value, label) => {
        const v = String(value || '').trim();
        if (!v || seen.has(v)) return;
        seen.add(v); out.push({ value: v, label: label || v });
      };
      for (const a of modelInfo.aliases || []) add(a.value, a.label + (a.hint ? ' — ' + a.hint : ''));
      for (const m of modelInfo.models || []) add(m.id, m.displayName);
      for (const id of modelInfo.seen || []) add(id, id + '（跑過）');
      return out;
    });
    const anyLocked    = computed(() => Object.keys(locks.value).length > 0);
    // 分支前綴跟著目前選的 AI 平台走（claude / codex）
    const BRANCH_PREFIX = { claude:'claude', codex:'codex' };
    const defaultBranchName = computed(() => {
      const prefix = BRANCH_PREFIX[sys.aiProvider] || 'ai';
      return assignTarget.value ? prefix + '/' + assignTarget.value.key : '';
    });
    // 使用者沒手改過分支名稱時，切換 AI 平台要跟著換預設值
    watch(defaultBranchName, (next, prev) => {
      if (!next) return;
      if (!branchName.value || branchName.value === prev) branchName.value = next;
    });
    // 有專案清單時必須選一個沒被鎖的；沒設定專案則允許用預設工作目錄
    const canAssign    = computed(() => {
      if (!pickedEng.value) return false;
      if (projects.value.length === 0) return true;
      return !!pickedProject.value && !locks.value[pickedProject.value];
    });

    /* ---------- helpers ---------- */
    // 工程師不分類型，配色改依名單順序輪替
    const PALETTE = ['#5aa9ff', '#3ecf8e', '#b47cff', '#ffb454', '#ff8fa3', '#5ee0d0'];
    function idxOf(id){ return Math.max(0, engineerList.value.findIndex(e => e.id === id)); }
    function engColor(id){ return PALETTE[idxOf(id) % PALETTE.length]; }
    // 依人數把座位平均分配在 640px 舞台上
    function fmtTime(ts){ return new Date(ts).toLocaleTimeString('zh-Hant',{hour12:false}); }
    function logIcon(l){ return {info:'ℹ️',success:'✅',warn:'⚠️',error:'⛔'}[l] || 'ℹ️'; }
    function elapsed(t){
      const end = t.finishedAt || now.value;
      const s = Math.max(0, Math.floor((end - t.startedAt)/1000));
      return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
    }
    function ago(ts){
      if(!ts) return '—';
      const s = Math.max(0, Math.floor((now.value - ts)/1000));
      if (s < 60) return s+' 秒前';
      if (s < 3600) return Math.floor(s/60)+' 分鐘前';
      if (s < 86400) return Math.floor(s/3600)+' 小時前';
      return Math.floor(s/86400)+' 天前';
    }
    function toast(msg, type='success'){
      const id = ++toastId;
      // 同一句話重複出現（例如連點到不能放家具的格子）只留最新一則，重新計時，不要疊成一排。
      toasts.value = [...toasts.value.filter(t => t.msg !== msg || t.type !== type), { id, msg, type }];
      setTimeout(()=>{ toasts.value = toasts.value.filter(t=>t.id!==id); }, 3200);
    }

    /* ---------- terminal ---------- */
    /**
     * 收一個對話事件。事件自己帶 cardId（回放時一次會拿到同一張單多次執行的事件），
     * 所以一律看 ev.cardId，不要用外層信封的。
     */
    function pushEvent(ev){
      if (!ev || !ev.cardId) return;
      const list = logs[ev.cardId] || (logs[ev.cardId] = []);

      // 回放與即時推送可能重疊，用 seq 去重
      if (list.length && ev.seq <= list[list.length-1].seq){
        if (list.some(x => x.seq === ev.seq)) return;
      }
      if (ev.kind === 'raw') ev = { ...ev, text: stripAnsi(ev.text) };
      list.push(ev);
      if (list.length > 4000) list.splice(0, list.length - 4000);

      if (autoscroll[ev.cardId] !== false){
        nextTick(()=>{ const el = termRefs[ev.cardId]; if (el) el.scrollTop = el.scrollHeight; });
      }
    }

    /** 一次灌入一批事件（重新連線回放、或事後回看已完成的單） */
    function loadEvents(cardId, events, droppedCount){
      if (droppedCount) dropped[cardId] = droppedCount;
      for (const ev of events || []) pushEvent(ev);
    }

    /** 從 API 補撈某張單的對話（已完成的單重整後仍看得到） */
    async function fetchEvents(key, cardId){
      if (!key || eventsLoaded[cardId]) return;
      eventsLoaded[cardId] = true;
      try{
        const r = await fetch('/api/tasks/' + encodeURIComponent(key) + '/events');
        const d = await r.json();
        loadEvents(cardId, d.events, d.dropped);
      }catch(_){ eventsLoaded[cardId] = false; }
    }
    function onTermScroll(cardId, ev){
      const el = ev.target;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      autoscroll[cardId] = atBottom;
    }
    function jumpBottom(cardId){
      autoscroll[cardId] = true;
      const el = termRefs[cardId]; if (el) el.scrollTop = el.scrollHeight;
    }
    function toggleAuto(cardId){
      autoscroll[cardId] = autoscroll[cardId] === false;
      if (autoscroll[cardId]) jumpBottom(cardId);
    }
    /** 把對話攤平成純文字，方便貼到別的地方 */
    function copyLog(cardId){
      const lines = (logs[cardId]||[]).map(ev => {
        if (ev.kind === 'text')        return (ev.parentId ? '[subagent] ' : '') + ev.text;
        if (ev.kind === 'thinking')    return '[思考] ' + ev.text;
        if (ev.kind === 'tool_use')    return '[' + ev.name + '] ' + ev.text;
        if (ev.kind === 'tool_result') return '  → ' + (ev.text || '(沒有輸出)');
        if (ev.kind === 'result')      return '[結果] ' + (ev.isError ? '有錯誤' : '完成')
                                              + ' · ' + (ev.numTurns||'?') + ' 輪'
                                              + (ev.costUsd != null ? ' · $' + ev.costUsd : '');
        if (ev.kind === 'launch')      return '[送出工單]\n' + ev.text;
        if (ev.kind === 'assign')      return '=== ' + ev.engineerName + ' · ' + ev.projectName + ' ===';
        if (ev.kind === 'exit')        return '[程序結束] code ' + ev.code;
        return ev.text || '';
      });
      const txt = lines.filter(Boolean).join('\n');
      navigator.clipboard.writeText(txt)
        .then(() => toast('已複製對話內容'))
        .catch(() => toast('複製失敗，請手動選取', 'error'));
    }
    function setTermRef(cardId, el){ if (el) termRefs[cardId] = el; }
    /** 只從畫面移除。事件已經落地在 task/ 底下，不會真的消失。 */
    async function clearFinished(){
      try{const r=await fetch('/api/tasks/clear-finished',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({keys:visibleTasks.value.filter(t=>REQUEUEABLE.includes(t.status)||ARCHIVABLE.includes(t.status)).map(t=>t.key)})});const d=await r.json();if(!r.ok)throw Error(d.error);toast('未完成的任務已退回待指派；已驗收紀錄已封存。');}catch(e){toast(e.message,'error');}
    }

    /* ---------- 驗收 ---------- */
    async function loadReview(key, force){
      if (!key || (reviewLoading[key] && !force)) return;
      if (review[key] && !force) return;
      reviewLoading[key] = true;
      try{
        const r = await fetch('/api/tasks/' + encodeURIComponent(key) + '/review');
        const d = await r.json();
        if (r.ok) review[key] = d;
        else toast(d.error || '讀取變更失敗', 'error');
      }catch(e){ toast('讀取變更失敗：'+e.message, 'error'); }
      finally{ reviewLoading[key] = false; }
    }
    async function acceptTask(key){
      accepting.value = true;
      try{
        const r = await fetch('/api/tasks/accept', { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ key }) });
        const d = await r.json();
        if (d.ok){ toast(`${key} 已驗收完成`); return true; }
        toast(d.error || '驗收失敗', 'error');
      }catch(e){ toast('驗收失敗：'+e.message, 'error'); }
      finally{ accepting.value = false; }
      return false;
    }
    async function sendFeedback(key){
      const message = (fbText[key] || '').trim();
      if (!message) return;
      fbSending.value = true;
      try{
        const r = await fetch('/api/tasks/feedback', { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ key, message }) });
        const d = await r.json();
        if (d.ok){
          fbText[key] = '';
          delete review[key];            // 修完再重讀變更
          toast('已送出，工程師接續原本的對話繼續修');
          return true;
        } else toast(d.error || '送出失敗', 'error');
      }catch(e){ toast('送出失敗：'+e.message, 'error'); }
      finally{ fbSending.value = false; }
      return false;
    }

    async function resumeTask(key){
      fbSending.value=true;
      try{const r=await fetch('/api/tasks/'+encodeURIComponent(key)+'/resume',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:fbText[key] || ''})});const d=await r.json();if(!r.ok)throw Error(d.error);fbText[key]='';toast('已恢復任務');}catch(e){toast(e.message,'error');}finally{fbSending.value=false;}
    }
    /* ---------- 重置進度 ---------- */
    const resetAsk = ref(null);           // 正在確認重置的任務 key
    const resetDeleteBranch = ref(false);
    const resetting = ref(false);
    const canReset = t => !!t && RESETTABLE.includes(t.status) && !t.archived;
    function openReset(key){ resetAsk.value = key; resetDeleteBranch.value = false; }
    async function resetTask(key){
      resetting.value = true;
      try{
        const r = await fetch('/api/tasks/'+encodeURIComponent(key)+'/reset', { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ deleteBranch: resetDeleteBranch.value }) });
        const d = await r.json();
        if (!r.ok) throw Error(d.error || '重置失敗');
        toast(`已重置 ${key}，回到待指派`+(d.git ? `（${d.git}）` : ''));
        resetAsk.value = null;
      }catch(e){ toast('重置失敗：'+e.message, 'error'); }
      finally{ resetting.value = false; }
    }
    /* ---------- 中止 ---------- */
    async function stopTask(cardId){
      stopping.value = true;
      try{
        const r = await fetch('/api/tasks/abort', { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ cardId }) });
        const d = await r.json();
        if (!r.ok) toast(d.error || '中止失敗', 'error');
      }catch(e){ toast('中止失敗：'+e.message, 'error'); }
      finally{ stopping.value = false; stopAsk.value = null; }
    }

    /* ---------- socket ---------- */
    socket.on('connect',    ()=>{ connectState.value = 'online'; });
    socket.on('disconnect', ()=>{ connectState.value = 'offline'; });
    // 第一次就連不上（伺服器沒起來）也要如實報，否則會永遠卡在「連線中…」。
    socket.on('connect_error', ()=>{ connectState.value = 'offline'; });
    socket.on('system:info',    d => Object.assign(sys, d));
    socket.on('projects:update',d => { projects.value = d.projects||[]; });
    socket.on('projects:locks', d => {
      locks.value = d || {};
      // 若目前選的專案剛被別人佔用，自動取消選取避免送出後被擋
      if (pickedProject.value && locks.value[pickedProject.value]) pickedProject.value = null;
    });
    socket.on('board:update',   d => { board.value = d||[]; });
    socket.on('roles:update', d => { roles.value = d && d.roles || {}; });
    socket.on('engineers:update', d => {
      Object.keys(engineers).forEach(k=>{ if(!(k in d)) delete engineers[k]; });
      Object.assign(engineers, d);
    });
    socket.on('pm:history', list => {
      pmLogs.value = Array.isArray(list) ? list.slice() : [];
      nextTick(()=>{ if (pmScroll.value) pmScroll.value.scrollTop = pmScroll.value.scrollHeight; });
    });
    socket.on('pm:message', m => {
      pmLogs.value.push(m);
      if (pmLogs.value.length > 300) pmLogs.value.splice(0, pmLogs.value.length-300);
      nextTick(()=>{ if (pmScroll.value) pmScroll.value.scrollTop = pmScroll.value.scrollHeight; });
    });
    socket.on('mcp:log', ({chunk}) => {
      mcpLog.value.push(chunk);
      if (mcpLog.value.length > 60) mcpLog.value.shift();
      nextTick(()=>{ if (mcpBox.value) mcpBox.value.scrollTop = mcpBox.value.scrollHeight; });
    });
    // 依開始時間排序（新的在前）。重整後歷史任務是一次灌進來的，不能只靠 unshift 的順序。
    function sortTasks(){
      tasks.value.sort((a,b) => (b.startedAt||0) - (a.startedAt||0));
    }
    socket.on('task:started', info => {
      if (!tasks.value.find(t=>t.cardId===info.cardId)){
        tasks.value.unshift({ ...info });
        if (!logs[info.cardId]) logs[info.cardId] = [];
      }
      const existing=tasks.value.find(t=>t.cardId===info.cardId);if(existing)Object.assign(existing,info);
      sortTasks();
      // 該工程師的分頁自動切到這張新任務
      selectCard[info.engineerId] = info.cardId;
      if (effectiveTab.value !== info.engineerId) unread[info.engineerId] = true;
    });
    // 最近結束的任務：讓重整後還點得進去看對話（事件本身在伺服器落地了）
    socket.on('task:history', list => {
      for (const info of list || []){
        if (!info || !info.cardId) continue;
        if (tasks.value.find(t=>t.cardId===info.cardId)) continue;
        tasks.value.push({ ...info });
      }
      sortTasks();
    });
    socket.on('task:workflow',info=>{const task=tasks.value.find(t=>t.cardId===info.cardId);if(task)Object.assign(task,info);});
    socket.on('task:branch', ({cardId,branch}) => {
      const t = tasks.value.find(t=>t.cardId===cardId); if (t) t.branch = branch;
    });
    socket.on('task:event', (ev) => {
      pushEvent(ev);
      // 不在該工程師分頁時，亮出未讀指示
      const t = tasks.value.find(t => t.cardId === ev.cardId);
      if (t && t.engineerId !== effectiveTab.value) unread[t.engineerId] = true;
    });
    // 重新連線時伺服器會把執行中任務的對話重播回來
    socket.on('task:events', ({cardId, events, dropped:d}) => {
      eventsLoaded[cardId] = true;
      loadEvents(cardId, events, d);
    });
    socket.on('task:finished', ({cardId,exitCode,key,status,aborted}) => {
      const t = tasks.value.find(t=>t.cardId===cardId);
      if (t){ t.status = status || (exitCode===0 ? 'done':'failed'); t.finishedAt = Date.now(); }
      if (stopAsk.value === cardId) stopAsk.value = null;
      // 執行完就把該專案的變更抓回來，驗收面板才有東西可看
      if (!aborted && !t?.automation?.enabled) loadReview(key, true);
      if (aborted) toast(`${key} 已中止，該單已退回刊版`, 'error');
      else toast(exitCode===0 ? `${key} ${t?.mock?'模擬完成':'已完成'}，請進行驗收` : `${key} ${taskStatusLabel(status || 'failed')}，請查看任務原因`,
                 exitCode===0 ? 'success':'error');
    });

    socket.on('task:accepted', ({key}) => {
      for (const t of tasks.value) if (t.key === key) t.status = 'accepted';
      delete review[key];
    });

    /* ---------- 接取 ---------- */
    /**
     * 伺服器開機就把清單撈好放著，所以這裡通常是瞬間回來的。
     * refresh=true 才會真的重打 Jira（畫面上的「重新整理」按鈕）。
     */
    async function loadJiraTasks(refresh){
      loadingJira.value = true;
      if (refresh) mcpLog.value = [];
      try{
        const r = await fetch('/api/jira/tasks' + (refresh ? '?refresh=1' : ''));
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '伺服器錯誤');
        jiraTasks.value = d.tasks || [];
        jiraSprint.value = d.sprint || null;
        jql.value = d.jql || '';
        jiraFetchedAt.value = d.fetchedAt || 0;
        jiraError.value = '';
      }catch(e){ jiraError.value = e.message; jiraTasks.value = []; }
      finally{ loadingJira.value = false; }
    }
    async function openClaim(){
      showByKey.value = false; resetAsk.value = null; jiraCard.showCreate.value = false;
      showClaim.value = true;
      jiraSprint.value = null; jql.value = ''; selected.value = new Set(); jiraError.value = ''; mcpLog.value = [];
      await loadJiraTasks(false);
    }
    /** 使用者手動要一份新的：清掉勾選，避免對著舊清單的選擇送出。 */
    async function refreshJira(){
      if (loadingJira.value) return;
      selected.value = new Set();
      await loadJiraTasks(true);
    }
    function toggleSelect(key){
      if(jiraTasks.value.find(t=>t.key===key)?.unavailable)return;
      const s = new Set(selected.value);
      s.has(key) ? s.delete(key) : s.add(key);
      selected.value = s;
    }
    async function claim(){
      claiming.value = true;
      const picked = jiraTasks.value.filter(t=>selected.value.has(t.key));
      try{
        const r = await fetch('/api/tasks/claim',{ method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({tasks:picked}) });
        const d = await r.json();
        if (d.ok){ showClaim.value=false; mainView.value='queue'; toast(`成功接取 ${d.claimed.length} 張任務` + (d.skipped?.length ? `；略過 ${d.skipped.length} 張：`+d.skipped.map(t=>t.key+'（'+t.reason+'）').join('、') : '，請選擇卡片指派'));  }
        else toast('接取失敗：'+(d.error||''), 'error');
      }catch(e){ toast('接取失敗：'+e.message,'error'); }
      finally{ claiming.value=false; }
    }

    /* ---------- PM 開單 ---------- */
    const jiraCard = window.DashboardJiraCard.createJiraCardActions({ ref, toast });
    const workLog = window.DashboardWorkLog.createWorkLogActions({ ref, computed, toast, socket });
    // 辦公室角色（office-roles.js 的 action）對應到要打開的面板
    const ROLE_ACTIONS = { claim: openClaim, worklog: workLog.openWorkLog };
    function runRoleAction(action){ ROLE_ACTIONS[action]?.(); }

    const { openSettings, loadModels, addProject, addEngineer, saveSettings } =
      window.DashboardSettings.createSettingsActions({
        showSettings, setErr, draftProjects, draftEngineers, draftAi, draftModes,
        modesInfo, aiLoading, aiReady, setSaving, projects, engineerList, modelInfo, sys, toast,
      });

    /* ---------- 指定單號接取 ---------- */
    function openByKey(){
      showClaim.value = false; jiraCard.showCreate.value = false;
      showByKey.value = true;
      keyText.value = ''; byKeyErr.value = ''; byKeyMissing.value = []; mcpLog.value = [];
      nextTick(()=>{ if (keyInput.value) keyInput.value.focus(); });
    }
    async function claimByKey(){
      const text = keyText.value.trim();
      if (!text || byKeyLoading.value) return;
      byKeyLoading.value = true; byKeyErr.value = ''; byKeyMissing.value = []; mcpLog.value = [];
      try{
        const r = await fetch('/api/tasks/claim-by-key', { method:'POST',
          headers:{'Content-Type':'application/json'}, body:JSON.stringify({ keys:text }) });
        const d = await r.json();
        if (!r.ok){ byKeyErr.value = d.error || '查詢失敗'; return; }

        const n = (d.claimed||[]).length;
        byKeyMissing.value = d.missing || [];
        if (n) { mainView.value='queue'; toast(`已加入刊版：${d.claimed.map(t=>t.key).join('、')}`); }
        // 全部成功才關閉；有查不到的就留著讓使用者修正
        if (n && !byKeyMissing.value.length) showByKey.value = false;
        else if (!n) byKeyErr.value = byKeyErr.value || '沒有任何單號成功加入';
        else keyText.value = byKeyMissing.value.join(', ');
      }catch(e){ byKeyErr.value = e.message; }
      finally{ byKeyLoading.value = false; }
    }

    /* ---------- 指派 ---------- */
    function openAssign(t){
      assignTarget.value = t;
      branchMode.value='auto'; branchName.value = defaultBranchName.value; pickedEng.value = null; pickedProject.value = null;
      dirtyInfo.value = null;
    }
    function selectEng(e){
      pickedEng.value = e.id;
      if (pickedProject.value && !locks.value[pickedProject.value]) return;  // 已選且可用就不動
      const first = projects.value.find(p => p && !locks.value[p.id]);       // 選第一個沒被佔用的
      pickedProject.value = first ? first.id : null;
    }
    async function doAssign(force){
      if (!pickedEng.value) return;
      assigning.value = true;
      try{
        const r = await fetch('/api/assign',{ method:'POST', headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ taskKey:assignTarget.value.key, engineerId:pickedEng.value,
                                projectId:pickedProject.value, force: !!force, branchMode:branchMode.value, branchName:branchName.value }) });
        const d = await r.json();
        if (d.ok){ inspectEngineer(pickedEng.value); toast(`${assignTarget.value.key} 已開始執行`); assignTarget.value = null; dirtyInfo.value = null; }
        else if (d.code === 'DIRTY_TREE'){
          // 上一張單的變更還沒 commit —— 讓使用者看到是哪些檔案，再自己決定
          dirtyInfo.value = { message: d.error, dirty: d.dirty || [], ack: false };
        }
        else toast('指派失敗：'+(d.error||''), 'error');
      }catch(e){ toast('指派失敗：'+e.message,'error'); }
      finally{ assigning.value=false; }
    }
    async function removeTask(key){
      try{
        const r = await fetch('/api/tasks/'+encodeURIComponent(key), { method:'DELETE' });
        const d = await r.json();
        if (d.ok) toast(`已放棄 ${key}，可再從 ${pmName.value} 接取回來`);
        else toast(d.error || '放棄失敗', 'error');
      }catch(e){ toast('放棄失敗：'+e.message,'error'); }
      finally{ confirmKey.value = null; }
    }

    // 切到還沒載入過對話的卡片時（例如重整後回看已完成的單）就去補撈
    watch(currentTask, (t) => {
      if (!t) return;
      if (t.cardId && !eventsLoaded[t.cardId]) fetchEvents(t.key, t.cardId);

    }, { immediate: true });
    watch(mainView, view => {
      nextTick(() => {
        if (view === 'tasks' && currentTask.value && autoscroll[currentTask.value.cardId] !== false) jumpBottom(currentTask.value.cardId);
        if (view === 'reports' && pmScroll.value) pmScroll.value.scrollTop = pmScroll.value.scrollHeight;
      });
    });

    /* ---------- 鍵盤：ESC 關閉彈窗 ---------- */
    window.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape'){
        showClaim.value = false; assignTarget.value = null; confirmKey.value = null;
        showByKey.value = false; jiraCard.showCreate.value = false; showSettings.value = false; overviewFilter.value=null;
        workLog.showWorkLog.value = false;
      }
    });

    setInterval(()=>{ now.value = Date.now(); }, 1000);

    return {toolApprovals,questionsFor,engineerHasQuestion,skipQuestion,questionDraft,questionPicked,toggleQuestionOption,questionReady,answerQuestion,engineerAction,actionBusy,actionResult,actionError,actionBase,resultTab,resultTabs,resultReport,reportMock,actionOverview,deliveryInfo,draftKind,drafts,draftMocks,jevReview,jevLoading,jevError,runJevReview,showResultFeedback,acceptConfirm,submitResultFeedback,confirmResultAcceptance,openEngineerAction,selectResultTab,runEngineerAction,copyActionResult, pendingApprovals, approvalSending, decideApproval, branchMode, branchName, overviewFilter, overviewTasks, openOverviewTask, mainView, compactLayout, reviewCount, inspectEngineer, toast, connected, connectState, connectLabel, connectPill, engineers, engineerList, sys, projects, locks, board, tasks, visibleTasks, logs,
      opened, dropped, stopAsk, stopping, stopTask, toolIcon, toolSummary,
      resetAsk, resetDeleteBranch, resetting, canReset, openReset, resetTask,
      review, reviewLoading, fbText, fbSending, accepting, dirtyInfo,
      modelInfo, modelOptions,
      loadReview, acceptTask, sendFeedback, resumeTask,
      autoscroll, pmLogs, toasts,
      effectiveTab, selectCard, unread, currentTask, resultTask, tabEngineerName,
      tabState, tabSub, switchTab,
      idleCount, runningCount, finishedCount, anyLocked, canAssign, defaultBranchName,
      showClaim, loadingJira, jiraSprint, taskStatusLabel, jiraTasks, jiraError, jql, selected, claiming, mcpLog, mcpBox,
      jiraFetchedAt, fetchedAtLabel: window.DashboardUI.fetchedAtLabel, refreshJira,
      showByKey, keyText, keyInput, byKeyLoading, byKeyErr, byKeyMissing, openByKey, claimByKey,
      ...jiraCard,
      ...workLog,
      // 三個 Jira 面板共用同一組分頁，切過去時要把另外兩個收起來
      openCreate: () => { showClaim.value = false; showByKey.value = false; mcpLog.value = []; jiraCard.openCreate(); },
      showSettings, setTab, draftProjects, draftEngineers, draftAi, draftModes, modesInfo, aiLoading, aiReady, loadModels, setErr, setSaving, PALETTE,
      openSettings, addProject, addEngineer, saveSettings,
      assignTarget, pickedEng, pickedProject, assigning, pmScroll, confirmKey,
      engColor, idxOf, fmtTime, logIcon, elapsed, ago,
      openClaim, runRoleAction, roles, pmName, toggleSelect, claim, openAssign, selectEng, doAssign, removeTask,
      setTermRef, onTermScroll, jumpBottom, toggleAuto, copyLog, clearFinished };
  }
}).mount('#app');

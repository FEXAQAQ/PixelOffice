// 這支檔案是 classic script，頂層 const 會進全域語彙環境；dashboard.js 也用同名
// const 解構 window.DashboardUI，兩邊會撞成 SyntaxError。包成 IIFE，只留 DashboardUI 對外。
(() => {
  // 頭像：自訂外觀（look）優先，沒有就用名單序號自動產生；和辦公室場景共用 OfficeSprites。
  const PixelAgent = {
    props: { variant: {default:0}, look: Object },
    computed: {
      resolved(){ return window.OfficeRoles.normalizeLook(this.look) || window.OfficeEngine.appearance(Number(this.variant)||0); }
    },
    watch: { resolved(){ this.draw(); } },
    mounted(){ window.OfficeSprites.load().then(() => this.draw()).catch(() => {}); },
    methods: {
      draw(){
        const canvas = this.$refs.canvas; if (!canvas) return;
        const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.clearRect(0, 0, 64, 64);
        window.OfficeSprites.paint(c, this.resolved, 0, 0, 0, 0, 64);
      }
    },
    template: '<span class="pixel-agent" aria-hidden="true"><canvas ref="canvas" width="64" height="64"></canvas></span>'
  };

  // 工具事件顯示圖示與摘要；完整輸入由對話事件保留。
  const TOOL_ICONS = {
    Read:'📖', Write:'✍', Edit:'✎', MultiEdit:'✎', NotebookEdit:'✎',
    Bash:'▶', BashOutput:'▶', KillShell:'■',
    Glob:'🔍', Grep:'🔍', WebSearch:'🌐', WebFetch:'🌐',
    Task:'🤖', Agent:'🤖', TodoWrite:'☑', Skill:'📎', AskUserQuestion:'❓',
  };
  function toolIcon(name){ return TOOL_ICONS[name] || '🔧'; }

  // 每個工具最能代表「在做什麼」的欄位，依序找第一個有值的
  const TOOL_FIELDS = ['file_path','command','pattern','path','description','url','query','prompt','notebook_path'];

  function toolSummary(name, raw){
    let input;
    try { input = JSON.parse(raw); } catch(_) { return raw || ''; }
    if (!input || typeof input !== 'object') return String(raw || '');
    // 提問：顯示問題本身與選項，而不是一長串 JSON
    if (name === 'AskUserQuestion' && Array.isArray(input.questions)){
      return input.questions.map(q => `${q.question || ''}（${(q.options || []).map(o => o.label).join(' / ')}）`).join('；');
    }
    for (const f of TOOL_FIELDS){
      if (typeof input[f] === 'string' && input[f].trim()) return input[f].trim();
    }
    // 沒有慣用欄位就退回精簡 JSON
    const keys = Object.keys(input);
    if (!keys.length) return '';
    return keys.map(k => k + '=' + String(input[k]).slice(0,40)).join(' ');
  }

  /** 移除 ANSI escape 序列。raw 事件（stderr、git 輸出）可能還帶色碼。 */
  function stripAnsi(s){
    return String(s == null ? '' : s)
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\r(?!\n)/g, '');
  }

  /** 快取資料的取得時間，給「資料取得於 HH:MM」用；沒有時間就回空字串。 */
  function fetchedAtLabel(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const time = d.toLocaleTimeString('zh-TW', { hour12: false, hour: '2-digit', minute: '2-digit' });
    return sameDay ? time : d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' }) + ' ' + time;
  }

  const DashboardUI = { PixelAgent, toolIcon, toolSummary, stripAnsi, fetchedAtLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = DashboardUI;
  if (typeof window !== 'undefined') window.DashboardUI = DashboardUI;
})();

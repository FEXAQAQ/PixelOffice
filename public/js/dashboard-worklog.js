/**
 * BOSS 工作日誌視窗：依日期瀏覽 note/<年>/<月日>.md，並提供複製。
 *
 * 畫面顯示的就是檔案內容本身（用下方的小型 Markdown 轉換），
 * 所以「看到的」和「複製出去的」永遠一致。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardWorkLog = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const escape = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
  const inline = s => escape(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');

  /** 只處理日誌會用到的語法：標題、引言、條列、編號與粗體。先跳脫再轉換，檔案內容不會變成 HTML。 */
  function renderMarkdown(md) {
    const out = [];
    let list = null, quote = [];
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeQuote = () => { if (quote.length) { out.push(`<blockquote>${quote.join('<br>')}</blockquote>`); quote = []; } };
    for (const raw of String(md || '').split(/\r?\n/)) {
      const line = raw.trimEnd();
      let m;
      if (/^>\s?/.test(line)) { closeList(); quote.push(inline(line.replace(/^>\s?/, ''))); continue; }
      closeQuote();
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); const level = m[1].length + 1; out.push(`<h${level}>${inline(m[2])}</h${level}>`); }
      else if ((m = line.match(/^[-*]\s+(.*)$/))) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if ((m = line.match(/^\d+\.\s+(.*)$/))) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
      else if (list && /^\s{2,}\S/.test(line)) out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `<span class="wl-sub">${inline(line.trim())}</span></li>`);
      else if (!line.trim()) closeList();
      else { closeList(); out.push(`<p>${inline(line)}</p>`); }
    }
    closeList(); closeQuote();
    return out.join('');
  }

  /** 摘要版＝標題、總覽、今日重點與需要留意，不含逐項明細；適合貼到群組。 */
  function summaryOf(md) {
    const text = String(md || ''), cut = text.indexOf('\n## 任務明細');
    return (cut < 0 ? text : text.slice(0, cut)).trimEnd() + '\n';
  }

  /**
   * 複製成果＝純文字，每張單只留「單號 標題」與交付成果，單與單之間空一行：
   *   DEMO-1530 標題
   *   - 成果
   *    1. 子項目
   * 從明細的「### n. [KEY] 標題」與其後的「**交付成果**」條列取出，去掉 Markdown 標記。
   */
  function plainOf(md) {
    const tasks = [];
    let current = null, inOutcome = false;
    const strip = s => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    for (const line of String(md || '').split(/\r?\n/)) {
      const head = line.match(/^###\s+\d+\.\s+\[([^\]]+)\]\s*(.*)$/);
      if (head) { current = {title: `${head[1]} ${head[2].trim()}`, items: []}; tasks.push(current); inOutcome = false; continue; }
      if (!current) continue;
      if (/^#{1,3}\s/.test(line) || /^\*\*.+\*\*$/.test(line.trim())) { inOutcome = line.trim() === '**交付成果**'; continue; }
      if (!inOutcome) continue;
      const sub = line.match(/^\s{2,}(\d+\.|[-*])\s+(.*)$/), top = line.match(/^[-*]\s+(.*)$/);
      if (top) current.items.push('- ' + strip(top[1]));
      else if (sub) current.items.push(` ${sub[1] === '*' ? '-' : sub[1]} ${strip(sub[2])}`);
    }
    return tasks.map(t => [t.title, ...t.items].join('\n')).join('\n\n') + (tasks.length ? '\n' : '');
  }

  function localDate(ts = Date.now()) {
    const d = new Date(ts), pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  /** 伺服器還是舊版時，這支 API 會回 Express 的 404 HTML；給看得懂的提示，而不是 JSON 解析錯誤。 */
  async function readJson(r) {
    if ((r.headers.get('content-type') || '').includes('application/json')) return r.json();
    throw Error('伺服器尚未載入工作日誌功能，請重新啟動 PixelOffice（關閉後再執行 start.bat 或 npm start）。');
  }

  function createWorkLogActions({ref, computed, toast, socket}) {
    const showWorkLog = ref(false);
    const workLogDates = ref([]);        // [{date, count}]，新到舊
    const workLogDate = ref(localDate());
    const workLogToday = ref(localDate());
    const workLogMarkdown = ref('');
    const workLogLoading = ref(false);
    const workLogError = ref('');
    const workLogHtml = computed(() => renderMarkdown(workLogMarkdown.value));
    // 上一篇／下一篇在「有日誌的日期」之間跳，不逐日翻空白日。
    const olderWorkLog = computed(() => workLogDates.value.find(d => d.date < workLogDate.value)?.date || '');
    const newerWorkLog = computed(() => [...workLogDates.value].reverse().find(d => d.date > workLogDate.value)?.date || '');
    let request = 0;

    async function loadDates() {
      const r = await fetch('/api/worklog'), d = await readJson(r);
      if (!r.ok) throw Error(d.error || '讀取日誌清單失敗');
      workLogDates.value = d.dates; workLogToday.value = d.today || localDate();
    }
    async function pickWorkLogDate(date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return;
      const mine = ++request;
      workLogDate.value = date; workLogError.value = ''; workLogLoading.value = true;
      try {
        const r = await fetch('/api/worklog/' + date), d = await readJson(r);
        if (mine !== request) return;
        if (r.status === 404) workLogMarkdown.value = '';
        else if (!r.ok) throw Error(d.error || '讀取日誌失敗');
        else workLogMarkdown.value = d.markdown;
      } catch (e) { if (mine === request) { workLogMarkdown.value = ''; workLogError.value = e.message; } }
      finally { if (mine === request) workLogLoading.value = false; }
    }
    async function openWorkLog() {
      showWorkLog.value = true; workLogError.value = '';
      try { await loadDates(); } catch (e) { workLogError.value = e.message; }
      // 今天還沒有驗收時，直接打開最近一篇，而不是一片空白。
      const target = workLogDates.value.some(d => d.date === workLogToday.value) ? workLogToday.value : workLogDates.value[0]?.date || workLogToday.value;
      await pickWorkLogDate(target);
    }
    async function copyText(text) {
      try { await navigator.clipboard.writeText(text); return true; }
      catch (_) {
        const area = document.createElement('textarea');
        area.value = text; area.setAttribute('readonly', ''); area.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(area); area.select();
        try { return document.execCommand('copy'); } catch (_) { return false; } finally { area.remove(); }
      }
    }
    async function copyWorkLog(kind) {
      if (!workLogMarkdown.value) return;
      const md = workLogMarkdown.value;
      const [text, done] = kind === 'plain' ? [plainOf(md), '已複製成果（純文字）']
        : kind === 'summary' ? [summaryOf(md), '已複製日誌摘要（Markdown）'] : [md, '已複製完整日誌（Markdown）'];
      if (!text.trim()) { toast('這份日誌沒有可複製的任務成果', 'error'); return; }
      (await copyText(text)) ? toast(done) : toast('無法使用剪貼簿，請選取內容手動複製', 'error');
    }
    // 其他視窗驗收時，同步更新清單；正在看的那天也重讀一次。
    socket?.on('worklog:update', ({date}) => {
      if (!showWorkLog.value) return;
      loadDates().catch(() => {});
      if (date === workLogDate.value) pickWorkLogDate(date);
    });
    return {showWorkLog, workLogDates, workLogDate, workLogToday, workLogMarkdown, workLogHtml, workLogLoading, workLogError,
      olderWorkLog, newerWorkLog, openWorkLog, pickWorkLogDate, copyWorkLog};
  }
  return {createWorkLogActions, renderMarkdown, summaryOf, plainOf, localDate};
});

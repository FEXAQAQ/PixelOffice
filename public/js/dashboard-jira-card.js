/**
 * PM 開單面板的狀態與動作。
 *
 * 流程固定三步：輸入需求 → 生成草稿 → 預覽確認後建立。
 * 「生成」與「建立」是兩個獨立呼叫，中間一定隔著使用者確認；
 * 草稿可以在預覽區直接改，送出的以畫面內容為準。
 *
 * 父系用下拉選：候選在開啟面板時就依議題類型分組撈回來（每組最近 20 張未完成的單）。
 * 清單不可能涵蓋全部，所以一定保留「手動輸入單號」這條路；手動輸入的要查得到才算數。
 */
const MANUAL = '__manual__';

/** 負責端：選了就在標題前加「[前端] 」這類前綴；'' 代表未指定，標題維持原樣。 */
const SCOPES = ['前端', '後端', '前後端'];
const SCOPE_PREFIX = /^\s*\[(?:前端|後端|前後端)\]\s*/;
const SUMMARY_MAX = 255; // Jira 摘要欄位上限，前綴也算在內

function createJiraCardActions({ ref, toast }) {
  const showCreate = ref(false);
  const cardOptionsLoading = ref(false);
  const cardOptionsFetchedAt = ref(0);
  const cardOptions = ref({
    supported: true, issueTypes: [], parentGroups: [], sprints: [],
    projectKey: '', promptFile: '', contextError: '', aiMock: false, reason: '',
  });
  const cardText = ref('');
  const cardType = ref('任務');
  const cardParent = ref('');         // 下拉選的值：單號、'' 或 MANUAL
  const cardParentManual = ref('');   // 手動輸入模式下的單號
  const cardParentInfo = ref(null);   // 手動輸入時查回來的 { key, summary, projectKey }
  const cardParentErr = ref('');
  const cardParentLoading = ref(false);
  const cardSprintId = ref('');
  const cardScope = ref('');          // SCOPES 其中之一，'' 是未指定
  const cardDraft = ref(null);        // { summary, description }
  const cardDraftMock = ref(false);
  const cardDrafting = ref(false);
  const cardCreating = ref(false);
  const cardClaiming = ref(false);
  const cardErr = ref('');
  const cardCreated = ref(null);      // { key, url, mock }

  const parentGroups = () => cardOptions.value.parentGroups || [];
  const parentCount = () => parentGroups().reduce((n, g) => n + g.issues.length, 0);
  const isManual = () => cardParent.value === MANUAL;
  /** 目前選的議題類型（含樣板帶來的 purpose／example／sections），找不到回 null。 */
  const cardTypeInfo = () => (cardOptions.value.issueTypes || []).find((t) => t.name === cardType.value) || null;

  /** 目前實際要送出的父系單號。 */
  function parentKey() {
    return (isManual() ? cardParentManual.value : cardParent.value).trim().toUpperCase();
  }

  /** 標題前綴，例如「[前端] 」；未指定回空字串。 */
  const scopePrefix = () => (SCOPES.includes(cardScope.value) ? `[${cardScope.value}] ` : '');

  /**
   * 實際送出的標題 = 前綴 + 摘要。
   * 摘要開頭若已經帶了負責端標籤（AI 或使用者自己打的）先去掉，避免換選項後變成「[後端] [前端] …」。
   */
  function cardTitle() {
    const summary = String(cardDraft.value?.summary || '').replace(SCOPE_PREFIX, '').trim();
    return summary ? scopePrefix() + summary : '';
  }

  /** 父系是否已經備妥：下拉選好，或手動輸入的那張已經查到。 */
  function parentReady() {
    if (isManual()) return !!cardParentInfo.value && cardParentInfo.value.key === parentKey();
    return !!cardParent.value;
  }

  function resetCard() {
    cardText.value = ''; cardType.value = '任務';
    cardParent.value = ''; cardParentManual.value = ''; cardParentInfo.value = null; cardParentErr.value = '';
    cardSprintId.value = ''; cardScope.value = ''; cardDraft.value = null; cardDraftMock.value = false;
    cardErr.value = ''; cardCreated.value = null;
  }

  /**
   * 父系候選、議題類型與 Sprint 都由伺服器在開機時預先撈好。
   * refresh=true 才會真的重打 Jira（面板上的「重新整理」按鈕）。
   */
  async function loadCardOptions(refresh) {
    cardOptionsLoading.value = true;
    try {
      const r = await fetch('/api/jira/card/options' + (refresh ? '?refresh=1' : ''));
      const d = await r.json();
      if (!r.ok) throw Error(d.error || '讀取開單設定失敗');
      cardOptions.value = {
        parentGroups: [], issueTypes: [], sprints: [],
        projectKey: '', promptFile: '', contextError: '', reason: '', ...d,
      };
      cardOptionsFetchedAt.value = d.fetchedAt || 0;
      const types = cardOptions.value.issueTypes;
      if (types.length && !types.some((t) => t.name === cardType.value)) cardType.value = types[0].name;
    } catch (e) {
      cardErr.value = e.message;
    } finally {
      cardOptionsLoading.value = false;
    }
  }

  async function openCreate() {
    resetCard();
    showCreate.value = true;
    await loadCardOptions(false);
  }

  /** 使用者手動要一份新的父系／Sprint 清單（例如剛在 Jira 開了新的大型工作）。 */
  async function refreshCardOptions() {
    if (cardOptionsLoading.value) return;
    const keepParent = cardParent.value;
    await loadCardOptions(true);
    // 重新整理後原本選的父系如果還在，保留它，不要讓使用者重選。
    const stillThere = parentGroups().some((g) => (g.issues || []).some((i) => i.key === keepParent));
    cardParent.value = stillThere ? keepParent : '';
  }

  /** 手動輸入的父系單號要先查得到才算數（同時確認專案與權限）。 */
  async function lookupParent() {
    const key = cardParentManual.value.trim().toUpperCase();
    cardParentInfo.value = null; cardParentErr.value = '';
    if (!key) return;
    cardParentManual.value = key;
    cardParentLoading.value = true;
    try {
      const r = await fetch('/api/jira/card/parent?key=' + encodeURIComponent(key));
      const d = await r.json();
      if (!r.ok) throw Error(d.error || '查詢父系單失敗');
      cardParentInfo.value = d;
    } catch (e) {
      cardParentErr.value = e.message;
    } finally {
      cardParentLoading.value = false;
    }
  }

  async function generateCard() {
    if (cardDrafting.value) return;
    cardErr.value = ''; cardCreated.value = null;
    cardDrafting.value = true;
    try {
      const r = await fetch('/api/jira/card/draft', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: cardText.value, issueType: cardType.value }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || '生成失敗');
      cardDraft.value = { summary: d.summary, description: d.description };
      cardDraftMock.value = !!d.mock;
    } catch (e) {
      cardErr.value = e.message;
    } finally {
      cardDrafting.value = false;
    }
  }

  /** 建單是不可撤銷的寫入，按鈕鎖在 cardCreating 上，失敗也不自動重送。 */
  async function createCard() {
    if (cardCreating.value || !cardDraft.value || !parentReady()) return;
    cardErr.value = '';
    cardCreating.value = true;
    try {
      const r = await fetch('/api/jira/card', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: cardTitle(),
          description: cardDraft.value.description,
          parentKey: parentKey(),
          issueType: cardType.value,
          sprintId: cardSprintId.value === '' ? null : Number(cardSprintId.value),
        }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || '建立失敗');
      cardCreated.value = { key: d.key, url: d.url || '', mock: !!d.mock };
      toast(d.mock ? `【Mock】模擬建立 ${d.key}，未寫入 Jira` : `已建立 ${d.key}`, d.mock ? 'error' : 'success');
    } catch (e) {
      cardErr.value = e.message;
    } finally {
      cardCreating.value = false;
    }
  }

  /** 開完單順手接進刊版（走既有的依單號接取）。 */
  async function claimCreated() {
    if (!cardCreated.value || cardClaiming.value) return;
    cardClaiming.value = true;
    try {
      const r = await fetch('/api/tasks/claim-by-key', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: cardCreated.value.key }),
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || '接取失敗');
      if (d.missing && d.missing.length) throw Error(`Jira 上還查不到 ${d.missing.join('、')}，稍後可用「輸入單號」再接取`);
      showCreate.value = false;
      toast(`已接取 ${cardCreated.value.key} 到刊版`);
    } catch (e) {
      cardErr.value = e.message;
    } finally {
      cardClaiming.value = false;
    }
  }

  return {
    MANUAL_PARENT: MANUAL,
    showCreate, cardOptions, cardText, cardType, cardParent, cardParentManual, cardParentInfo,
    cardParentErr, cardParentLoading, cardSprintId, cardScope, CARD_SCOPES: SCOPES, SUMMARY_MAX,
    scopePrefix, cardTitle, cardDraft, cardDraftMock, cardDrafting,
    cardCreating, cardClaiming, cardErr, cardCreated, cardOptionsLoading, cardOptionsFetchedAt,
    parentGroups, parentCount, parentReady, parentKey, isManualParent: isManual, cardTypeInfo,
    openCreate, refreshCardOptions, lookupParent, generateCard, createCard, claimCreated, resetCard,
  };
}

const DashboardJiraCard = { createJiraCardActions, MANUAL_PARENT: MANUAL, CARD_SCOPES: SCOPES };
if (typeof module !== 'undefined' && module.exports) module.exports = DashboardJiraCard;
if (typeof window !== 'undefined') window.DashboardJiraCard = DashboardJiraCard;

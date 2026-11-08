(function (root) {
  const STATUS = Object.freeze({BACKLOG:'backlog', PREPARING:'preparing', IN_PROGRESS:'in_progress', VALIDATING:'validating', REPAIRING:'repairing', DELIVERING:'delivering', BLOCKED:'blocked', INTERRUPTED:'interrupted', DONE:'done', FAILED:'failed', ACCEPTED:'accepted', ABORTED:'aborted'});
  const LABELS = Object.freeze({backlog:'待指派', preparing:'準備中', in_progress:'開發中', validating:'驗證中', repairing:'修復中', delivering:'交付中', blocked:'待釐清／受阻', interrupted:'中斷待恢復', running:'執行中', done:'待驗收', failed:'執行失敗', accepted:'已驗收', aborted:'已中止', archived:'已封存'});
  const label = (status, archived = false) => LABELS[archived ? 'archived' : status] || status;
  // running is the existing execution-card wire format; persisted state uses in_progress.
  const ACTIVE = Object.freeze(['preparing','in_progress','validating','repairing','delivering']);

  /* ---------------------------------------------------------------
   *  狀態集合：每條「出口」各有一個具名集合。
   *
   *  ⚠️ 請勿在 call site 手寫狀態清單。以前每個判斷式都自己抄一份，
   *     各處對「還在跑／已結束」的認定不一致，結果 blocked 變成死路：
   *     重新接取被當成執行中、放棄被擋、清理不處理，唯一的「送回饋」
   *     又會被派工守門打回 blocked。集中在這裡，才有辦法用測試驗證
   *     「每個狀態都至少有一條出口」（見 test 的死路檢查）。
   * ------------------------------------------------------------- */

  /** 可退回待指派重跑：已停下、且沒有待驗收的產出 */
  const REQUEUEABLE = Object.freeze(['failed','aborted','blocked','interrupted']);
  /** 可帶著原本的執行紀錄接續（送回饋 / resume） */
  const RESUMABLE = Object.freeze(['done','failed','blocked','interrupted']);
  /** 已跑完、有產出可人工驗收或送回饋 */
  const REVIEWABLE = Object.freeze(['done','failed']);
  /** 只能封存 */
  const ARCHIVABLE = Object.freeze(['accepted']);
  /** 可直接從刊版移除（還沒開始跑，沒有紀錄要保留） */
  const DELETABLE = Object.freeze(['backlog']);
  /**
   * 已經跑過、停著、但還沒結案的狀態（顯示用；不含已驗收）。
   * 畫面上「這張單還在動嗎」只有四種答案：還沒開始（backlog）、正在跑（ACTIVE）、
   * 停著（FINISHED）、結案了（ARCHIVABLE）。以前名牌、監看面板、像素徽章各自
   * 手抄一份「停著」的清單，三份內容都不一樣，同一張中止的單在三個地方顯示三種結果。
   */
  const FINISHED = Object.freeze(['done','failed','blocked','interrupted','aborted']);
  /**
   * 可「重置進度」：清掉所有執行紀錄（session、分支、成本、成果），回到剛接單的樣子。
   * 跟 REQUEUEABLE 不同：退回待指派只改狀態、會帶著舊 session 與分支；重置是真的從頭來。
   * 含 done —— 產出不滿意想整個重跑也是常見情況，畫面上會再確認一次。
   */
  const RESETTABLE = FINISHED;

  const isActive = status => ACTIVE.includes(status);
  /** 這個狀態有沒有離開的路？（執行中不算死路，它會自己跑完） */
  const hasExit = status =>
    isActive(status) ||
    REQUEUEABLE.includes(status) ||
    RESUMABLE.includes(status) ||
    REVIEWABLE.includes(status) ||
    ARCHIVABLE.includes(status) ||
    DELETABLE.includes(status);

  const toCardStatus = status => ACTIVE.includes(status) ? 'running' : status;
  const api = Object.freeze({
    STATUS, LABELS, ACTIVE, REQUEUEABLE, RESUMABLE, REVIEWABLE, ARCHIVABLE, DELETABLE, FINISHED, RESETTABLE,
    label, toCardStatus, isActive, hasExit,
  });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TaskStatus = api;
})(typeof globalThis === 'object' ? globalThis : this);

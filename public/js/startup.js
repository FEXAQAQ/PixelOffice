(() => {
  const splash = document.getElementById('startup');
  const app = document.getElementById('app');
  if (!splash || !app) return;

  // 「這次要不要播」已經由 index.html <head> 的同步腳本決定（reduced motion，或這個
  // 分頁播過了），遮罩那時就被 CSS 擋成 display:none。這支是 defer，跑到這裡時畫面
  // 早就畫過了 —— 判斷放在這裡會變成「閃一下才消失」。這裡只負責收乾淨節點。
  if (document.documentElement.dataset.startup === 'played') {
    splash.remove();
    return;
  }

  // 先記下再播：中途重新整理或跳走，回來也不該重播。
  // key 與 <head> 那段同步腳本共用，改動要一起改。
  try { sessionStorage.setItem('pixeloffice:startup-played', '1'); } catch (_) {}
  const previousFocus = document.activeElement;
  const previousOverflow = document.body.style.overflow;
  const previousInert = app.inert;
  let dismissed = false;
  let timer;
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    document.removeEventListener('keydown', onKey);
    app.inert = previousInert;
    document.body.style.overflow = previousOverflow;
    splash.classList.add('is-leaving');
    // 焦點不能留在即將移除的遮罩上。沒有原焦點可還時交回頁面本身，不要塞給 app 的第一顆按鈕：
    // 程式移過去的焦點，瀏覽器會當成鍵盤焦點畫出外框，那顆按鈕（連線測試）就會莫名亮起來。
    // 下一次 Tab 會從遮罩原本的位置往後走，一樣落在 app 的第一個控制項。
    if (splash.contains(document.activeElement)) {
      if (previousFocus !== document.body && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      else document.activeElement.blur();
    }
    setTimeout(() => splash.remove(), 340);
  }
  function onKey(event) {
    if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
  }
  app.inert = true;
  document.body.style.overflow = 'hidden';
  const skip = splash.querySelector('button');
  skip.addEventListener('click', dismiss);
  document.addEventListener('keydown', onKey);
  skip.focus({ preventScroll: true });
  timer = setTimeout(dismiss, 2500);
})();

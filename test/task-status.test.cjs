const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),path=require('path');
const TaskStatus=require('../public/js/task-status');
const {STATUS,ACTIVE,REQUEUEABLE,RESUMABLE,ARCHIVABLE,DELETABLE,FINISHED,hasExit}=TaskStatus;

/**
 * 死路檢查：每個狀態都必須至少有一條出口。
 *
 * 這條測試是為了 blocked 曾經走進死路而寫的 —— 當時重新接取把它當成執行中、
 * 放棄被擋、清理不處理，唯一的「送回饋」又會被派工守門打回 blocked。
 * 只要有人新增狀態卻忘了給它出口，這裡就會紅。
 */
test('every task status has at least one exit', () => {
  const orphans=Object.values(STATUS).filter(s=>!hasExit(s));
  assert.deepEqual(orphans,[],`這些狀態沒有任何出口，會把任務卡死：${orphans.join('、')}`);
});

test('exit sets only contain known statuses and cover the deadlock-prone ones', () => {
  const all=new Set(Object.values(STATUS));
  for (const [name,set] of Object.entries({ACTIVE,REQUEUEABLE,RESUMABLE,ARCHIVABLE,DELETABLE})) {
    for (const s of set) assert.ok(all.has(s),`${name} 含有不存在的狀態：${s}`);
  }
  // 這兩個是人工介入才會停在那裡的狀態，一定要能退回待指派重跑
  for (const s of [STATUS.BLOCKED,STATUS.INTERRUPTED]) {
    assert.ok(REQUEUEABLE.includes(s),`${s} 必須可以退回待指派`);
  }
  // 執行中的狀態不該同時是「可重接／可刪除」，否則會覆蓋掉正在跑的任務
  for (const s of ACTIVE) {
    assert.ok(!REQUEUEABLE.includes(s)&&!DELETABLE.includes(s),`${s} 正在執行，不該被重接或刪除`);
  }
});

/**
 * 「停著」只能有一份定義。以前名牌、監看面板、像素徽章各抄一份，
 * 同一張中止的單在三個地方顯示三種結果。
 */
test('FINISHED is the single definition of "stopped but not closed"', () => {
  const {STATUS:S}=TaskStatus;
  const {FINISHED}=TaskStatus;
  // 停著的單既不在跑，也不是還沒開始
  for (const s of FINISHED) {
    assert.ok(!ACTIVE.includes(s),`${s} 不該同時算執行中`);
    assert.notEqual(s,S.BACKLOG);
  }
  assert.ok(FINISHED.includes(S.ABORTED),'中止的單必須算「停著」，否則畫面上會整張消失');
  assert.ok(!FINISHED.includes(S.ACCEPTED),'已驗收是結案，不該再佔著監看面板');
  // 每個狀態剛好落在一個階段：還沒開始 / 執行中 / 停著 / 結案
  const phases=[[S.BACKLOG],ACTIVE,FINISHED,ARCHIVABLE];
  for (const s of Object.values(S)) {
    const hit=phases.filter(p=>p.includes(s)).length;
    assert.equal(hit,1,`${s} 應該剛好屬於一個階段，目前屬於 ${hit} 個`);
  }
});

/**
 * 狀態集合被手抄在各個 call site，正是 blocked 變成死路的原因。
 * 這裡守住「不要再抄一份」：伺服器端的判斷式一律從 task-status 取集合。
 */
test('server code does not hand-roll status sets', () => {
  const files=['src/server/app.js','src/server/workflow/host.js','src/server/workflow/runner.js'];
  const pattern=/\[\s*'(?:backlog|preparing|in_progress|validating|repairing|delivering|blocked|interrupted|done|failed|accepted|aborted)'\s*,[^\]]*\]\s*\.includes/g;
  const offenders=[];
  for (const file of files) {
    const src=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
    src.split('\n').forEach((line,i)=>{
      if (pattern.test(line)) offenders.push(`${file}:${i+1} ${line.trim().slice(0,80)}`);
      pattern.lastIndex=0;
    });
  }
  assert.deepEqual(offenders,[],`請改用 task-status 的具名集合，別在此處手寫狀態清單：\n${offenders.join('\n')}`);
});

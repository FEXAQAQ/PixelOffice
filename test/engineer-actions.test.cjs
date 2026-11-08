const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {installActions}=require('../src/server/features/engineer-actions');
function fixture(t,overrides={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'rpg-actions-test-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 fs.mkdirSync(path.join(cwd,'.git'));fs.writeFileSync(path.join(cwd,'.git','HEAD'),'ref: refs/heads/work');fs.writeFileSync(path.join(cwd,'a.txt'),'changed');
 const routes={},calls=[],prompts=[],locks=new Map();const engineers=[{id:'e1',name:'Engineer'}];
 const deps={loadEngineers:()=>engineers,readTask:()=>({engineerId:'e1',projectPath:cwd,branch:'work',key:'T-1',summary:'Fix'}),lockedPaths:()=>Object.fromEntries(locks),actionLocks:locks,pushLocks:()=>{},generate:async p=>{prompts.push(p);return {text:p,mock:false};},runGit:async(args,dir,id,options)=>{calls.push({args,options});if(options.beforeRun)await options.beforeRun();return {code:0,out:args.includes('--abbrev-ref')?'work':args.includes('--absolute-git-dir')?path.join(cwd,'.git'):args.includes('--name-only')?'a.txt\0':args[0]==='diff'?'+ change':args[0]==='remote'?'https://example.test/repo.git':args[0]==='rev-parse'?'abc123':''};},...overrides};
 installActions(Object.fromEntries(['get','put','post'].map(m=>[m,(p,h)=>routes[m+p]=h])),deps);
 return {cwd,calls,prompts,locks,async request(kind,body={}){let status=200,result;await routes['post/api/engineers/:id/actions']({params:{id:'e1'},body:{key:'T-1',kind,...body}},{status(v){status=v;return this;},json(v){result=v;return this;}});return {status,...result};}};
}
test('draft uses built-in instructions and tracked diff; lock released',async t=>{const f=fixture(t);const r=await f.request('commit');assert.equal(r.status,200);assert.match(f.prompts[0],/只輸出草稿/);assert.match(f.prompts[0],/\+ change/);assert.deepEqual(f.calls[1].args,['diff','--no-ext-diff','--no-textconv','HEAD']);assert.equal(f.locks.size,0);});
// commit 訊息要能直接貼進 git commit -m，所以模型多包的區塊與 body 一律不留。
test('commit draft is asked for one plain line and is trimmed down to one if the model adds more',async t=>{const f=fixture(t,{generate:async()=>({text:'```\nfeat(結果面板): 新增草稿一鍵複製\n\n- 多餘的 body 條列\n```',mock:false})});const r=await f.request('commit');assert.equal(r.status,200);assert.equal(r.text,'feat(結果面板): 新增草稿一鍵複製');});
test('commit prompt states the one-line plain-text rule; MR keeps its Markdown draft',async t=>{const f=fixture(t);await f.request('commit');assert.match(f.prompts[0],/只輸出一行純文字/);assert.match(f.prompts[0],/不要程式碼區塊或任何 Markdown 標記/);await f.request('mr',{baseBranch:'origin/main'});assert.match(f.prompts[1],/MR 標題與描述/);});
// MR 描述要照公司模板，章節不能被模型自由發揮。
test('MR prompt carries the company template with the task key filled in',async t=>{const f=fixture(t);await f.request('mr',{baseBranch:'origin/main'});for(const section of ['## 🎯 **功能摘要**','## 🔄 **主要更改**','## 📁 **影響文件**','## 🧪 **測試說明**','## 🔗 **相關 Issue**'])assert.ok(f.prompts[0].includes(section),`模板缺少 ${section}`);assert.match(f.prompts[0],/Closes T-1/);});
test('MR draft loses an outer code fence but keeps fences inside the description',async t=>{const wrapped=fixture(t,{generate:async()=>({text:'```markdown\n標題\n\n## 🎯 **功能摘要**\n摘要\n```',mock:false})});const r=await wrapped.request('mr',{baseBranch:'origin/main'});assert.equal(r.text,'標題\n\n## 🎯 **功能摘要**\n摘要');const inner=fixture(t,{generate:async()=>({text:'標題\n\n```js\nconst a=1;\n```',mock:false})});assert.equal((await inner.request('mr',{baseBranch:'origin/main'})).text,'標題\n\n```js\nconst a=1;\n```');});
test('result report is generated as concise bullet points from the real worktree diff',async t=>{const f=fixture(t);const r=await f.request('report');assert.equal(r.status,200);assert.match(r.text,/3～8 個精簡的 Markdown 條列/);assert.match(r.text,/\+ change/);assert.equal(f.locks.size,0);});
test('MR requires target and uses committed comparison',async t=>{const f=fixture(t);assert.equal((await f.request('mr')).status,400);assert.equal((await f.request('mr',{baseBranch:'origin/main'})).status,200);assert.ok(f.calls.some(c=>c.args.includes('origin/main...HEAD')));});
test('busy project and wrong branch prevent mutations',async t=>{const f=fixture(t);f.locks.set(f.cwd,{taskKey:'other'});assert.equal((await f.request('discard')).status,400);assert.equal(f.calls.length,0);assert.equal(f.locks.size,1);const g=fixture(t,{runGit:async()=>({code:0,out:'other'})});assert.equal((await g.request('push')).status,400);assert.equal(g.locks.size,0);});
test('discard requests explicit tracked paths and detects edits while approval pending',async t=>{const f=fixture(t);assert.equal((await f.request('discard')).status,200);const restore=f.calls.find(c=>c.args[0]==='restore');assert.ok(restore);fs.writeFileSync(path.join(f.cwd,'a.txt'),'newer edit');assert.throws(restore.options.beforeRun,/已變動/);assert.equal(restore.args.at(-1),':(literal)a.txt');});
test('push targets fixed commit without force and exposes destination',async t=>{const f=fixture(t);assert.equal((await f.request('push')).status,200);const push=f.calls.find(c=>c.args[0]==='push');assert.ok(push.args.includes('abc123:refs/heads/work'));assert.ok(!push.args.includes('--force'));assert.match(push.options.approvalDetails,/example.test/);});
test('Git denial returns error and releases action lock',async t=>{const f=fixture(t,{runGit:async()=>{throw Error('denied');}});assert.match((await f.request('commit')).error,/denied/);assert.equal(f.locks.size,0);});

test('overview parses rename and untracked paths without treating them as tracked diffs',async t=>{const f=fixture(t,{runGit:async args=>({code:0,out:args[0]==='status'?'R  new name.txt\0old name.txt\0?? new.txt\0':args[0]==='diff'?'+ changed':'work'})});const r=await f.request('overview');assert.equal(r.status,200);assert.deepEqual(r.files,[{code:'R ',file:'new name.txt',original:'old name.txt'},{code:'??',file:'new.txt',original:null}]);assert.equal(r.hasTrackedChanges,true);assert.equal(f.locks.size,0);});
test('overview uses the approval-free read-only Git path',async t=>{const reads=[];const f=fixture(t,{readGit:async args=>{reads.push(args);return {code:0,out:args[0]==='status'?' M a.txt\0':'work'};},runGit:async()=>assert.fail('唯讀總覽不該進入寫入 Git／核准路徑')});const r=await f.request('overview');assert.equal(r.status,200);assert.deepEqual(r.files,[{code:' M',file:'a.txt',original:null}]);assert.deepEqual(reads.map(args=>args[0]),['rev-parse','status']);});
test('delivery preview handles absent tracking branch without claiming commits are known',async t=>{const f=fixture(t,{runGit:async args=>args[0]==='show-ref'?{code:1,out:''}:{code:0,out:args[0]==='remote'?'https://example.test/repo':'work'}});const r=await f.request('delivery');assert.equal(r.status,200);assert.equal(r.unknown,true);assert.equal(r.commits,'');});

// `git diff HEAD` 看不到未追蹤檔案，工程師新增的檔案以前會整個從 commit 草稿裡消失。
test('commit draft carries untracked new files, MR draft keeps to the committed diff',async t=>{const f=fixture(t,{runGit:async args=>({code:0,out:args[0]==='ls-files'?'new.txt\0':args.includes('--abbrev-ref')?'work':args[0]==='diff'?'+ change':''})});fs.writeFileSync(path.join(f.cwd,'new.txt'),'brand new content');const r=await f.request('commit');assert.equal(r.status,200);assert.match(f.prompts[0],/新增檔案：new\.txt/);assert.match(f.prompts[0],/brand new content/);const m=await f.request('mr',{baseBranch:'origin/main'});assert.equal(m.status,200);assert.ok(!m.text.includes('new.txt'),'MR 比的是已提交差異，不該混入未追蹤檔案');assert.equal(f.locks.size,0);});
test('commit draft refuses only when the worktree is genuinely clean',async t=>{const f=fixture(t,{runGit:async args=>({code:0,out:args.includes('--abbrev-ref')?'work':''})});assert.match((await f.request('commit')).error,/沒有未提交的變更/);assert.equal(f.locks.size,0);});
test('commit button stages all changes and commits the editable draft without pushing',async t=>{const calls=[];const f=fixture(t,{runGit:async(args,dir,id,options={})=>{calls.push(args);if(options.beforeRun)options.beforeRun();return {code:0,out:args.includes('--abbrev-ref')?'work':args.includes('--absolute-git-dir')?path.join(dir,'.git'):args[0]==='status'?' M a.txt\0':args.includes('--short')?'abc123':''};}});const r=await f.request('commit-now',{message:'Refine result review'});assert.equal(r.status,200);assert.equal(r.sha,'abc123');assert.ok(calls.some(args=>args[0]==='add'&&args[1]==='-A'));assert.ok(calls.some(args=>args[0]==='commit'&&args[2]==='Refine result review'));assert.ok(!calls.some(args=>args[0]==='push'));assert.equal(f.locks.size,0);});

// 模擬任務的分支與 baseCommit 是憑空生成的，拿去比對真實 repo 只會擋在「分支不同」，
// 三個成果分頁因此在 mock 模式下完全打不開。示範資料要在碰 Git 之前就回完。
test('mock tasks get demo data for all three result tabs without touching Git',async t=>{
  const f=fixture(t,{readTask:()=>({engineerId:'e1',projectPath:'C:\\nowhere\\missing',branch:'claude/T-1',key:'T-1',summary:'Fix',projectName:'Demo',resultReport:'- 模擬開發完成',mock:true}),
    runGit:async()=>assert.fail('模擬模式不該執行任何 Git'),readGit:async()=>assert.fail('模擬模式不該執行任何 Git'),
    generate:async()=>assert.fail('模擬模式不該呼叫 AI')});
  const report=await f.request('report');assert.equal(report.status,200);assert.equal(report.mock,true);assert.equal(report.text,'- 模擬開發完成');
  const overview=await f.request('overview');assert.equal(overview.status,200);assert.equal(overview.mock,true);assert.ok(overview.files.length);assert.equal(overview.hasChanges,true);
  const delivery=await f.request('delivery');assert.equal(delivery.status,200);assert.equal(delivery.mock,true);assert.equal(delivery.unknown,false);
  const commit=await f.request('commit');assert.equal(commit.status,200);assert.equal(commit.mock,true);assert.match(commit.text,/^feat\(mock\): /);
  const mr=await f.request('mr',{baseBranch:'origin/develop'});assert.equal(mr.status,200);assert.equal(mr.mock,true);
  for(const section of ['## 🎯 **功能摘要**','## 🔄 **主要更改**','## 📁 **影響文件**','## 🧪 **測試說明**','## 🔗 **相關 Issue**'])assert.ok(mr.text.includes(section),`模板缺少 ${section}`);
  assert.match(mr.text,/Closes T-1/);
  assert.equal(f.locks.size,0);
});
test('mock mode still refuses every Git write instead of faking success',async t=>{
  const f=fixture(t,{readTask:()=>({engineerId:'e1',projectPath:'C:\\nowhere\\missing',branch:'claude/T-1',key:'T-1',summary:'Fix',mock:true}),
    runGit:async()=>assert.fail('模擬模式不該執行任何 Git')});
  for(const kind of ['commit-now','discard','push']){const r=await f.request(kind,{message:'x'});assert.equal(r.status,400,kind);assert.match(r.error,/模擬模式/);}
  assert.equal(f.locks.size,0);
});

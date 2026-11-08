const {test}=require('node:test');const assert=require('node:assert/strict');
const {runPipeline,parseOutcome}=require('../src/server/workflow/pipeline');
const {normalizeAutomation}=require('../src/server/workflow/config');
function fixture(){const stages=[];let calls=0;return {stages,get calls(){return calls;},deps:{checkCancelled(){},stage:async s=>stages.push(s),develop:async()=>{calls++;return {code:0,complete:true,summary:'done'};}}};}
test('a reported completion ends the run without validating or writing to git',async()=>{
  const f=fixture();const result=await runPipeline(f.deps);
  assert.equal(result.status,'done');assert.equal(result.summary,'done');
  assert.equal(f.calls,1,'沒有系統驗證就沒有自動修復迴圈，開發只跑一次');
  assert.deepEqual(f.stages,['developing'],'不該再有 validating／delivering 階段');
});
test('ambiguous requirements, missing completion and error results never report done',async()=>{
  for(const output of [{code:0,blocked:'Which endpoint?'},{code:0,complete:false},{code:0,complete:true,isError:true}]){
    const f=fixture();f.deps.develop=async()=>output;
    assert.notEqual((await runPipeline(f.deps)).status,'done');
  }
});
test('cancellation after development stops before the task is marked done',async()=>{
  const f=fixture();let developed=false;
  f.deps.develop=async()=>{developed=true;return {code:0,complete:true,summary:'done'};};
  f.deps.checkCancelled=()=>{if(developed)throw Error('stopped');};
  await assert.rejects(runPipeline(f.deps),/stopped/);
});
test('completion protocol requires explicit final line and honors error flag',()=>{assert.equal(parseOutcome('text\nPIXELOFFICE_DONE: implemented').complete,true);assert.equal(parseOutcome('PIXELOFFICE_DONE: implemented',true).complete,false);assert.equal(parseOutcome('PIXELOFFICE_BLOCKED: missing acceptance criteria').blocked,'missing acceptance criteria');assert.equal(parseOutcome('I am done').complete,false);});
test('configuration rejects shell composition and invalid default branch',()=>{
  assert.throws(()=>normalizeAutomation({commands:'npm test',baseBranch:'bad..name'}),/基底分支/);
  assert.equal('commands' in normalizeAutomation({commands:'npm test\nnpm run build'}),false);
  assert.equal(normalizeAutomation({commands:'dotnet build'}).baseBranch,'develop');
});
// 「中途有命令被自動模式擋下」不該蓋掉工程師明確回報的完成。
// 曾經有任務這樣卡住：專案允許執行的命令設成 npm test 但那是 .NET 專案，
// 工程師改跑 dotnet 被擋 → 即使最後輸出 PIXELOFFICE_DONE 仍被判 blocked。
test('a denied command annotates the run but does not override a reported completion',async()=>{
  const f=fixture();
  f.deps.develop=async()=>({code:0,complete:true,summary:'done',policyNotice:'此命令未列入專案自動執行範圍'});
  const r=await runPipeline(f.deps);
  assert.equal(r.status,'done','回報完成就該讓人去看變更');
  assert.equal(r.policyNotice,'此命令未列入專案自動執行範圍','被擋的命令要留在結果裡讓人看見');
});
test('a denied command still explains the stop when completion was never reported',async()=>{
  const f=fixture();
  f.deps.develop=async()=>({code:0,complete:false,blocked:'此命令未列入專案自動執行範圍',policyNotice:'此命令未列入專案自動執行範圍'});
  const r=await runPipeline(f.deps);
  assert.equal(r.status,'blocked');
  assert.equal(r.reason,'此命令未列入專案自動執行範圍');
  assert.equal(r.policyNotice,'此命令未列入專案自動執行範圍');
});

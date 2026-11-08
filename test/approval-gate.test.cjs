const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ApprovalGate}=require('../src/server/security/approval-gate');
test('approval is explicit, single use and scoped to one operation',async()=>{
  const gate=new ApprovalGate(()=>{});
  const a=gate.request({cardId:'a',command:'git status'}),b=gate.request({cardId:'b',command:'git diff'});
  const [one,two]=gate.list();
  assert.equal(gate.decide(one.id,true),true);assert.equal(await a,true);
  assert.equal(gate.decide(one.id,true),false);assert.equal(gate.list().length,1);
  gate.cancel('b');assert.equal(await b,false);assert.equal(gate.list().length,0);
});
test('approval timeout denies rather than permits',async()=>{
  const gate=new ApprovalGate(()=>{},10);
  assert.equal(await gate.request({command:'git checkout main'}),false);
});

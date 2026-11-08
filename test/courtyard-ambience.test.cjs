const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const context={window:{OfficeEngine:{}},localStorage:{setItem(){}}};vm.runInNewContext(fs.readFileSync('public/js/office-scene.js','utf8'),context);const scene=context.window.OfficeScene;
test('local time selects the four courtyard periods at boundaries',()=>{for(const [h,p] of [[0,'night'],[4,'night'],[5,'morning'],[10,'morning'],[11,'noon'],[15,'noon'],[16,'sunset'],[18,'sunset'],[19,'night'],[23,'night']])assert.equal(scene.computed.ambiencePeriod.call({ambienceMode:'auto',clockNow:new Date(2026,8,10,h)}),p);assert.equal(scene.computed.ambiencePeriod.call({ambienceMode:'sunset',clockNow:new Date(2026,8,10,12)}),'sunset');});
test('motion pauses when disabled, editing, hidden or reduced motion requested',()=>{const state={ambienceMotion:true,reducedMotion:false,visible:true,editing:false};assert.equal(scene.computed.ambienceAnimated.call(state),true);for(const change of [{ambienceMotion:false},{reducedMotion:true},{visible:false},{editing:true}])assert.equal(scene.computed.ambienceAnimated.call({...state,...change}),false);});
test('scene preference survives reload alongside lighting and motion',()=>{
  let stored;
  context.localStorage.setItem=(key,value)=>{stored=value;};
  context.localStorage.getItem=()=>stored;
  scene.methods.saveAmbience.call({sceneTheme:'city',ambienceMode:'night',ambienceMotion:false});
  const restored=scene.data();
  scene.methods.restoreAmbience.call(restored);
  assert.equal(restored.sceneTheme,'city');
  assert.equal(restored.ambienceMode,'night');
  assert.equal(restored.ambienceMotion,false);
});
test('old, corrupt and unsupported preferences safely retain the forest default',()=>{
  for(const saved of ['{"mode":"sunset","motion":false}', '{"scene":"unknown"}', 'broken', 'null']) {
    context.localStorage.getItem=()=>saved;
    const state=scene.data();scene.methods.restoreAmbience.call(state);
    assert.equal(state.sceneTheme,'forest');
    if(saved.includes('sunset')){assert.equal(state.ambienceMode,'sunset');assert.equal(state.ambienceMotion,false);}
  }
  context.localStorage.getItem=()=>{throw Error('storage unavailable');};
  assert.doesNotThrow(()=>scene.methods.restoreAmbience.call(scene.data()));
});

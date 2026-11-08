const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
 let stored=null,now=1800000000000;
 class Clock extends Date{static now(){return now;}}
 const context={window:{OfficeEngine:{}},Date:Clock,localStorage:{getItem:()=>stored,setItem:(key,value)=>{stored=value;}},requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
 vm.runInNewContext(fs.readFileSync('public/js/office-scene.js','utf8'),context);
 const scene=context.window.OfficeScene;
 const state=()=>{const s=scene.data();for(const [k,v]of Object.entries(scene.methods))s[k]=v.bind(s);return s;};
 const s=state();s.restoreFishTank();
 return {s,state,context,advance:ms=>{now+=ms;},setStored:value=>{stored=value;}};
}
test('daily hunger persists across reload and reaches permanent death after two days',()=>{
 const {s,state,advance}=setup();assert.equal(s.fishSchool.filter(f=>f.kind==='shrimp').length,2);
 advance(86400000);const next=state();next.restoreFishTank();assert.equal(next.fishSchool[0].satiety,50);
 advance(86400000);const dead=state();dead.restoreFishTank();assert.ok(dead.fishSchool.every(f=>f.dead&&f.satiety===0&&f.y===12));
 advance(1000);const again=state();again.restoreFishTank();assert.ok(again.fishSchool.every(f=>f.dead));
});
test('food restores 25 points without exceeding 100; dead animals float and cannot eat',()=>{
 const {s}=setup();s.fishGameOpen=true;s.fishGameLast=0;
 const fish=s.fishSchool[0];fish.satiety=90;s.fishFood=[{id:1,x:fish.x,y:fish.y,age:0}];s.tickFishGame(16);assert.equal(fish.satiety,100);assert.equal(s.fishFood.length,0);
 fish.dead=true;fish.satiety=0;fish.y=40;s.fishFood=[{id:2,x:fish.x,y:40,age:0}];s.tickFishGame(32);assert.equal(fish.satiety,0);assert.ok(fish.y<40);assert.equal(s.fishFood.length,1);
});
test('shrimp wait for sinking food and eat near the floor',()=>{
 const {s}=setup();s.fishSchool=s.fishSchool.filter(f=>f.kind==='shrimp');s.fishGameOpen=true;s.fishGameLast=0;
 const shrimp=s.fishSchool[0];shrimp.satiety=50;shrimp.y=70;s.fishFood=[{id:1,x:shrimp.x,y:70,age:0}];s.tickFishGame(16);assert.equal(shrimp.satiety,50);
 shrimp.y=86;s.fishFood=[{id:2,x:shrimp.x,y:86,age:0}];s.tickFishGame(32);assert.equal(shrimp.satiety,75);
});
test('clock rollback cannot add hunger credit and corrupt storage is recoverable',()=>{
 const {s,state,setStored,context}=setup();s.updateFishSatiety(s.fishUpdatedAt-86400000);assert.equal(s.fishSchool[0].satiety,100);
 setStored('broken');const fresh=state();assert.doesNotThrow(()=>fresh.restoreFishTank());assert.equal(fresh.fishSchool.length,5);
 context.localStorage.setItem=()=>{throw Error('blocked');};fresh.saveFishTank();assert.equal(fresh.fishStorageError,true);
});

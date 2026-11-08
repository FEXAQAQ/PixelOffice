const {randomUUID} = require('crypto');
// 核准與提問共用同一個佇列：都是「工程師停下來等人」，畫面上一次只處理一筆。
// 核准的結果一律是 true/false；提問（kind:'question'）回答時改用 answer() 帶回答案物件。
class ApprovalGate {
  constructor(notify, timeout = 300000) { this.pending = new Map(); this.notify = notify; this.timeout = timeout; }
  list() { return [...this.pending.values()].map(p=>p.public); }
  get(id) { return this.pending.get(id)?.public || null; }
  request(details, {timeout = this.timeout} = {}) {
    return new Promise(resolve=>{
      const id=randomUUID();
      const timer=setTimeout(()=>this.decide(id,false),timeout);
      this.pending.set(id,{public:{...details,id,createdAt:Date.now(),expiresAt:Date.now()+timeout},resolve,timer});
      this.notify(this.list());
    });
  }
  decide(id, approved) { return this.settle(id, approved===true); }
  /** 只有提問能帶答案回去；核准類請求不能被一個物件「真值」偷渡成允許。 */
  answer(id, value) { return this.get(id)?.kind==='question' && value ? this.settle(id, value) : false; }
  settle(id, value) {
    const p=this.pending.get(id); if(!p)return false;
    this.pending.delete(id); clearTimeout(p.timer); p.resolve(value); this.notify(this.list()); return true;
  }
  cancel(cardId) { for(const [id,p] of this.pending) if(p.public.cardId===cardId)this.decide(id,false); }
}
module.exports={ApprovalGate};

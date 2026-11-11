const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
function setup(){
 const elements={};const events={};const stored=new Map(),calls=[];const controls=[{},{}];
 const node=()=>({classList:{toggle(){}},setAttribute(){},focus(){},contains:()=>false,querySelectorAll:()=>controls,addEventListener(){},inert:false});
 for(const id of ['main','busy','app','busy-message','check-transaction'])elements[id]=node();
 const document={getElementById:id=>elements[id]||null,querySelectorAll:()=>[],body:node(),activeElement:null,
  addEventListener:(type,fn,capture)=>{(events[type]??=[]).push({fn,capture});}};
 const google={script:{get run(){let success,failure;const runner=new Proxy({}, {get:(_,key)=>{
  if(key==='withSuccessHandler')return fn=>{success=fn;return runner;};
  if(key==='withFailureHandler')return fn=>{failure=fn;return runner;};
  return (...args)=>calls.push({name:key,args,success,failure});
 }});return runner;}}};
 const storage={setItem:(k,v)=>stored.set(k,v),getItem:k=>stored.get(k)||null,removeItem:k=>stored.delete(k)};
 const ctx=vm.createContext({console,document,google,crypto,sessionStorage:storage,window:{addEventListener(){}},setTimeout:()=>1,clearTimeout(){}});
 let script=fs.readFileSync('Index.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
 script=script.replace('refresh();\n})();',`globalThis.ui={state,borrowHtml,returnHtml,statusHtml,pill,canScan,setWorking,render,scan,runTransaction,checkTransaction,
 get transaction(){return transaction;}};\n})();`);
 vm.runInContext(script,ctx);
 const ui=ctx.ui;ui.state.loading=false;ui.state.keys=[{id:'0001',name:'測試',area:'',status:'AVAILABLE',location:''}];
 return {ui,calls,events,elements,controls,stored};
}
function ready(ui){Object.assign(ui.state,{selected:'0001',signed:true,signature:'data:image/png;base64,test'});}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('step 3 requires selection and signature or verified member',()=>{
 const {ui}=setup();assert.doesNotMatch(ui.borrowHtml(),/id="borrow-step3"/);
 ui.state.selected='0001';assert.equal(ui.canScan(),false);ready(ui);assert.match(ui.borrowHtml(),/id="borrow-step3"/);
 ui.state.signed=false;assert.doesNotMatch(ui.borrowHtml(),/id="borrow-step3"/);
 Object.assign(ui.state,{method:'RFID',person:'0010',memberVerifiedRfid:''});assert.equal(ui.canScan(),false);
 ui.state.memberVerifiedRfid='0010';assert.equal(ui.canScan(),true);
 ui.state.person='0020';assert.equal(ui.canScan(),false);
});
test('empty locations hidden and escaped valid location shown without info glyph',()=>{
 const {ui}=setup();
 for(const location of [null,undefined,'','  \t']){
  ui.state.returnResult={alreadyReturned:true,name:'測試',location};
  assert.doesNotMatch(ui.returnHtml(),/class="location"|尚未設定|ℹ/);
  assert.match(ui.returnHtml(),/此鑰匙已是可借用狀態/);
 }
 ui.state.returnResult.location='櫃子<A>';assert.match(ui.returnHtml(),/櫃子&lt;A&gt;/);
});
test('initial scan ignored, in-flight double Enter ignored, background controls disabled',async()=>{
 const {ui,calls,elements,controls,events}=setup();await ui.scan('borrow','0001');assert.equal(calls.length,0);
 ready(ui);const pending=ui.scan('borrow','0001');assert.equal(calls.length,1);assert.equal(elements.app.inert,true);
 assert.ok(controls.every(c=>c.disabled));await ui.scan('borrow','0001');assert.equal(calls.length,1);
 let prevented=false,stopped=false;events.keydown.find(x=>x.capture).fn({target:{id:'borrow-scan'},preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
 assert.equal(prevented,true);assert.equal(stopped,true);
 calls[0].success({ok:false,message:'驗證失敗'});await pending;
 assert.equal(ui.state.signature,'data:image/png;base64,test');assert.equal(ui.state.pending,'0001');
 assert.equal(ui.transaction,null);assert.equal(elements.app.inert,false);
});
test('lost response stays locked; query confirms original success and dashboard failure keeps success',async()=>{
 const {ui,calls,elements,stored}=setup();ready(ui);
 const pending=ui.scan('borrow','0001');const id=calls[0].args[0].requestId;
 calls[0].failure({message:'connection lost'});await pending;
 assert.equal(ui.transaction.id,id);assert.equal(elements.app.inert,true);assert.equal(stored.size,1);
 const checking=ui.checkTransaction();assert.equal(calls[1].name,'getTransactionResult');assert.equal(calls[1].args[0],id);
 calls[1].success({ok:true,name:'測試',logWarning:false});await tick();
 assert.equal(calls[2].name,'getDashboard');calls[2].failure({message:'dashboard offline'});await checking;
 assert.match(ui.state.borrowMessage.text,/已成功借出/);assert.match(ui.state.borrowMessage.text,/更新失敗/);
 assert.equal(stored.size,0);assert.equal(elements.app.inert,false);
});
test('not found retries identical ID and payload; pending evidence never blindly resubmits',async()=>{
 const {ui,calls}=setup();ready(ui);const pending=ui.scan('borrow','0001');const payload=calls[0].args[0];
 calls[0].failure({message:'offline'});await pending;
 const first=ui.checkTransaction();calls[1].success({ok:false,pending:true});await first;
 assert.equal(calls.length,2);
 const second=ui.checkTransaction();calls[2].success({ok:false,notFound:true});await tick();
 assert.equal(calls[3].name,'borrowKey');assert.equal(calls[3].args[0],payload);
 calls[3].success({ok:false,message:'驗證失敗'});await second;
});
test('return errors retain scanned tag for retry',async()=>{
 const {ui,calls}=setup();ui.state.page='return';const pending=ui.scan('return','0001');
 calls[0].success({ok:false,message:'找不到鑰匙'});await pending;
 assert.equal(ui.state.returnTag,'0001');assert.match(ui.returnHtml(),/value="0001"/);assert.match(ui.returnHtml(),/data-retry-return/);
});

test('duplicate loans show a distinct error badge and are never selectable',()=>{
 const {ui}=setup();
 ui.state.keys[0].status='CONFLICT';
 assert.match(ui.borrowHtml(),/0 把可借/);
 assert.doesNotMatch(ui.borrowHtml(),/data-key="0001"/);
 assert.match(ui.statusHtml(),/借用紀錄異常/);
 assert.match(ui.statusHtml(),/資料異常/);
 assert.match(ui.returnHtml(),/多筆未歸還紀錄/);
});

test('unknown active loan IDs disable all borrowing and show an integrity warning',()=>{
 const {ui}=setup();
 ui.state.keys[0].status='DATA_ERROR';
 ui.state.dataIssues=['loan row 2'];
 assert.equal(ui.canScan(),false);
 assert.match(ui.borrowHtml(),/已暫停借還/);
 assert.match(ui.statusHtml(),/資料待查核/);
 assert.match(ui.returnHtml(),/已暫停借還/);
});

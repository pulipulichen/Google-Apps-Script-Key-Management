const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync('Code.gs','utf8');
class Sheet{
 constructor(name,rows=[]){this.name=name;this.rows=rows;this.failAppend='';this.failSet='';}
 getName(){return this.name;}
 getLastRow(){return this.rows.length;}
 getLastColumn(){return Math.max(0,...this.rows.map(r=>r.length));}
 appendRow(row){if(this.failAppend==='before')throw Error('write unavailable');this.rows.push([...row]);if(this.failAppend==='after')throw Error('response lost');}
 getRange(row,col,height=1,width=1){return {
  getDisplayValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>String(this.rows[row-1+i]?.[col-1+j]??''))),
  setValues:values=>{if(this.failSet==='before')throw Error('write unavailable');values.forEach((r,i)=>r.forEach((v,j)=>{this.rows[row-1+i]??=[];this.rows[row-1+i][col-1+j]=v;}));if(this.failSet==='after')throw Error('response lost');}
 };}
}
function setup(){
 const sheets={key:new Sheet('key',[['ID','名稱','區域','存放位置'],['0001','測試鑰匙','教學區','']]),
  member:new Sheet('member',[['id','member_name'],['0010','測試人員']])};
 let held=false;
 const book={getSheetByName:n=>sheets[n],insertSheet:n=>sheets[n]=new Sheet(n)};
 const ctx=vm.createContext({console,SpreadsheetApp:{openById:()=>book,flush:()=>{}},
  Utilities:{getUuid:()=>crypto.randomUUID(),computeDigest:(_,x)=>[...crypto.createHash('sha256').update(x).digest()],DigestAlgorithm:{SHA_256:'SHA_256'},formatDate:()=>''},
  LockService:{getScriptLock:()=>({waitLock:()=>{assert.equal(held,false);held=true;},releaseLock:()=>{held=false;}})}});
 vm.runInContext(source,ctx);
 sheets.loan=new Sheet('loan',[vm.runInContext('LOAN_HEADERS',ctx)]);
 sheets.log=new Sheet('log',[vm.runInContext('LOG_HEADERS',ctx)]);
 const borrow=(id=crypto.randomUUID(),extra={})=>ctx.borrowKey({requestId:id,keyId:'0001',scannedTag:'0001',identityType:'RFID',personRfid:'0010',...extra});
 const ret=(id=crypto.randomUUID())=>ctx.returnKey({requestId:id,scannedTag:'0001'});
 return {ctx,sheets,borrow,ret};
}
test('duplicate borrow writes one loan and log and returns original success after return',()=>{
 const {sheets,borrow,ret}=setup(),id=crypto.randomUUID();
 assert.equal(borrow(id).ok,true);assert.equal(borrow(id).ok,true);
 assert.equal(sheets.loan.rows.length,2);assert.equal(sheets.log.rows.length,2);
 ret();assert.equal(borrow(id).ok,true);assert.equal(sheets.loan.rows.length,2);
});
test('duplicate old return cannot return a newer loan',()=>{
 const {sheets,borrow,ret}=setup();borrow();const id=crypto.randomUUID();ret(id);borrow();ret(id);
 assert.equal(sheets.loan.rows.length,3);assert.equal(sheets.loan.rows[2][10],'BORROWED');
 assert.equal(sheets.log.rows.length,4);
});
test('same request ID rejects different payload',()=>{
 const {borrow}=setup(),id=crypto.randomUUID();borrow(id);
 assert.throws(()=>borrow(id,{personRfid:'9999'}),/交易 ID/);
});
test('validation failure is definite and allows a new transaction with preserved values',()=>{
 const {borrow,sheets}=setup();const id=crypto.randomUUID();
 assert.equal(borrow(id,{personRfid:'9999'}).ok,false);
 assert.equal(sheets.loan.rows.length,1);
 assert.equal(borrow().ok,true);
});
test('ambiguous borrow append recovers via loan ID without a second append',()=>{
 const {borrow,sheets,ctx}=setup(),id=crypto.randomUUID();sheets.loan.failAppend='after';
 assert.equal(borrow(id).pending,true);sheets.loan.failAppend='';
 assert.equal(ctx.getTransactionResult(id).ok,true);
 assert.equal(borrow(id).ok,true);assert.equal(sheets.loan.rows.length,2);
});
test('write failure without loan evidence stays pending and does not retry mutation',()=>{
 const {borrow,sheets,ctx}=setup(),id=crypto.randomUUID();sheets.loan.failAppend='before';
 assert.equal(borrow(id).pending,true);sheets.loan.failAppend='';
 assert.equal(ctx.getTransactionResult(id).pending,true);assert.equal(borrow(id).pending,true);
 assert.equal(sheets.loan.rows.length,1);
});
test('ambiguous return recovers via marker and preserves original note',()=>{
 const {borrow,ret,sheets,ctx}=setup();borrow();sheets.loan.rows[1][11]='原始備註';
 const id=crypto.randomUUID();sheets.loan.failSet='after';assert.equal(ret(id).pending,true);
 sheets.loan.failSet='';assert.equal(ctx.getTransactionResult(id).ok,true);
 assert.match(sheets.loan.rows[1][11],/^原始備註\n\[return-request:/);
 assert.equal(ret(id).alreadyReturned,false);
});
test('empty and whitespace locations allow borrow and return; already returned has no new loan/log',()=>{
 for(const location of ['',null,undefined,'  \t']){
  const {borrow,ret,sheets}=setup();sheets.key.rows[1][3]=location;
  assert.equal(borrow().ok,true);assert.equal(ret().location,'');
  assert.equal(ret().alreadyReturned,true);assert.equal(sheets.log.rows.length,3);
 }
});
test('log failure does not turn committed loan into failure',()=>{
 const {borrow,sheets}=setup();sheets.log.failAppend='before';
 const result=borrow();assert.equal(result.ok,true);assert.equal(result.logWarning,true);
});
test('missing transaction is read-only and lock is released',()=>{
 const {ctx,sheets}=setup();assert.equal(ctx.getTransactionResult(crypto.randomUUID()).notFound,true);
 assert.equal(sheets.loan.rows.length,1);assert.equal(ctx.getTransactionResult(crypto.randomUUID()).notFound,true);
});

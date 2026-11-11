const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
const source=fs.readFileSync('Code.gs','utf8');
class Sheet{
 constructor(name,rows=[]){this.name=name;this.rows=rows;this.failAppend='';this.failSet='';this.textCells=new Set();}
 getName(){return this.name;}
 getLastRow(){return this.rows.length;}
 getLastColumn(){return Math.max(0,...this.rows.map(r=>r.length));}
 getMaxRows(){return Math.max(1000,this.rows.length);}
 insertRowsAfter(){}
 appendRow(row){if(this.failAppend==='before')throw Error('write unavailable');this.rows.push([...row]);if(this.failAppend==='after')throw Error('response lost');}
 getRange(row,col,height=1,width=1){
  const appending=col===1&&row>this.rows.length;
  return {
   getDisplayValues:()=>Array.from({length:height},(_,i)=>Array.from({length:width},(_,j)=>String(this.rows[row-1+i]?.[col-1+j]??''))),
   setNumberFormat:fmt=>{if(fmt==='@')for(let i=0;i<height;i++)for(let j=0;j<width;j++)this.textCells.add((row+i)+':'+(col+j));},
   setValues:values=>{
    if(this.failSet==='before'||(appending&&this.failAppend==='before'))throw Error('write unavailable');
    values.forEach((r,i)=>r.forEach((raw,j)=>{
     this.rows[row-1+i]??=[];
     // Simulate General-format conversion of numeric-looking strings in Sheets.
     const value=typeof raw==='string'&&/^[0-9]+$/.test(raw)&&!this.textCells.has((row+i)+':'+(col+j))?Number(raw):raw;
     this.rows[row-1+i][col-1+j]=value;
    }));
    if(this.failSet==='after'||(appending&&this.failAppend==='after'))throw Error('response lost');
   }
  };
 }
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

test('leading zeros remain text in loan, log and return RFID fields',()=>{
 const {sheets,borrow,ret,ctx}=setup();
 assert.equal(borrow().ok,true);
 assert.equal(sheets.loan.rows[1][1],'0001');
 assert.equal(sheets.loan.rows[1][3],'0010');
 assert.equal(sheets.log.rows[1][3],'0001');
 assert.equal(sheets.log.rows[1][5],'0001');
 assert.equal(ctx.getDashboard().keys[0].status,'BORROWED');
 assert.equal(borrow().ok,false);
 assert.equal(ret().ok,true);
 assert.equal(sheets.loan.rows[1][7],'0001');
 assert.equal(ctx.getDashboard().keys[0].status,'AVAILABLE');
});

test('orphaned BORROWED key ID locks all borrows and shows DATA_ERROR',()=>{
 const {sheets,borrow,ctx,ret}=setup();
 sheets.loan.rows.push(['orphan',1,new Date(),'','','','','','','','BORROWED','']);
 assert.equal(ctx.getDashboard().keys[0].status,'DATA_ERROR');
 assert.equal(ctx.getDashboard().dataIssues.length,1);
 assert.equal(borrow().ok,false);
 assert.match(borrow().message,/已暫停/);
 assert.equal(ret().ok,false);
 assert.match(ret().message,/已暫停/);
 assert.equal(sheets.loan.rows.length,2);
});

test('multiple BORROWED loans show CONFLICT and never create another borrow or guessed return',()=>{
 const {sheets,borrow,ret,ctx}=setup();
 assert.equal(borrow().ok,true);
 sheets.loan.rows.push(['second','0001',new Date(),'','','','','','','','BORROWED','']);
 const before=sheets.loan.rows.map(r=>[...r]);
 assert.equal(ctx.getDashboard().keys[0].status,'CONFLICT');
 assert.equal(borrow().ok,false);
 const result=ret();
 assert.equal(result.ok,false);
 assert.match(result.message,/多筆未歸還/);
 assert.deepEqual(sheets.loan.rows,before);
});

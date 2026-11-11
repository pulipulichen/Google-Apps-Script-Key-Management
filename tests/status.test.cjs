const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');

class Sheet {
  constructor(name, rows) {this.name = name; this.rows = rows;}
  getName() {return this.name;}
  getLastRow() {return this.rows.length;}
  getLastColumn() {return Math.max(0, ...this.rows.map(r => r.length));}
  getRange(row, column, height = 1, width = 1) {
    return {getDisplayValues: () => Array.from({length: height}, (_, i) =>
      Array.from({length: width}, (_, j) => String(this.rows[row + i - 1]?.[column + j - 1] ?? '')))};
  }
}
function backend() {
  let email = 'admin@example.edu.tw';
  let allowedEmails = 'admin@example.edu.tw';
  const sheets = {};
  const book = {getSheetByName: name => sheets[name]};
  const png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1];
  const ctx = vm.createContext({
    console,
    Session: {getActiveUser: () => ({getEmail: () => email})},
    PropertiesService: {getScriptProperties: () => ({getProperty: key =>
      key === 'BORROWER_VIEWER_EMAILS' ? allowedEmails : ''})},
    SpreadsheetApp: {openById: () => book},
    DriveApp: {getFileById: id => {
      if (id !== 'signature-1') throw new Error('file missing');
      return {getBlob: () => ({getContentType: () => 'image/png', getBytes: () => png})};
    }},
    Utilities: {formatDate: () => '2026/11/11 23:00:00',
      base64Encode: bytes => Buffer.from(bytes).toString('base64')}
  });
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), ctx);
  sheets.key = new Sheet('key', [
    ['ID', '名稱', '區域', '存放位置'], ['0001', '會議室鑰匙', '行政區', '']]);
  sheets.member = new Sheet('member', [['id', 'member_name'], ['0010', '王小姐']]);
  sheets.loan = new Sheet('loan', [vm.runInContext('LOAN_HEADERS', ctx),
    ['loan-1', '0001', '2026/11/11 23:00:00', '0010', '', '', '', '', '', '', 'BORROWED', '']]);
  sheets.log = new Sheet('log', [vm.runInContext('LOG_HEADERS', ctx)]);
  return {ctx, sheets, setEmail: value => email = value, setAllow: value => allowedEmails = value};
}
test('member names come from the unique active loan and are searchable by authorized viewers', () => {
  const {ctx, sheets} = backend();
  let key = ctx.getDashboard().keys[0];
  assert.equal(key.status, 'BORROWED');
  assert.equal(key.borrowerName, '王小姐');
  assert.equal(key.loanId, 'loan-1');
  assert.equal(key.hasSignature, false);
  sheets.loan.rows[1][3] = 'not-registered';
  key = ctx.getDashboard().keys[0];
  assert.equal(key.borrowerName, '查無對應成員');
});
test('current signature is retrieved on demand and stale loan IDs cannot read it', () => {
  const {ctx, sheets} = backend();
  sheets.loan.rows[1][3] = '';
  sheets.loan.rows[1][4] = 'signature-1';
  let key = ctx.getDashboard().keys[0];
  assert.equal(key.borrowerName, '手寫簽名');
  assert.equal(key.hasSignature, true);
  let result = ctx.getActiveBorrowSignature({keyId: key.id, loanId: key.loanId});
  assert.equal(result.dataUrl, 'data:image/png;base64,' +
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 1]).toString('base64'));
  assert.throws(() => ctx.getActiveBorrowSignature({keyId: key.id, loanId: 'other-loan'}), /借用狀態已改變/);
  sheets.loan.rows[1][10] = 'RETURNED';
  key = ctx.getDashboard().keys[0];
  assert.equal(key.status, 'AVAILABLE');
  assert.equal(key.borrowerName, '');
  assert.equal(key.hasSignature, false);
  assert.throws(() => ctx.getActiveBorrowSignature({keyId: '0001', loanId: 'loan-1'}), /借用狀態已改變/);
});
test('unauthorized and anonymous viewers see no borrower identity or signature', () => {
  const {ctx, sheets, setEmail, setAllow} = backend();
  sheets.loan.rows[1][4] = 'signature-1';
  setEmail('outsider@example.edu.tw');
  let key = ctx.getDashboard().keys[0];
  assert.equal(key.borrowerName, '借用人資訊需授權檢視');
  assert.equal(key.loanId, '');
  assert.equal(key.hasSignature, false);
  assert.throws(() => ctx.getActiveBorrowSignature({keyId: '0001', loanId: 'loan-1'}), /沒有查看/);
  setEmail('');
  assert.equal(ctx.getDashboard().keys[0].borrowerName, '借用人資訊需授權檢視');
  setEmail('admin@example.edu.tw');
  setAllow('');
  assert.equal(ctx.getDashboard().keys[0].hasSignature, false);
});
test('conflicts and orphaned loan IDs never guess who borrowed or which signature belongs', () => {
  const {ctx, sheets} = backend();
  sheets.loan.rows.push(['loan-2', '0001', '', '', 'signature-1', '', '', '', '', '', 'BORROWED', '']);
  let key = ctx.getDashboard().keys[0];
  assert.equal(key.status, 'CONFLICT');
  assert.equal(key.borrowerName, '');
  assert.equal(key.hasSignature, false);
  assert.throws(() => ctx.getActiveBorrowSignature({keyId: '0001', loanId: 'loan-1'}), /紀錄不唯一/);
  sheets.loan.rows.pop();
  sheets.loan.rows[1][1] = '1';
  key = ctx.getDashboard().keys[0];
  assert.equal(key.status, 'DATA_ERROR');
  assert.equal(key.borrowerName, '');
  assert.equal(key.hasSignature, false);
  assert.throws(() => ctx.getActiveBorrowSignature({keyId: '0001', loanId: 'loan-1'}), /資料異常/);
});
function frontend() {
  const calls = [], elements = {};
  const node = () => ({classList: {toggle() {}}, setAttribute() {}, focus() {},
    contains: () => false, querySelectorAll: () => [], addEventListener() {}, inert: false});
  for (const name of ['main', 'busy', 'app', 'busy-message', 'check-transaction']) elements[name] = node();
  const document = {getElementById: id => elements[id] || null, querySelectorAll: () => [],
    body: node(), activeElement: null, addEventListener() {}};
  const google = {script: {get run() {
    let success, failure;
    const runner = new Proxy({}, {get: (_, name) => {
      if (name === 'withSuccessHandler') return fn => {success = fn; return runner;};
      if (name === 'withFailureHandler') return fn => {failure = fn; return runner;};
      return (...args) => calls.push({name, args, success, failure});
    }});
    return runner;
  }}};
  const ctx = vm.createContext({console, document, google, crypto,
    sessionStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    window: {addEventListener() {}}, setTimeout: () => 1, clearTimeout() {}});
  const script = fs.readFileSync('Index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace('refresh();\n})();', 'globalThis.ui={state,statusHtml,keyRows,openSignature};\n})();');
  vm.runInContext(script, ctx);
  const ui = ctx.ui;
  ui.state.page = 'status';
  ui.state.loading = false;
  ui.state.keys = [{id:'0001', name:'會議室鑰匙', area:'行政區', status:'BORROWED',
    borrowedAt:'2026/11/11 23:00:00', borrowerName:'王小姐', hasSignature:true, loanId:'loan-1'}];
  ui.state.detail = '0001';
  return {ui, calls};
}
test('status UI shows escaped borrower names, supports name search, and hides returned borrower', () => {
  const {ui} = frontend();
  assert.match(ui.statusHtml(), /目前借用人/);
  assert.match(ui.statusHtml(), /王小姐/);
  assert.match(ui.statusHtml(), /data-view-signature="0001"/);
  ui.state.statusQuery = '王小姐';
  assert.match(ui.keyRows('status'), /data-key="0001"/);
  ui.state.statusQuery = '不存在';
  assert.doesNotMatch(ui.keyRows('status'), /data-key="0001"/);
  ui.state.keys[0].borrowerName = '<svg onload=bad()>';
  assert.match(ui.statusHtml(), /&lt;svg onload=bad\(\)&gt;/);
  ui.state.keys[0].status = 'AVAILABLE';
  assert.doesNotMatch(ui.statusHtml(), /目前借用人/);
  assert.doesNotMatch(ui.statusHtml(), /data-view-signature/);
});
test('signature preview requests matching loan only, then presents embedded image', async () => {
  const {ui, calls} = frontend();
  const pending = ui.openSignature('0001');
  assert.equal(calls[0].name, 'getActiveBorrowSignature');
  assert.equal(calls[0].args[0].keyId, '0001');
  assert.equal(calls[0].args[0].loanId, 'loan-1');
  calls[0].success({ok:true, dataUrl:'data:image/png;base64,dGVzdA=='});
  await pending;
  assert.match(ui.statusHtml(), /data-close-signature/);
  assert.match(ui.statusHtml(), /data:image\/png;base64,dGVzdA==/);
});
test('signature preview errors are shown without exposing file IDs', async () => {
  const {ui, calls} = frontend();
  const pending = ui.openSignature('0001');
  calls[0].failure({message:'簽名無法取得'});
  await pending;
  assert.match(ui.statusHtml(), /簽名無法取得/);
  assert.doesNotMatch(ui.statusHtml(), /data-close-signature/);
});

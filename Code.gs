/**
 * Google Apps Script 鑰匙管理平台。
 * schema.yaml 是人工參考文件，不在執行階段載入。
 * key.ID 為預設鑰匙 RFID 輸入值（保留前導零）；可選用 RFID_UID 欄覆寫。
 */
const SETTINGS = Object.freeze({
  spreadsheetId: '1vXwer7b9briUVHCn-wx-iyb6X-m62PNwQMnFPX7JItw',
  signatureParentFolderId: '1LO7B-j7AabHl8hSG23XAEyr0lCE6kp-c',
  signatureFolderName: '鑰匙借用簽名檔',
  timezone: 'Asia/Taipei',
  maxSignatureBytes: 2 * 1024 * 1024
});

const MEMBER_NOT_FOUND_MESSAGE = '人員 RFID 未登錄於 member 名單，請改用手寫簽名。';

const LOAN_HEADERS = [
  'loan_id','key_id','borrowed_at','borrow_rfid_uid',
  'borrow_signature_file_id','borrow_operator','returned_at',
  'return_rfid_uid','return_signature_file_id','return_operator','status','note'
];
const LOG_HEADERS = [
  'id','timestamp','action','key_id','loan_id',
  'rfid_uid','signature_file_id','operator','status','note'
];

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('鑰匙管理平台')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 三入口使用的即時狀態，不對外傳送內部 RFID_UID。 */
function getDashboard() {
  const db = sheets_();
  const active = activeLoans_(db.loan);
  const keys = keys_(db.key).map(k => ({
    id: k.id,
    name: k.name,
    area: k.area,
    location: k.location,
    status: active[k.id] ? 'BORROWED' : 'AVAILABLE',
    borrowedAt: active[k.id] ? active[k.id].borrowedAt : ''
  }));
  return {keys: keys, updatedAt: Utilities.formatDate(new Date(), SETTINGS.timezone, 'yyyy/MM/dd HH:mm:ss')};
}

/** 先驗證掃描的鑰匙與選擇項目相符。此步驟不改動資料。 */
function verifyBorrowTag(input) {
  const selectedId = str_(input && input.keyId);
  const scannedTag = str_(input && input.scannedTag);
  if (!selectedId || !scannedTag) throw new Error('請選擇鑰匙，再感應鑰匙 RFID。');
  const db = sheets_();
  const keys = keys_(db.key);
  const selected = keys.find(k => k.id === selectedId);
  const scanned = keys.find(k => k.rfid === scannedTag);
  if (!selected) throw new Error('找不到所選鑰匙，請重新整理。');
  if (!scanned) throw new Error('無法辨識感應到的鑰匙 RFID。');
  if (scanned.id !== selected.id) {
    throw new Error('感應到「' + scanned.name + '」，但選擇的是「' + selected.name + '」。');
  }
  if (activeLoans_(db.loan)[selected.id]) throw new Error('這把鑰匙已借出。');
  return {ok: true, name: selected.name};
}

/** 只接受 member.id 中已登錄的人員 RFID；不回傳完整人員清單。 */
function verifyMemberRfid(rawRfid) {
  const rfid = str_(rawRfid);
  if (!rfid) throw new Error('請先感應人員 RFID。');
  const sheet = SpreadsheetApp.openById(SETTINGS.spreadsheetId).getSheetByName('member');
  const member = findMemberByRfid_(sheet, rfid);
  return member
    ? {ok: true}
    : {ok: false, message: MEMBER_NOT_FOUND_MESSAGE};
}

/**
 * 借鑰匙：簽名（預設）或人員 RFID 二擇一，鑰匙本身 RFID 必填。
 * LockService 內再次檢查，以防多人同時借出。
 */
function borrowKey(input) {
  const r = input || {};
  return transaction_(r.requestId, 'BORROW', r, tx => borrowKey_(r, tx));
}

function borrowKey_(r, tx) {
  const keyId = str_(r.keyId);
  const scannedTag = str_(r.scannedTag);
  const identityType = str_(r.identityType);
  const personRfid = str_(r.personRfid);
  if (!keyId || !scannedTag) throw new Error('請選擇鑰匙並感應其 RFID。');
  if (!['SIGNATURE','RFID'].includes(identityType)) throw new Error('請選擇簽名或人員 RFID。');
  if (identityType === 'RFID' && !personRfid) throw new Error('請先感應人員 RFID。');
  if (identityType === 'SIGNATURE') signatureBytes_(r.signatureDataUrl);

  {
    const db = sheets_();
    const key = keys_(db.key).find(k => k.id === keyId);
    if (!key) throw new Error('所選鑰匙不存在。');
    if (key.rfid !== scannedTag) throw new Error('鑰匙 RFID 與內部紀錄不符。');
    if (activeLoans_(db.loan)[keyId]) throw new Error('鑰匙已被其他人借出，請重新整理。');
    // 寫入前再次查 member，避免前端驗證遭繞過，或驗證後名單被移除。
    if (identityType === 'RFID' && !findMemberByRfid_(db.book.getSheetByName('member'), personRfid)) {
      throw new Error(MEMBER_NOT_FOUND_MESSAGE);
    }

    let signatureFileId = '';
    if (identityType === 'SIGNATURE') signatureFileId = storeSignature_(r.signatureDataUrl, keyId);
    const loanId = tx.id;
    tx.prepare({ok: true, name: key.name, area: key.area, location: key.location, logWarning: true});
    try {
      db.loan.appendRow([
        loanId, keyId, new Date(), identityType === 'RFID' ? personRfid : '',
        signatureFileId, '', '', '', '', '', 'BORROWED', ''
      ]);
    } catch (err) {
      if (signatureFileId && !tx.started) {
        try { DriveApp.getFileById(signatureFileId).setTrashed(true); } catch (_) {}
      }
      throw err;
    }
    // loan 優先：若 log 失敗，回報借出成功與警告，不讓管理者誤以為可再次借用。
    let logWarning = false;
    try { appendLog_(db.log, 'BORROW', keyId, loanId, scannedTag, signatureFileId); }
    catch (err) { console.error('借出成功，log 寫入失敗：' + err); logWarning = true; }
    return {ok: true, name: key.name, area: key.area, location: key.location, logWarning: logWarning};
  }
}

/** 還鑰匙：只有鑰匙 RFID，不要求簽名、借用人或選擇清單。 */
function returnKey(input) {
  const r = input || {};
  return transaction_(r.requestId, 'RETURN', r, tx => returnKey_(r.scannedTag, tx));
}

function returnKey_(rawTag, tx) {
  const scannedTag = str_(rawTag);
  if (!scannedTag) throw new Error('請點選輸入欄位，再感應鑰匙。');

  {
    const db = sheets_();
    const key = keys_(db.key).find(k => k.rfid === scannedTag);
    if (!key) throw new Error('找不到這個 RFID 對應的鑰匙。');

    const loan = activeLoans_(db.loan)[key.id];
    if (!loan) {
      return {ok: true, alreadyReturned: true, name: key.name,
        area: key.area, location: key.location, logWarning: false};
    }
    const note = str_(db.loan.getRange(loan.row, 12).getDisplayValues()[0][0]);
    tx.prepare({ok: true, alreadyReturned: false, name: key.name,
      area: key.area, location: key.location, logWarning: true});
    // 狀態與交易標記同次寫入；回應遺失仍可核對原交易，保留原 note。
    db.loan.getRange(loan.row, 7, 1, 6).setValues([
      [new Date(), scannedTag, '', '', 'RETURNED', note + '\n[return-request:' + tx.id + ']']
    ]);
    let logWarning = false;
    try { appendLog_(db.log, 'RETURN', key.id, loan.loanId, scannedTag, ''); }
    catch (err) { console.error('歸還成功，log 寫入失敗：' + err); logWarning = true; }
    return {ok: true, alreadyReturned: false, name: key.name,
      area: key.area, location: key.location, logWarning: logWarning};
  }
}

/** 持久交易日誌；與 loan 一起受 ScriptLock 保護，不使用會過期的 Cache。 */
const TRANSACTION_HEADERS = ['request_id','action','fingerprint','status','result_json','updated_at'];
function transactionSheet_() {
  const book = SpreadsheetApp.openById(SETTINGS.spreadsheetId);
  let sheet = book.getSheetByName('transaction');
  if (!sheet) {
    sheet = book.insertSheet('transaction');
    sheet.appendRow(TRANSACTION_HEADERS);
    SpreadsheetApp.flush();
  }
  checkHeader_(sheet, TRANSACTION_HEADERS);
  return sheet;
}
function transactionId_(value) {
  const id = str_(value);
  if (!/^[a-zA-Z0-9-]{20,80}$/.test(id)) throw new Error('缺少有效交易 ID，請更新網頁後重試。');
  return id;
}
function transactionRow_(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const rows = sheet.getRange(2, 1, last - 1, 6).getDisplayValues();
  const index = rows.findIndex(row => row[0] === id);
  return index < 0 ? null : {row: index + 2, values: rows[index]};
}
function writeTransaction_(sheet, row, status, result) {
  sheet.getRange(row, 4, 1, 3).setValues([[status, JSON.stringify(result), new Date()]]);
  SpreadsheetApp.flush();
}
function transactionResult_(sheet, record) {
  const v = record.values;
  if (v[3] === 'COMPLETED' || v[3] === 'FAILED') return JSON.parse(v[4]);
  // STARTED/WRITING 都不可盲目重送；只依 loan 中的原交易證據確認。
  if (v[4]) {
    const loan = SpreadsheetApp.openById(SETTINGS.spreadsheetId).getSheetByName('loan');
    const rows = loan.getLastRow() < 2 ? [] : loan.getRange(2, 1, loan.getLastRow() - 1, 12).getDisplayValues();
    const found = rows.some(r => v[1] === 'BORROW' ? r[0] === v[0] :
      str_(r[11]).split('\n').includes('[return-request:' + v[0] + ']'));
    if (found) {
      const result = JSON.parse(v[4]);
      writeTransaction_(sheet, record.row, 'COMPLETED', result);
      return result;
    }
  }
  return {ok: false, pending: true, message: '結果待確認，請查詢原交易，勿重新借還；若持續未確認，請通知管理員核對 transaction 與 loan。'};
}
function getTransactionResult(requestId) {
  const id = transactionId_(requestId);
  return locked_(() => {
    const sheet = transactionSheet_(), record = transactionRow_(sheet, id);
    return record ? transactionResult_(sheet, record) : {ok: false, notFound: true};
  });
}
function transaction_(requestId, action, input, callback) {
  const id = transactionId_(requestId);
  // 固定欄位順序，禁止同 ID 改成另一組資料；不在日誌保存簽名原圖。
  const canonical = JSON.stringify([action, str_(input.keyId), str_(input.scannedTag),
    str_(input.identityType), str_(input.personRfid), str_(input.signatureDataUrl)]);
  const fingerprint = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  return locked_(() => {
    const sheet = transactionSheet_(), existing = transactionRow_(sheet, id);
    if (existing) {
      if (existing.values[1] !== action || existing.values[2] !== fingerprint) {
        throw new Error('交易 ID 已用於其他資料，不能重複使用。');
      }
      return transactionResult_(sheet, existing);
    }
    sheet.appendRow([id, action, fingerprint, 'STARTED', '', new Date()]);
    SpreadsheetApp.flush();
    const row = sheet.getLastRow();
    const tx = {id: id, started: false, prepare: result => {
      writeTransaction_(sheet, row, 'WRITING', result);
      tx.started = true;
    }};
    let result;
    try { result = callback(tx); }
    catch (err) {
      if (tx.started) return {ok: false, pending: true, message: '結果待確認，請查詢原交易結果。'};
      result = {ok: false, message: err.message || String(err)};
      writeTransaction_(sheet, row, 'FAILED', result);
      return result;
    }
    SpreadsheetApp.flush();
    writeTransaction_(sheet, row, 'COMPLETED', result);
    return result;
  });
}

function sheets_() {
  const book = SpreadsheetApp.openById(SETTINGS.spreadsheetId);
  const key = book.getSheetByName('key');
  const loan = book.getSheetByName('loan');
  const log = book.getSheetByName('log');
  if (!key || !loan || !log) throw new Error('試算表缺少 key、loan 或 log 工作表。');
  const h = key.getRange(1, 1, 1, 4).getDisplayValues()[0];
  if (['ID','名稱','區域','存放位置'].some((name, i) => h[i] !== name)) {
    throw new Error('key 表首列必須是：ID、名稱、區域、存放位置。');
  }
  checkHeader_(loan, LOAN_HEADERS);
  checkHeader_(log, LOG_HEADERS);
  return {book: book, key: key, loan: loan, log: log};
}

function checkHeader_(sheet, expected) {
  const actual = sheet.getRange(1, 1, 1, expected.length).getDisplayValues()[0];
  if (expected.some((name, i) => name !== actual[i])) {
    throw new Error(sheet.getName() + ' 表的標題列與程式不符，請檢查。');
  }
}

/**
 * 使用 member!A:B 登錄名單，id 比對不分英文字母大小寫，保留前導零。
 * 沒有 member 工作表或欄位不符時一律拒絕 RFID 借用。
 */
function findMemberByRfid_(sheet, rfid) {
  if (!sheet) throw new Error('找不到 member 工作表，請通知管理員。');
  checkHeader_(sheet, ['id', 'member_name']);
  const last = sheet.getLastRow();
  if (last < 2) return null;
  const target = str_(rfid).toUpperCase();
  if (!target) return null;
  const rows = sheet.getRange(2, 1, last - 1, 2).getDisplayValues();
  const row = rows.find(r => str_(r[0]).toUpperCase() === target);
  return row ? {id: str_(row[0]), name: str_(row[1])} : null;
}

/** 全程採 getDisplayValues，避免 0001 RFID 變成數字 1。 */
function keys_(sheet) {
  if (sheet.getLastRow() < 2) return [];
  const values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(4, sheet.getLastColumn())).getDisplayValues();
  const rfidIndex = values[0].findIndex(x => str_(x).toUpperCase() === 'RFID_UID');
  const ids = new Set(), tags = new Set();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i], id = str_(row[0]), name = str_(row[1]);
    if (!id && !name) continue;
    if (!id || !name) throw new Error('key 第 ' + (i + 1) + ' 列缺少 ID 或名稱。');
    const rfid = rfidIndex < 0 ? id : (str_(row[rfidIndex]) || id);
    if (ids.has(id) || tags.has(rfid)) throw new Error('key 資料有重複的 ID 或 RFID（第 ' + (i + 1) + ' 列）。');
    ids.add(id); tags.add(rfid);
    rows.push({id: id, rfid: rfid, name: name, area: str_(row[2]), location: str_(row[3])});
  }
  return rows;
}

function activeLoans_(sheet) {
  const result = Object.create(null);
  const last = sheet.getLastRow();
  if (last < 2) return result;
  const rows = sheet.getRange(2, 1, last - 1, 12).getDisplayValues();
  rows.forEach((row, index) => {
    if (str_(row[10]) !== 'BORROWED') return;
    const id = str_(row[1]);
    if (!id) throw new Error('loan 第 ' + (index + 2) + ' 列缺少 key_id。');
    if (result[id]) throw new Error('鑰匙 ' + id + ' 同時有多筆未歸還借出紀錄，請先修正。');
    result[id] = {row: index + 2, loanId: str_(row[0]), borrowedAt: str_(row[2])};
  });
  return result;
}

function appendLog_(sheet, action, keyId, loanId, tag, fileId) {
  sheet.appendRow([Utilities.getUuid(), new Date(), action, keyId, loanId, tag, fileId, '', 'SUCCESS', '']);
}

function signatureBytes_(dataUrl) {
  if (typeof dataUrl !== 'string' ||
      !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) {
    throw new Error('請先完成手寫簽名。');
  }
  const encoded = dataUrl.slice('data:image/png;base64,'.length);
  if (encoded.length < 100 || encoded.length > Math.ceil(SETTINGS.maxSignatureBytes * 4 / 3) + 8) {
    throw new Error('簽名圖檔大小異常。');
  }
  const bytes = Utilities.base64Decode(encoded);
  if (bytes.length > SETTINGS.maxSignatureBytes) throw new Error('簽名圖檔超過限制。');
  // PNG 檔案簽章：避免把非 PNG 內容當成圖檔儲存。
  if (bytes.length < 8 || bytes.slice(0, 8).map(n => n & 255).join(',') !== '137,80,78,71,13,10,26,10') {
    throw new Error('簽名必須是 PNG 圖片。');
  }
  return bytes;
}

function storeSignature_(dataUrl, keyId) {
  const bytes = signatureBytes_(dataUrl);
  const parent = DriveApp.getFolderById(SETTINGS.signatureParentFolderId);
  const folders = parent.getFoldersByName(SETTINGS.signatureFolderName);
  const folder = folders.hasNext() ? folders.next() : parent.createFolder(SETTINGS.signatureFolderName);
  const name = 'signature_' + keyId + '_' +
    Utilities.formatDate(new Date(), SETTINGS.timezone, 'yyyyMMdd_HHmmss') + '_' +
    Utilities.getUuid().slice(0, 8) + '.png';
  return folder.createFile(Utilities.newBlob(bytes, 'image/png', name)).getId();
}

function str_(value) { return String(value === null || value === undefined ? '' : value).trim(); }

function locked_(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); }
  finally { lock.releaseLock(); }
}

/** 在 Apps Script 編輯器手動執行；只讀取，不修改試算表。 */
function checkSetup() {
  const result = getDashboard();
  console.log('檢查完成：' + result.keys.length + ' 把鑰匙');
  return result;
}


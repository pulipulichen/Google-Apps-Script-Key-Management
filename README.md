# 鑰匙管理平台（Google Apps Script）

使用 Google Apps Script Web App、Google Sheets、RFID 讀卡機及手寫簽名的鑰匙借還管理平台。

## 功能

- **借鑰匙**：左側僅顯示名稱與區域，不顯示內部 ID；可用名稱搜尋、區域篩選。借用人預設手寫簽名，也可改用人員 RFID。點選指定感應框、以 RFID 掃描鑰匙，核對內部 ID 與資料後自動借出。
- **還鑰匙**：不需選鑰匙、簽名或輸入人員資料。感應鑰匙 RFID 後，後端自動歸還，顯示鑰匙名稱、區域及存放位置。重複歸還時會提示目前已可借用。
- **鑰匙狀況**：顯示鑰匙總數、可借用與已借出數量，並可搜尋詳細資訊。

## 檔案

- **Code.gs**：Apps Script 伺服端，檢查借出狀態與 RFID、記錄 loan/log、存放簽名 PNG。
- **Index.html**：三入口網頁，手機、電腦皆可使用。
- **appsscript.json**：Apps Script V8 設定。
- **schema.yaml**：**人工參考文件**，描述 Google Sheets 表與欄位；Apps Script **不會讀取**，修改它也不會自動修改資料表或程式。

## 現有 Google Sheets

[鑰匙管理資料庫](https://docs.google.com/spreadsheets/d/1vXwer7b9briUVHCn-wx-iyb6X-m62PNwQMnFPX7JItw/edit)

- **key**：ID、名稱、區域、存放位置。ID 預設是鑰匙 RFID（例如 0001）；如果實際掃描 UID 不同，才另外新增 **RFID_UID** 欄位。
- **member**：人員 RFID 白名單，使用 `id` 比對卡號、`member_name` 記錄姓名。選擇人員 RFID 時會先驗證；不在名單內則顯示錯誤、自動切回手寫簽名，並且在借出寫入前由後端再次驗證。
- **loan**：借出時新增一列、歸還時更新同一列的 returned_at、return_rfid_uid、status。借用人的 RFID 存在 borrow_rfid_uid，或使用 borrow_signature_file_id 指向簽名 PNG。
- **log**：成功借出/歸還時新增稽核紀錄。掃描的鑰匙 RFID 存在 rfid_uid。

**請將鑰匙 ID 與 RFID 值儲存為純文字**，保留 0001 等前導零。存放位置允許空白；歸還畫面會直接隱藏空白的位置區塊。

簽名圖片會儲存在 Google Drive 上層資料夾 ID 為 1LO7B-j7AabHl8hSG23XAEyr0lCE6kp-c 之下的「鑰匙借用簽名檔」子資料夾（首次簽名時自動建立）。請勿公開分享此資料夾。

## 部署方式 A：直接複製貼上

1. 進入 [Google Apps Script](https://script.google.com/) 建立專案，或從 Google Sheet 的「擴充功能 → Apps Script」進入。
2. 貼入 **Code.gs**，另外新增名為 **Index** 的 HTML 檔案並貼入 **Index.html** 的內容。
3. 開啟專案設定、顯示資訊清單檔案，再依照本儲存庫的 **appsscript.json** 設定。
4. 在函式清單手動執行 **checkSetup**，授予 Google Sheets 與 Google Drive 權限，確認讀取正常。
5. 選「部署 → 新增部署作業 → 網頁應用程式」，選擇執行者和允許的存取對象，完成後使用產生的網址。

## 部署方式 B：Git 與 clasp 同步

需先安裝 Node.js 及 npm：

~~~bash
git clone https://github.com/pulipulichen/Google-Apps-Script-Key-Management.git
cd Google-Apps-Script-Key-Management
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "鑰匙管理平台"
clasp push
clasp open
~~~

之後每次修改 Git 版程式，再執行 **clasp push** 更新 Apps Script 專案。網頁應用程式的部署版本仍需在 Apps Script 中建立或更新。

## 權限與操作安全

- 若希望只有機構人員使用，部署時請選擇 Google Workspace 允許的「僅限機構」存取權，不要公開為任何人皆可使用。
- 「執行身分：我」會使用程式擁有者對 Sheets/Drive 的權限執行，必須確認 Web App 的存取者受限。個人 Google 帳號不一定有機構限定選項；單靠前端無法實現可靠權限限制。
- 借還狀態在伺服端重新驗證，並使用 LockService 降低重複借還的風險。
- 若 loan 寫入已成功但 log 失敗，介面顯示警告，不會誤回報借還失敗。
- **RFID 讀卡機模擬鍵盤**：先點選醒目的掃描框。讀卡機若輸入 Enter，立即處理；若未送 Enter，停止輸入 750ms 後處理。
- 上線前建議用測試鑰匙執行一次借出、查詢、歸還，核對 loan、log、簽名檔。
- 本次只提交 GitHub 原始碼，**尚未建立可直接使用的 Apps Script Web App 部署網址**。


## 2026-11-11：借出後仍顯示可借用（Issue #4）

原因：Google Sheets 曾將 `loan.key_id` 和 `log.key_id` 的 `0001` 自動轉成數字 `1`。鑰匙主檔仍是 `0001`，所以精確字串比對失敗，導致已借出誤判成可借用。

- 後端新增 `appendTypedRow_`：寫入借用紀錄和稽核日誌前，先將 ID/RFID 儲存格設成純文字。歸還 RFID 也依相同方式保留前導零。
- `getDashboard` 遇到同一把鑰匙多筆未歸還紀錄，顯示 `CONFLICT`（借用紀錄異常），不得重新借出；其歸還操作也會拒絕，以免不明確地結案其中一筆。
- 若發現 `BORROWED` 借用資料中的 `key_id` 無法精確對應 `key.ID`，則所有鑰匙暫時標成 `DATA_ERROR`（資料待查核），並暫停借還；**不自行去掉或補上前導零**。
- 舊資料已在備份後將兩筆 `loan.key_id` 與對應 `log.key_id`、`log.rfid_uid` 修成文字型 `0001`。但會議室鑰匙現在有 **兩筆原始未歸還紀錄（2026-11-11 23:04:53、23:13:32）**，各有簽名，為保留真實稽核證據，**未自行關閉／刪除任一筆**。
- 管理員需對照實際借用情況，判定哪筆是有效借用、哪筆屬於重複操作，再以可稽核方式修正狀態。**不可將未實際歸還的紀錄假寫為 `RETURNED`**。
- 變更 GitHub `main` 不會自動更新既有 Apps Script 網頁部署。請同步 `Code.gs` 和 `Index.html`，再在 Apps Script「部署 → 管理部署作業」更新網頁應用程式版本，否則使用者仍會看到舊程式。

修正後的本機回歸測試命令仍為 `node --test tests/*.test.cjs`。測試涵蓋前導零、未知鑰匙、兩筆未歸還紀錄、借還重試與前端狀態顯示。

## 修改執行設定

如需調整資料來源或簽名位置，修改 **Code.gs** 裡的 SETTINGS 常數：spreadsheetId、signatureParentFolderId、signatureFolderName、timezone。**schema.yaml 不參與執行。**


## 送出與重試（Issue #2、#3）

- 一般借出必須先選鑰匙並完成簽名，或通過 member 人員 RFID 驗證，才顯示第 3 步感應區。更換鑰匙、識別方式或清除簽名會清除舊感應資料。
- 感應後自動提交，顯示全畫面 Loading，封鎖背景滑鼠、觸控、鍵盤及 RFID Enter；以實際後端結果解除。
- 後端在 ScriptLock 內使用交易 ID 去重。第一次交易會自動建立 `transaction` 工作表，保存 request_id、action、fingerprint、status、result_json、updated_at。既有四表標題不需調整。不要刪除交易日誌或手動重用 ID。
- 借出以 request_id 作為 loan_id；歸還在同次 G:L 更新中將 `[return-request:交易ID]` 附加到 loan.note，供回應遺失時確認原結果。原有備註保留。
- 確定未寫入的錯誤保留表單、簽名與感應值，提供重試。連線錯誤或 45 秒未收到回應只表示「結果待確認」，不表示失敗；按「查詢原交易結果」確認。未登記時使用原 ID 與原資料重送，已登記時只核對原交易。
- 待確認交易與表單暫存於同一分頁的 sessionStorage，重新載入後仍需先查詢。含簽名資料的暫存會在取得確定結果後清除。請勿在結果未確認前清除瀏覽器資料或換分頁重新借還。
- 若交易已進入寫入階段但無法在 loan 找到完成證據，系統持續鎖定並請管理員核對，避免自動重試造成重複交易。復原成功但稽核 log 無法確認時，會提示管理員核對。
- 本次不包含尚未實作的 VIP 借出或手機待借單配對功能。

執行本機回歸測試：`node --test tests/*.test.cjs`。更新網站時必須同時同步 Code.gs 與 Index.html，再建立新的 Apps Script 部署版本。

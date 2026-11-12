# 鑰匙管理平台（Google Apps Script）

使用 Google Apps Script Web App、Google Sheets、RFID 讀卡機及手寫簽名的鑰匙借還管理平台。

## 功能

- **借鑰匙**：左側僅顯示名稱與區域，不顯示內部 ID；可用名稱搜尋、區域篩選。借用人預設手寫簽名，也可改用人員 RFID。點選指定感應框、以 RFID 掃描鑰匙，核對內部 ID 與資料後自動借出。
- **還鑰匙**：不需選鑰匙、簽名或輸入人員資料。感應鑰匙 RFID 後，後端自動歸還，顯示鑰匙名稱、區域及存放位置。重複歸還時會提示目前已可借用。
- **鑰匙狀況**：顯示借出狀態、目前借用人（member 名稱或手寫簽名預覽），並支援以鑰匙名稱、區域、借用人姓名搜尋（借用人資訊須經授權）。

## 檔案

- **Code.gs**：Apps Script 伺服端，檢查借出狀態與 RFID、記錄 loan/log、存放簽名 PNG。
- **Index.html**：三入口網頁，手機、電腦皆可使用。
- **appsscript.json**：Apps Script V8 設定。
- **schema.yaml**：**人工參考文件**，描述 Google Sheets 表與欄位；Apps Script **不會讀取**，修改它也不會自動修改資料表或程式。

## 公開資料庫 Demo（Google Sheets）

📖 **[查看公開 Google Sheets Demo：鑰匙管理資料庫 - 2026](https://docs.google.com/spreadsheets/d/1vXwer7b9briUVHCn-wx-iyb6X-m62PNwQMnFPX7JItw/edit?usp=sharing)**

這份試算表已開放「知道連結的任何人都可以檢視」，提供資料表分頁、欄位結構與資料格式的參考。下列為主要工作表：

> **使用前請先建立自己的試算表副本**，並在 `Code.gs` 的 `SETTINGS.spreadsheetId` 填入副本 ID。正式環境的鑰匙借還紀錄、人員 RFID、姓名與簽名檔不應寫入公開 Demo；Web App 仍須自行部署並設定存取權限。

- **key**：ID、名稱、區域、存放位置。ID 預設是鑰匙 RFID（例如 0001）；如果實際掃描 UID 不同，才另外新增 **RFID_UID** 欄位。
- **member**：人員 RFID 白名單，使用 `id` 比對卡號、`member_name` 記錄姓名。選擇人員 RFID 時會先驗證；不在名單內則顯示錯誤、自動切回手寫簽名，並且在借出寫入前由後端再次驗證。
- **loan**：借出時新增一列、歸還時更新同一列的 returned_at、return_rfid_uid、status。借用人的 RFID 存在 borrow_rfid_uid，或使用 borrow_signature_file_id 指向簽名 PNG。
- **log**：成功借出/歸還時新增稽核紀錄。掃描的鑰匙 RFID 存在 rfid_uid。

**請將鑰匙 ID 與 RFID 值儲存為純文字**，保留 0001 等前導零。存放位置允許空白；歸還畫面會直接隱藏空白的位置區塊。

簽名圖片會儲存在 Google Drive 上層資料夾 ID 為 1LO7B-j7AabHl8hSG23XAEyr0lCE6kp-c 之下的「鑰匙借用簽名檔」子資料夾（首次簽名時自動建立）。請勿公開分享此資料夾。

## 部署方式：直接複製貼上

1. 進入 [Google Apps Script](https://script.google.com/) 建立專案，或從 Google Sheet 的「擴充功能 → Apps Script」進入。
2. 貼入 **Code.gs**，另外新增名為 **Index** 的 HTML 檔案並貼入 **Index.html** 的內容。
3. 開啟專案設定、顯示資訊清單檔案，再依照本儲存庫的 **appsscript.json** 設定。
4. 在函式清單手動執行 **checkSetup**，授予 Google Sheets 與 Google Drive 權限，確認讀取正常。
5. 選「部署 → 新增部署作業 → 網頁應用程式」，選擇執行者和允許的存取對象，完成後使用產生的網址。

## 權限與操作安全

- 若希望只有機構人員使用，部署時請選擇 Google Workspace 允許的「僅限機構」存取權，不要公開為任何人皆可使用。
- 「執行身分：我」會使用程式擁有者對 Sheets/Drive 的權限執行，必須確認 Web App 的存取者受限。個人 Google 帳號不一定有機構限定選項；單靠前端無法實現可靠權限限制。
- 借還狀態在伺服端重新驗證，並使用 LockService 降低重複借還的風險。
- 若 loan 寫入已成功但 log 失敗，介面顯示警告，不會誤回報借還失敗。
- **RFID 讀卡機模擬鍵盤**：先點選醒目的掃描框。讀卡機若輸入 Enter，立即處理；若未送 Enter，停止輸入 750ms 後處理。
- 上線前建議用測試鑰匙執行一次借出、查詢、歸還，核對 loan、log、簽名檔。
- 感應送出後會顯示 Loading 並暫停其他操作。若遇連線錯誤或逾時，請使用「查詢原交易結果」確認是否已完成，避免重複借還。
- 修改原始碼後，需將更新同步到 Apps Script 專案，並於「部署 → 管理部署作業」更新網頁應用程式版本。

## 修改執行設定

如需調整資料來源或簽名位置，修改 **Code.gs** 裡的 SETTINGS 常數：spreadsheetId、signatureParentFolderId、signatureFolderName、timezone。**schema.yaml 不參與執行。**


借用人姓名與簽名僅對經授權的瀏覽者提供。手寫簽名圖片須由前台的「查看簽名」操作按需讀取，請勿公開分享簽名資料夾。

## 借用人與簽名查閱權限

在 Apps Script「專案設定 → 指令碼屬性」設定至少一項：

- `BORROWER_VIEWER_EMAILS`：允許查閱借用人／簽名的 Google 帳號，如 `admin@example.edu.tw,staff@example.edu.tw`。
- `BORROWER_VIEWER_DOMAINS`：可查閱的機構網域，如 `example.edu.tw`。只有整個機構網域都被授權時才設定，不建議使用 `gmail.com`。

伺服端以 `Session.getActiveUser().getEmail()` 辨識**目前瀏覽者**；若沒有 email 或不在白名單，一律不提供借用人姓名與簽名。特別注意：某些 Apps Script「以我身分執行」部署情境可能無法取得瀏覽者 email，此時系統會拒絕存取這些個資；不會使用可能指向程式擁有者的 `getEffectiveUser()` 代替瀏覽者。

**仍必須另外把 Web App 的部署存取對象限制在授權機構人員**。指令碼屬性白名單是個資的額外伺服端保護，不能取代部署存取限制；請勿將程式改成公開的「任何人」可存取。新增屬性後重新整理前台即可檢視；修改原始碼後需將異動同步到 Apps Script 並更新 Web App 部署版本。


## 授權

本專案原始碼採用 [MIT License](LICENSE) 授權。公開的 Google Sheets Demo 僅供參考資料表結構，請勿在其中填入正式環境的個人資料。

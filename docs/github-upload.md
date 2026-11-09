# GitHub 協作者登入與上傳

## 協作者的操作

1. 開啟裁切工作室，匯入 SVG 並建立裁切框。
2. 按「GitHub 上傳」，再按「使用 GitHub 登入」。每位協作者以自己的帳號授權。
3. 選擇「號誌設計指引」或「教材素材」，再逐層進入既有章節資料夾。
4. 按「預覽本次上傳」，檢查檔名及新增／取代狀態。
5. 如果有同名檔案，勾選確認取代，再按「確認上傳」。完成後可開啟這次 GitHub 更新紀錄。

上傳內容是所有裁切 SVG 與一份 `<原圖名稱>-crops.json`。原始 SVG 不會隨裁切成果上傳。登入只保留在目前頁面記憶體，重新整理後需再登入；GitHub 權限仍由各儲存庫管理。

## 目前的儲存位置

| 入口 ID | 儲存庫 | 分支 | 根目錄 |
| --- | --- | --- | --- |
| `guide` | `WeiLun-bot/road-signal-guide` | `main` | `media` |
| `materials` | `WeiLun-bot/traffic-guide` | `main` | `materials` |

根目錄與子資料夾皆須已存在。資料夾清單從 GitHub 讀取，使用者只能上傳到後端設定允許的位置。

## 管理者一次性啟用

GitHub Pages 只提供靜態網頁。`api/github.mjs` 與 `server/github.mjs` 需部署至支援 Node.js 24 的 Vercel Functions，負責登入驗證與 GitHub 提交。

### 1. 建立後端部署

將包含本功能的分支部署至 Vercel Production，取得固定網址，例如 `https://<project>.vercel.app`。專案已包含 `vercel.json`，不需要額外套件或前端建置。

瀏覽器要能直接存取此後端，API 的寫入操作由 GitHub 登入及儲存庫權限檢查保護。預覽環境若有額外的 Vercel 登入限制，不能直接當作協作者使用的正式登入服務。

### 2. 註冊並安裝 GitHub App

由儲存庫管理者在 [GitHub Developer settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new) 註冊：

| 欄位 | 設定 |
| --- | --- |
| GitHub App name | 取一個未被使用的名稱，例如 `WeiLun SVG Crop Studio` |
| Homepage URL | `https://weilun-bot.github.io/svg-crop-pages/` |
| Callback URL | `https://<project>.vercel.app/api/github/auth/callback` |
| Expire user authorization tokens | 保持啟用 |
| Webhook → Active | 取消勾選；本功能不使用 webhook |
| Repository permissions → Contents | Read and write |
| Repository permissions → Metadata | Read-only（GitHub 預設提供） |

若協作者來自其他 GitHub 帳號，註冊時選擇可讓其他帳號使用的公開 GitHub App。實際安裝時，先只在 `WeiLun-bot` 帳號選取 `road-signal-guide` 與 `traffic-guide` 這兩個儲存庫。

建立後取得 **Client ID**，並產生一個 **Client secret**。這個流程使用協作者的 user access token，無需提供 App 私鑰，也無需共用管理者的個人 access token。協作者仍須在目標儲存庫擁有 Write、Maintain 或 Admin 權限。

參考：[GitHub App 使用者授權](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)。

### 3. 設定後端環境變數

在 Vercel 的專案 Environment Variables 設定下列 Production 值，將 secret 欄位設為敏感資料；設定完成後重新部署。

| 名稱 | 值 |
| --- | --- |
| `GITHUB_CLIENT_ID` | 上一步的 Client ID |
| `GITHUB_CLIENT_SECRET` | 上一步的 Client secret，僅存後端 |
| `SESSION_SECRET` | 32 bytes 隨機金鑰的 base64url 字串，僅存後端 |
| `BACKEND_ORIGIN` | `https://<project>.vercel.app`，不含結尾斜線 |
| `FRONTEND_URL` | `https://weilun-bot.github.io/svg-crop-pages/` |

產生 SESSION_SECRET：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Client secret 與 SESSION_SECRET 不應填入前端設定、GitHub 原始碼或聊天訊息。需要本機設定時，可使用 Git 已忽略的 `.env` 檔，參考 `.env.example`。

### 4. 接上 GitHub Pages

在 `github-config.json` 填入公開後端網址：

```json
{
  "backendOrigin": "https://<project>.vercel.app"
}
```

將程式與這份設定合併、推送到 `main`，等待 GitHub Pages 部署完成。前端設定只含公開網址。

若直接使用 Vercel 的 `*.vercel.app` 網址開啟工具，未填 `backendOrigin` 時會使用同一網域的後端；此時需將 `FRONTEND_URL` 改為實際工具網址。網址設定只允許一個前端來源。

### 5. 驗證正式權限

1. 管理者登入，確認兩個入口和現有子資料夾能讀取。
2. 協作者登入，確認只會出現其具有寫入權限的入口。
3. 上傳到選定測試資料夾，確認 SVG 與 JSON 出現在同一筆 commit。
4. 以沒有寫入權限的帳號測試，確認不能瀏覽／上傳。
5. 同名檔案會先要求確認；兩位使用者同時預覽再提交，後提交者應收到重新預覽提示。

自動測試涵蓋模擬登入、後端權限、路徑範圍、檔案預覽與並行更新。正式 GitHub OAuth 與實際寫入仍須在 App 註冊、安裝及後端部署後驗證。

## 之後整合教材與主要指引

位置集中在 `server/targets.mjs`。也可以在後端設定 `GITHUB_UPLOAD_TARGETS` JSON 環境變數取代預設清單，保留 `guide`、`materials` 這兩個入口 ID。

例如，日後將教材素材實際搬入 `road-signal-guide/media/materials` 並更新教材引用後，可將 `materials` 入口調整為：

```json
{
  "id": "materials",
  "label": "教材素材",
  "owner": "WeiLun-bot",
  "repo": "road-signal-guide",
  "branch": "main",
  "root": "media/materials"
}
```

這只會改變之後的上傳目的地；檔案搬移與既有教材引用更新需另外執行。位置設定變更後，舊的上傳預覽會失效，使用者須重新選擇、預覽。

## 本機開發

使用 Node.js 24，複製 `.env.example` 為未追蹤的 `.env`，並將本機網址設定為：

```text
BACKEND_ORIGIN=http://127.0.0.1:8787
FRONTEND_URL=http://127.0.0.1:8787/
```

GitHub App 的 Callback URL 也須與本機 `/api/github/auth/callback` 一致，建議使用獨立的開發 App。執行 `npm run dev` 開啟預覽，執行 `npm test` 驗證模擬 GitHub 流程。

目前每次最多 64 個檔案（含一份設定 JSON），JSON 請求總量上限 4 MB。受分支保護規則限制而不能直接提交的儲存庫，需要另外增加 Pull Request 流程。

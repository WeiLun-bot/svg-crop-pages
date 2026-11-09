# SVG 裁切工作室 — GitHub Pages 部署包

這是 SVG 裁切工作室 v14。裁切與本機儲存可直接在瀏覽器執行，不需要後端；GitHub 協作者登入上傳則需要另外部署登入服務。

線上使用：[SVG 裁切工作室](https://weilun-bot.github.io/svg-crop-pages/)

原始碼：[WeiLun-bot/svg-crop-pages](https://github.com/WeiLun-bot/svg-crop-pages)

## GitHub Pages 部署

1. 在 GitHub 建立新的儲存庫（本專案為 `svg-crop-pages`）。如果使用 GitHub Pages 公開網站，請不要把內部專案原始 SVG、裁切設定 JSON、報告圖資或機密檔案一起上傳。
2. 將 `index.html`、`.nojekyll`、`github-upload.js`、`github-upload.css` 和 `github-config.json` 放在儲存庫根目錄。`README.md` 可一併上傳。
3. 前往儲存庫 **Settings → Pages**。
4. **Build and deployment → Source** 選擇 **Deploy from a branch**；選 `main` 和 `/(root)`，再按 **Save**。
5. 本專案網址為 `https://weilun-bot.github.io/svg-crop-pages/`。若部署到其他帳號或儲存庫，實際網址以 Pages 頁面顯示為準。

## 使用提醒

- 本工具會在瀏覽器內處理使用者自行開啟的 SVG；GitHub Pages 僅用於提供工具網頁，不會因此把匯入的 SVG 自動上傳到 GitHub。
- 使用最新 Chrome / Edge，可在獲得授權後使用「選擇位置」將 SVG / JSON 儲存到電腦指定資料夾；其他瀏覽器相容性可能不同。
- 使用者各自的裁切設定須以 JSON 備份、交換；目前不是多人即時協作應用。
- 瀏覽器可能在重新進站後要求再次授權資料夾；換網域或重新開啟時不保證保留相同權限。

## GitHub 協作者上傳

「GitHub 上傳」可讓具有寫入權限的協作者選擇下列位置的既有子資料夾，預覽檔案後一次提交裁切 SVG 與原圖對應的設定 JSON：

| 入口 | 儲存庫 | 資料夾 |
| --- | --- | --- |
| 號誌設計指引 | `WeiLun-bot/road-signal-guide` | `media/` |
| 教材素材 | `WeiLun-bot/traffic-guide` | `materials/` |

後端已部署到 `https://svg-crop-pages.vercel.app`，並由 `github-config.json` 連接。登入上傳仍需完成 [GitHub App 與後端金鑰設定](docs/github-upload.md)，才會開放登入。

登入與上傳使用各協作者自己的 GitHub 授權；設定清單只開放上述根目錄及其子資料夾。同名檔案須明確確認取代，多人同時更新時會要求重新預覽。

## 開發與驗證

安裝 Node.js 24 後執行 `npm test`。後端測試使用模擬 GitHub API，不會修改實際儲存庫；瀏覽器測試使用 Windows Edge，其他環境可用 `EDGE_PATH` 指定 Chromium 瀏覽器。

執行 `npm run dev` 可開啟本機預覽；正式 GitHub 登入的環境設定見部署文件。

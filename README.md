# SVG 裁切工作室 — GitHub Pages 部署包

這是 SVG 裁切工作室 v14 的靜態網頁部署包，不需要 Node.js、Python 或後端伺服器。

線上使用：[SVG 裁切工作室](https://weilun-bot.github.io/svg-crop-pages/)

原始碼：[WeiLun-bot/svg-crop-pages](https://github.com/WeiLun-bot/svg-crop-pages)

## GitHub Pages 部署

1. 在 GitHub 建立新的儲存庫（本專案為 `svg-crop-pages`）。如果使用 GitHub Pages 公開網站，請不要把內部專案原始 SVG、裁切設定 JSON、報告圖資或機密檔案一起上傳。
2. 把此資料夾中的 `index.html`、`.nojekyll` 上傳到儲存庫根目錄。`README.md` 可一併上傳。
3. 前往儲存庫 **Settings → Pages**。
4. **Build and deployment → Source** 選擇 **Deploy from a branch**；選 `main` 和 `/(root)`，再按 **Save**。
5. 本專案網址為 `https://weilun-bot.github.io/svg-crop-pages/`。若部署到其他帳號或儲存庫，實際網址以 Pages 頁面顯示為準。

## 使用提醒

- 本工具會在瀏覽器內處理使用者自行開啟的 SVG；GitHub Pages 僅用於提供工具網頁，不會因此把匯入的 SVG 自動上傳到 GitHub。
- 使用最新 Chrome / Edge，可在獲得授權後使用「選擇位置」將 SVG / JSON 儲存到電腦指定資料夾；其他瀏覽器相容性可能不同。
- 使用者各自的裁切設定須以 JSON 備份、交換；目前不是多人即時協作應用。
- 瀏覽器可能在重新進站後要求再次授權資料夾；換網域或重新開啟時不保證保留相同權限。

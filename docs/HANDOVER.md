# 接手指南

這份文件寫給想把這個站在**自己的環境**重新架起來的人。原維護者無法繼續時，任何人都可以
clone 這個 repo、拿公開的資料備份，把站接續下去——站台採共筆、程式與資料備份都公開，就是為了這件事。

架構總覽在 [README.md](../README.md)，開發時的細節與踩過的坑在 [CLAUDE.md](../CLAUDE.md)。
這裡只講三件事：哪些東西要自備、從零到上線的順序、上線後怎麼維護。

## 1. 拿得到的、要自備的、拿不到的

**拿得到**

- 程式與部署範本：這個 repo。
- 資料：[`maisakiberryfan/sqlBackUp`](https://github.com/maisakiberryfan/sqlBackUp) 的
  `latest_mbdb.sql`，整庫備份，資料表結構也在裡面（repo 內沒有另外的 schema 檔）。
- 站內圖片與音檔：`fansite/img/`。

**要自備**

- AWS 帳號（主站）。Cloudflare 帳號只有要做備用站才需要。
- 一個網域，以及 **us-east-1** 的 ACM 憑證（要涵蓋 `你的網域` 與 `www.你的網域`）。
- 一台能從網際網路連線、啟用 TLS 的 MariaDB。
- YouTube Data API v3 金鑰。
- 一個 GitHub repo（fork 或新建）與它的 Actions secrets。

**拿不到**

- 原網域 `m-b.win`、原本的雲端帳號與所有密鑰。
- 年表（`fansite/pages/history.md`）的自動更新：原站由 repo 以外的私人工具維護。
  沒有它就手動編輯這個檔，格式照既有條目即可。
- Discord 通知頻道：要的話自己建 webhook，不設也能跑。

## 2. 資料庫

備份是 MariaDB 11.8 產生的，內容是四張表（`songlist`、`streamlist`、`setlist_ori`、`aliases`）
加一個 `setlist` VIEW。

```bash
curl -LO https://raw.githubusercontent.com/maisakiberryfan/sqlBackUp/main/latest_mbdb.sql
mariadb -u root -p -e "CREATE DATABASE mbdb CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
mariadb -u root -p mbdb < latest_mbdb.sql
```

- VIEW 的 `DEFINER` 是 `root@localhost`，用 root 匯入最省事。
- 匯入後另建一個應用程式專用帳號，只給這個資料庫的讀寫權限。**不要讓網站用 root 連線。**
- 主站的 Lambda 不在 VPC 內，是從公網直連資料庫，所以資料庫要能被外部連到，而且**必須啟用 TLS**
  （程式固定以 TLS 連線、不驗證憑證鏈，自簽憑證即可）。
- 要測試寫入功能時，把同一份備份再匯入成 `mbdb_test`，測試一律連它。
- `updatedAt` 欄位的自動刷新是快取正確性的前提，維護資料前先讀 CLAUDE.md 的「Meta ETag」一節。
- 自己的備份：`scripts/backup-and-export.sh` 與 `scripts/SETUP.md` 是原站用的備份管線
  （定期匯出、推到 GitHub），可以照著設。

## 3. 把寫死的值換成你的

全 repo 搜尋 `m-b.win`，逐一換成你的網域；另外下面這些是別人的環境值，一定要換：

| 位置 | 要換的東西 |
|------|-----------|
| `template.yaml` | `DomainName` 的預設值；`CfDistributionId` 的預設值（第一次部署後才拿得到，見第 4 節） |
| `src/config.js` | 要追蹤的 YouTube 頻道 ID、CORS 允許的來源、歌單留言的優先作者（頻道 ID 與帳號名） |
| `lambda/setlist-matcher/` | `template.yaml`、`samconfig.toml` 的 `BerrySiteApiUrl`，`src/handler.js` 的後備網址，以及四支測試腳本裡的 API 網址 |
| `fansite-v2/scripts/og-config.mjs`、`fansite-v2/index.html` | 分享預覽用的絕對網址 |
| `fansite-v2/scripts/fetch-snapshot.mjs`、`src/cron-jobs/snapshot.js` | 靜態快照的資料來源網址 |
| `wrangler.toml` | Hyperdrive 的 `id`、`LAMBDA_MATCHER_URL`（只有做備用站才需要） |

## 4. 部署主站（AWS）

區域是 `ap-northeast-1`（寫在 `.github/workflows/deploy.yml` 的 `AWS_REGION`）。
一共兩個 SAM stack：`berry-site`（主站）與 `berry-setlist-matcher`（歌單比對）。
**它們互相需要對方的網址**，所以全新的環境要照這個順序：

1. **部署角色**：建立 GitHub Actions 用的 OIDC 角色，ARN 設成 secret `AWS_ROLE_ARN`。
   角色要能建立這兩個 stack 用到的資源：CloudFormation、Lambda、API Gateway、S3、CloudFront、
   IAM、EventBridge、CloudWatch Logs。
2. **憑證**：在 us-east-1 申請 ACM 憑證，ARN 設成 secret `ACM_CERTIFICATE_ARN`。
3. **先手動部署一次比對服務**——它的網址是主站的必填參數：

   ```bash
   cd lambda/setlist-matcher
   sam build
   sam deploy --stack-name berry-setlist-matcher --capabilities CAPABILITY_IAM --resolve-s3 \
     --parameter-overrides BerrySiteApiUrl=https://<你的網域> FunctionTimeout=29
   ```

   輸出的 `ApiEndpoint` 設成 secret `LAMBDA_MATCHER_URL`。
4. **其餘 secrets**：照 README 的「需要的 Secrets」設定。
5. **push 到 `main`**，兩支 workflow 會自動部署。第一次推送時，比對服務那個 job 可能因為主站
   stack 還沒建好而失敗；主站部署成功後重跑該 job 即可，它會把比對服務指向你的主站。
6. **部署完成後**
   - 把網域的 DNS 指向 CloudFront（stack 輸出 `CloudFrontUrl`）。
   - 把 stack 輸出的 `CloudFrontDistributionId` 填回 `template.yaml` 的 `CfDistributionId` 預設值，
     再 push 一次。縮圖換圖後清快取要用到它。
   - 訂閱 YouTube 的新影片通知，指令在 CLAUDE.md 的「PubSubHubbub 訂閱」。
   - 開 `https://<你的網域>/health`，確認資料庫連得上。

### 建議設上的保護

這三個都是選配，不設也能跑，但正式環境建議全部設上：

- `MATCHER_SHARED_SECRET`：比對服務的網址在公開 repo 裡看得到，不設的話任何人都能直接呼叫它、
  花你的 Lambda 費用。設一個夠長的隨機字串當 GitHub secret；有做備用站的話，
  用 `wrangler secret put MATCHER_SHARED_SECRET` 設同一個值。範本另外有每秒 1 次的節流當兜底。
- `ORIGIN_VERIFY_SECRET`：讓限流能認出訪客的真實 IP。
- `TRIGGER_TOKEN`：手動觸發端點與 YouTube 通知簽章都靠它，務必設。

## 5. 備用站（Cloudflare，可以不做）

- 建一個 Hyperdrive 指向你的資料庫，`id` 填進 `wrangler.toml`，並**關閉 query cache**
  （原因在 CLAUDE.md 的「Hyperdrive」一節）。
- 用 `wrangler secret put` 設定 README 列出的 Worker secrets。
- GitHub secrets 設 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。
- 不做備用站的話，把 `.github/workflows/deploy-cf.yml` 停用或刪掉，否則每次 push 都會失敗一次。

## 6. 本機開發

見 README 的「本地開發」。連資料庫的那條路徑需要自己建到資料庫主機的 ssh tunnel。

## 7. 上線之後怎麼維護

| 要做的事 | 怎麼做 |
|---------|--------|
| 歌曲、直播、歌單、別名 | 在站上直接編輯。寫入不需要登入，只有限流 |
| 新影片與歌單 | 排程會自動抓新影片，直播結束後從留言解析歌單。機制與防呆在 CLAUDE.md 的「Cron Triggers」與「歌單解析防護」 |
| 新專輯 | `fansite-v2/CLAUDE.md` 的「新專輯發售時的更新清單」 |
| 新衣裝 | `fansite-v2/src/pages/clothesData.js` 加條目、補圖片與分享卡，說明在 `fansite-v2/CLAUDE.md` |
| 年表 | 手動編輯 `fansite/pages/history.md` |
| 首頁的「最近更新」 | `fansite/changelog.json`，三語各一句 |
| 新增或改名頁面路徑 | 路由白名單有好幾份要一起改，見 CLAUDE.md 的「SPA 路由白名單」 |

## 8. 關於素材

站內的專輯封面、立繪、BGM 等取自官方網站與 YouTube 影片，權利屬於原權利人。
接手前請自行確認使用範圍。

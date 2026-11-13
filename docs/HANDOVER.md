# 接手指南

這份文件寫給想把這個站在**自己的環境**重新架起來的人。原維護者無法繼續時，任何人都可以
clone 這個 repo、拿公開的資料備份，把站接續下去——站台採共筆、程式與資料備份都公開，就是為了這件事。

架構總覽在 [README.md](../README.md)，開發時的細節與踩過的坑在 [CLAUDE.md](../CLAUDE.md)。
這裡只講：哪些東西要自備、資料怎麼還原、兩條部署路線、上線後怎麼維護。

## 1. 拿得到的、要自備的、拿不到的

**拿得到**

- 程式與部署範本：這個 repo。
- 資料：[`maisakiberryfan/sqlBackUp`](https://github.com/maisakiberryfan/sqlBackUp) 的
  `latest_mbdb.sql`，整庫備份，資料表結構也在裡面（repo 內沒有另外的 schema 檔）。

**要自備**

- 一個網域。
- 一台 MariaDB。
- YouTube Data API v3 金鑰。Discord 通知要用的話另外準備 webhook。**這些都用你自己申請的**，
  包括下面會提到的各種密鑰——不要沿用任何現成的值。
- 跑程式的地方，兩條路線擇一（見第 4 節）：一台 VPS，或 AWS 帳號。

**拿不到**

- 原網域 `m-b.win`、原本的主機與雲端帳號、所有密鑰。
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
- 要測試寫入功能時，把同一份備份再匯入成 `mbdb_test`，測試一律連它。
- `updatedAt` 欄位的自動刷新是快取正確性的前提，維護資料前先讀 CLAUDE.md 的「Meta ETag」一節。
- 自己的備份：`scripts/backup-and-export.sh` 與 `scripts/SETUP.md` 是原站用的備份管線
  （定期匯出、推到 GitHub），可以照著設。

資料庫要不要對外開放、要不要開 TLS，取決於你選哪條路線，見下一節的對照表。

## 3. 把寫死的值換成你的

全 repo 搜尋 `m-b.win`，逐一換成你的網域。兩條路線都要換的：

| 位置 | 要換的東西 |
|------|-----------|
| `src/config.js` | 要追蹤的 YouTube 頻道 ID、CORS 允許的來源、歌單留言的優先作者（頻道 ID 與帳號名） |
| `fansite-v2/scripts/og-config.mjs`、`fansite-v2/index.html` | 分享預覽用的絕對網址 |
| `fansite-v2/public/robots.txt` | 站台網址 |

只有路線 B（AWS＋Cloudflare）才要換的：

| 位置 | 要換的東西 |
|------|-----------|
| `template.yaml` | `DomainName` 的預設值；`CfDistributionId` 的預設值（第一次部署後才拿得到） |
| `lambda/setlist-matcher/` | `template.yaml`、`samconfig.toml` 的 `BerrySiteApiUrl`，`src/handler.js` 的後備網址 |
| `fansite-v2/scripts/fetch-snapshot.mjs`、`src/cron-jobs/snapshot.js` | 靜態快照的資料來源網址 |
| `wrangler.toml` | Hyperdrive 的 `id`、`LAMBDA_MATCHER_URL`（只有做備用站才需要） |

## 4. 選一條部署路線

| | 路線 A：單機 | 路線 B：AWS＋Cloudflare |
|---|---|---|
| 需要 | 一台裝了 Docker 的 VPS | AWS 帳號；做備用站再加 Cloudflare 帳號 |
| 資料庫 | 和網站同一台，**不必對外開放** | 必須能從網際網路連線，且要開 TLS |
| 靜態檔、API | 同一個容器裡的 Node 程序 | S3＋CloudFront、Lambda |
| 排程、歌單比對 | 內建在同一個程序 | EventBridge、另一個 Lambda |
| 影片縮圖 | 直接用 YouTube 的圖 | 另存一份到 S3 |
| 費用 | VPS 月費 | 用量小時多在免費額度內 |
| 實際運行過嗎 | 2026-11 在開發機上用 Docker、以公開備份整組跑起來測過，**沒有在正式環境長期跑過** | 原站現行的架構 |

只能跑 PHP 或只放靜態檔的虛擬主機不行：這個站需要常駐的 Node 程序、MariaDB 和排程。

### 路線 A：單機（Docker）

repo 根目錄的 `docker-compose.yml` 會起三個容器：網站、MariaDB、反向代理（Caddy）。
對外只有 80／443；資料庫和網站程式都不對外。

1. **準備**：一台裝了 Docker 的主機，把網域的 DNS 指到它。
2. **取得程式與資料**

   ```bash
   git clone <你的 repo> berry-site && cd berry-site
   curl -L -o db-init/latest_mbdb.sql https://raw.githubusercontent.com/maisakiberryfan/sqlBackUp/main/latest_mbdb.sql
   cp .env.example .env
   ```

   `db-init/` 裡的備份只會在資料庫第一次啟動、還是空的時候匯入一次。
3. **填 `.env`**（只需要「單機部署」那一段和幾個金鑰）：

   | 變數 | 填什麼 |
   |------|--------|
   | `SITE_ADDRESS` | 你的網域，例 `example.com, www.example.com` |
   | `DB_PASSWORD`、`DB_ROOT_PASSWORD` | 各自產生一組夠長的隨機密碼 |
   | `TRIGGER_TOKEN` | 夠長的隨機字串。手動觸發端點與 YouTube 通知的簽章都靠它 |
   | `YOUTUBE_API_KEY` | 你自己的 YouTube Data API v3 金鑰。沒有它，排程抓不到新影片 |
   | `PUBSUB_CALLBACK_URL` | `https://<你的網域>/webhook/youtube`。留空就不訂閱即時通知，新影片改由每日排程補抓 |
   | `DISCORD_WEBHOOK_URL` | 選填 |

   資料庫位址、是否走 TLS、歌單比對用哪一份，這些由 compose 決定，不用在 `.env` 裡設。
4. **啟動**

   ```bash
   docker compose up -d --build
   docker compose logs -f app     # 看到 [entry-node] 那一行就是起來了
   ```

   反向代理會自動申請憑證。開 `https://<你的網域>/health` 確認資料庫連得上。

**日常操作**

| 要做的事 | 指令 |
|---------|------|
| 更新程式 | `git pull && docker compose up -d --build` |
| 備份資料庫 | `docker compose exec db sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines mbdb' > backup.sql` |
| 看排程有沒有在跑 | `docker compose logs app \| grep cron` |

只改年表或首頁的「最近更新」不用重建，容器直接讀主機上的那兩個檔。

**幾件要知道的事**

- 排程、歌單比對、資料快照都內建在網站容器裡，不需要另外設定。影片縮圖直接用 YouTube 的圖。
- 限流要認得訪客的位址，靠的是反向代理附上的 `X-Forwarded-For`。compose 已經把內部網段設成
  受信任的代理（`TRUSTED_PROXIES`）；如果你改了網段，或在前面再加一層 CDN，要一起調整，
  否則所有訪客會被算成同一個人。
- 歌單比對和網站跑在同一個程序裡，解析歌單的那幾秒 API 回應會變慢。
- 不想用 Docker 也可以直接用 Node 跑，做法寫在 [`entry-node.js`](../entry-node.js) 的檔頭。
- 實測過的範圍（2026-11）：從公開備份還原、不走 TLS 的資料庫連線、經反向代理的靜態檔與壓縮、
  頁面路由與分享預覽、內建歌單比對、依訪客位址分桶的限流、自動產生資料快照、
  沒有 YouTube 金鑰時排程工作不會拖垮服務。**沒測過**：真實網域與憑證、YouTube 即時通知、
  有金鑰時排程實際抓取與寫入。

### 路線 B：AWS＋Cloudflare

區域是 `ap-northeast-1`（寫在 `.github/workflows/deploy.yml` 的 `AWS_REGION`）。
一共兩個 SAM stack：`berry-site`（主站）與 `berry-setlist-matcher`（歌單比對）。
**它們互相需要對方的網址**，所以全新的環境要照這個順序：

1. **資料庫**：主站的 Lambda 不在 VPC 內，是從公網直連資料庫，所以資料庫要能被外部連到，
   而且**必須啟用 TLS**（程式固定以 TLS 連線、不驗證憑證鏈，自簽憑證即可）。
2. **部署角色**：建立 GitHub Actions 用的 OIDC 角色，ARN 設成 secret `AWS_ROLE_ARN`。
   角色要能建立這兩個 stack 用到的資源：CloudFormation、Lambda、API Gateway、S3、CloudFront、
   IAM、EventBridge、CloudWatch Logs。
3. **憑證**：在 **us-east-1** 申請 ACM 憑證（要涵蓋 `你的網域` 與 `www.你的網域`），
   ARN 設成 secret `ACM_CERTIFICATE_ARN`。
4. **先手動部署一次比對服務**——它的網址是主站的必填參數：

   ```bash
   cd lambda/setlist-matcher
   sam build
   sam deploy --stack-name berry-setlist-matcher --capabilities CAPABILITY_IAM --resolve-s3 \
     --parameter-overrides BerrySiteApiUrl=https://<你的網域> FunctionTimeout=29
   ```

   輸出的 `ApiEndpoint` 設成 secret `LAMBDA_MATCHER_URL`。
5. **其餘 secrets**：照 README 的「需要的 Secrets」設定。
6. **push 到 `main`**，兩支 workflow 會自動部署。第一次推送時，比對服務那個 job 可能因為主站
   stack 還沒建好而失敗；主站部署成功後重跑該 job 即可，它會把比對服務指向你的主站。
7. **部署完成後**
   - 把網域的 DNS 指向 CloudFront（stack 輸出 `CloudFrontUrl`）。
   - 把 stack 輸出的 `CloudFrontDistributionId` 填回 `template.yaml` 的 `CfDistributionId` 預設值，
     再 push 一次。縮圖換圖後清快取要用到它。
   - 訂閱 YouTube 的新影片通知，指令在 CLAUDE.md 的「PubSubHubbub 訂閱」。
   - 開 `https://<你的網域>/health`，確認資料庫連得上。

**建議設上的保護**（都是選配，不設也能跑）：

- `MATCHER_SHARED_SECRET`：比對服務的網址在公開 repo 裡看得到，不設的話任何人都能直接呼叫它、
  花你的 Lambda 費用。設一個夠長的隨機字串當 GitHub secret；有做備用站的話，
  用 `wrangler secret put MATCHER_SHARED_SECRET` 設同一個值。範本另外有節流當兜底。
- `ORIGIN_VERIFY_SECRET`：讓限流能認出訪客的真實 IP。
- `TRIGGER_TOKEN`：手動觸發端點與 YouTube 通知簽章都靠它，務必設。

**備用站（Cloudflare，可以不做）**

- 建一個 Hyperdrive 指向你的資料庫，`id` 填進 `wrangler.toml`，並**關閉 query cache**
  （原因在 CLAUDE.md 的「Hyperdrive」一節）。
- 用 `wrangler secret put` 設定 README 列出的 Worker secrets。
- GitHub secrets 設 `CLOUDFLARE_API_TOKEN` 與 `CLOUDFLARE_ACCOUNT_ID`。
- 不做備用站的話，把 `.github/workflows/deploy-cf.yml` 停用或刪掉，否則每次 push 都會失敗一次。

走路線 A 的人則相反：`.github/workflows/` 裡的兩支 workflow 都用不到，可以整個停用。

## 5. 本機開發

見 README 的「本地開發」。資料庫不在本機時，要自己建到資料庫主機的 ssh tunnel。

## 6. 上線之後怎麼維護

| 要做的事 | 怎麼做 |
|---------|--------|
| 歌曲、直播、歌單、別名 | 在站上直接編輯。寫入不需要登入，只有限流 |
| 新影片與歌單 | 排程會自動抓新影片，直播結束後從留言解析歌單。機制與防呆在 CLAUDE.md 的「Cron Triggers」與「歌單解析防護」 |
| 新專輯 | `fansite-v2/CLAUDE.md` 的「新專輯發售時的更新清單」 |
| 新衣裝 | `fansite-v2/src/pages/clothesData.js` 加條目、補圖片與分享卡，說明在 `fansite-v2/CLAUDE.md` |
| 年表 | 手動編輯 `fansite/pages/history.md` |
| 首頁的「最近更新」 | `fansite/changelog.json`，三語各一句 |
| 新增或改名頁面路徑 | 路由白名單有好幾份要一起改，見 CLAUDE.md 的「SPA 路由白名單」 |

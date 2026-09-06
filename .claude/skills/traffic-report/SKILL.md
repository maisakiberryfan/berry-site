---
name: traffic-report
description: "Generate CloudFront traffic analysis report. Use when user asks for traffic report, IP analysis, bot analysis, or access log review for m-b.win."
argument-hint: "[from-date] [to-date]"
allowed-tools: Bash, Read, Write, Glob, Grep
---

# CloudFront Traffic Analysis Report

Generate a traffic analysis report for m-b.win using CloudFront access logs stored in S3.

## Invocation

- `/traffic-report` — 從上次報告結束時間到現在
- `/traffic-report 2026-03-20 2026-03-21` — 自定義時間區間

## Time Rules

### 顯示規則
**所有對用戶顯示的時間一律使用台灣時間（UTC+8）**，格式為 `YYYY-MM-DD HH:MM:SS (台灣時間)`。

### 取得時間
```bash
date '+%Y-%m-%d %H:%M:%S'       # 台灣時間（系統時區 UTC+8）
date -u '+%Y-%m-%d %H:%M:%S'    # UTC
```

### 儲存規則
`cf-report-last.txt` 格式為 `YYYY-MM-DD HH:MM:SS UTC`（UTC 時間）。

## Execution Steps

### Step 0: Verify Current Time

```bash
echo "目前時間：$(date '+%Y-%m-%d %H:%M:%S') (台灣時間) / $(date -u '+%Y-%m-%d %H:%M:%S') UTC"
```

### Step 1: Determine Time Range

Read the last report timestamp from:
```
C:\Users\katy\.claude\projects\E--website-berry-pro\cf-report-last.txt
```

- If the file exists, use its content as the start time (台灣時間)
- If the file doesn't exist, start from the earliest available log
- If user provided `$0` and `$1` arguments, use those as from-date and to-date instead
- End time is always "now" (unless user specified `$1`)
- 顯示時間區間給用戶確認後，再進行下一步
- **比對日誌檔案時，將台灣時間轉為 UTC（-8 小時）來篩選檔名中的時間戳**

### Step 2: Download Logs from S3

```bash
mkdir -p C:/Users/katy/.claude/projects/E--website-berry-site/cf-logs
MSYS_NO_PATHCONV=1 aws s3 sync s3://berry-cloudfront-logs-495219733379/cf-logs/ C:/Users/katy/.claude/projects/E--website-berry-site/cf-logs/ --delete --region ap-northeast-1
```

- 本地檔案持久保留，sync 只下載新增檔案
- `--delete`：S3 30 天過期後，本地也會在下次 sync 時自動清除（只刪本地，不動 S3）
- 日誌檔名格式：`E2J83LAK96PIJH.YYYY-MM-DD-HH.*.gz`（UTC 時間）

### Step 2.5: Ensure GeoIP DB (DB-IP Lite, Free, Monthly Update)

```bash
SKILL_DIR="e:/website/berry-site/.claude/skills/traffic-report"
MMDB="$SKILL_DIR/dbip-country-lite.mmdb"

# 若不存在或 > 35 天舊則重新下載
NEED_DOWNLOAD=1
if [ -f "$MMDB" ]; then
  AGE=$(( ($(date +%s) - $(stat -c%Y "$MMDB" 2>/dev/null || stat -f%m "$MMDB")) / 86400 ))
  [ "$AGE" -lt 35 ] && NEED_DOWNLOAD=0
fi

if [ "$NEED_DOWNLOAD" = "1" ]; then
  for YM in $(date +%Y-%m) $(date -d '1 month ago' +%Y-%m 2>/dev/null || date -v-1m +%Y-%m); do
    URL="https://download.db-ip.com/free/dbip-country-lite-${YM}.mmdb.gz"
    if curl -sLf --max-time 60 -o "$MMDB.gz" "$URL"; then
      gunzip -f "$MMDB.gz" && break
    fi
  done
fi
```

DB-IP Lite 授權：[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — 公開展示報告需註明 "IP geolocation by DB-IP"。

### Step 3: Parse and Decompress Logs

**CloudFront Log Fields (tab-separated):**
```
$1  date                    $10 cs(Referer)
$2  time                    $11 cs(User-Agent) (URL-encoded)
$3  x-edge-location         $12 cs-uri-query
$4  sc-bytes                $13 cs(Cookie)
$5  c-ip                    $14 x-edge-result-type
$6  cs-method               $15 x-edge-request-id
$7  cs(Host)                $16 x-host-header
$8  cs-uri-stem             $17 cs-protocol
$9  sc-status               $18 cs-bytes
```

### Step 3.5: Build IP → Country Map

```bash
# 從解壓後的 logs 取出所有 unique IP，做 country lookup
awk -F'\t' '{print $5}' /tmp/cf_filtered.tsv | sort -u | \
  node "$SKILL_DIR/lookup-country.mjs" "$MMDB" > /tmp/ip_country.tsv

# 結果格式: <IP>\t<ISO-2 country code>，例如 114.34.235.95\tTW
# 國家代碼 ?? 表示查不到（私有 IP / 格式異常 / 未列入 DB）
```

### Step 3.6: Run the Analyzer（分類規則的單一真相）

```bash
# 產出 markdown 報告主體（4.1～4.10 全部節＋附錄 A～F）
node "$SKILL_DIR/analyze.mjs" /tmp/cf_filtered.tsv /tmp/ip_country.tsv > /tmp/report.md
```

- `analyze.mjs` 純 Node、零相依；**Step 4 的分類規則以它的程式碼為準**，SKILL.md 的文字是說明。
  改規則改腳本，不要在對話中手刻 awk 重做一遍
- 自家（開發者）IP／前綴讀同目錄 `internal-ips.txt`（**gitignored**，repo 為 public，
  個人 IP 不得寫進任何進版檔）；缺檔時腳本會 warn，開發者流量會混進 Real User／Unknown。
  也可用第三參數臨時追加（逗號分隔）
- 報告頭（摘要、方法說明、建議）由對話撰寫後與 `/tmp/report.md` 串接，最終檔存
  `C:\Users\katy\.claude\projects\E--website-berry-site\cf-report-YYYY-MM-DD.md`

### Step 4: Generate Report

Output the following sections in order. Use clear headers and tables.

---

#### 4.1 Overview

| Item | Value |
|------|-------|
| Time Range | {start_tw} ~ {end_tw} (台灣時間) |
| Total Requests | N |
| Unique IPs | N |
| Total Bandwidth | X MB (response bytes) |

#### 4.2 Status Code Distribution

| Status | Count | % |
|--------|-------|---|
| 200 | N | X% |
| 301 | N | X% |
| 304 | N | X% |
| 403 | N | X% |
| 404 | N | X% |

#### 4.3 Protocol Distribution

| Protocol | Count | % | Note |
|----------|-------|---|------|
| HTTP | N | X% | Bot-dominant (redirect before function) |
| HTTPS | N | X% | Real traffic |

#### 4.4 Traffic Classification (7 類分類；2026-09-06 改版，規則真相＝`analyze.mjs`)

**分類順序（從上往下，命中即為該類）**：

1. **Internal**（自家：開發者＋自家自動化）— 任一：
   - IP 命中 `internal-ips.txt`（gitignored）的前綴／IP
   - UA 為 `node`（CI `npm run snapshot`、Lambda 打自家 API）
   - referer 含 `localhost:<port>`（vite dev 打正式 API）
   - UA 含 `Claude/1.x … Electron`（Claude 桌面 app 的內建瀏覽器預覽）
   - `FeedFetcher-Google` 打 `/webhook/youtube`（PubSubHubbub 驗證／通知）
   ※ 2026-08 這類佔 9%，卻是最大流量源（開發者抓全量 setlist）；不分出來會全數落到 Unknown

2. **Malicious Bot：惡意路徑**（**優先於所有 UA 白名單**）— Path 命中：
   `.php`, `/wp-*`, `/wordpress`, `/blog`, `wp-json`, `/.env*`, `/.git`, `/.aws|ssh|docker|…`,
   `xmlrpc`, `/cgi-bin`, `/admin`, `wlwmanifest`, `/ALFA_DATA`, `/vendor/`, `HNAP1`, `boaform`,
   `/media/system/`, `/cdn.js`, `aws-config`, `..`（traversal）, `/@fs/`, `/static//`,
   `secrets|credentials|service-account|firebase-config|rclone|config|settings|env` 檔名,
   `/phpinfo`, `/graphql|gql`, `/actuator`, `/laravel/`, `/server-status|console|jenkins|phpmyadmin|…`,
   `/login|signin|signup|register|account|dashboard|fetch|auth/callback`（皆非站內路由）,
   `/api/(.env|config|settings|openapi.json|v1|v2|health)`, `/.well-known/` 非 `acme-challenge`
   ※ **UA 掛 Googlebot／ClaudeBot／MistralAI 但打 `/.env` 的一律算這類**。2026-09-06 以三家
   官方 IP JSON 驗證：官方 IP 惡意路徑 0 筆、打惡意路徑的全不在清單且為同一批 GCP 機器輪換
   8 種 bot UA ⇒ 假冒 UA 是常態，UA 白名單不能當信任依據

3. **Search Engine Bot** — UA 含：`Googlebot`, `bingbot`, `BingPreview`, `Applebot`, `DuckDuckBot`,
   `YandexBot`, `Baiduspider`, `Amazonbot`, `Amzn-SearchBot`, `PetalBot`

4. **AI Bot** — UA 含：`GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`, `Claude-User`,
   `Claude-SearchBot`, `anthropic-ai`, `PerplexityBot`, `CCBot`, `MistralAI-User`, `meta-externalagent`
   ※ 用戶裁示（2026-09-06）：AI 讀站不反對，robots.txt 維持 `Allow: /`

5. **Social Preview Bot** — UA 含：`facebookexternalhit`, `FacebookBot`, `Twitterbot`, `Discordbot`,
   `WhatsApp`, `Slackbot`, `LinkedInBot`, `TelegramBot`, `line-poker`

6. **Malicious Bot：UA** — 任一：
   - `Bytespider`, `AhrefsBot`, `SemrushBot`, `MJ12bot`, `DotBot`（aggressive scraper）
   - `Palo Alto Networks`, `l9scan`, `leakix`, `expanse`, `censys`, `shodan`, `zgrab`, `masscan`,
     `nuclei`, `sqlmap`, `nikto`, `wpscan`, `InternetMeasurement`, `CriminalIP`（網路掃描）
   - 固定假 UA：`iPhone OS 13_2_3`（騰訊雲上百 IP 只打 `/`）、`Android 5.0; SM-G900P`、
     `quic-go`、`WordPress/x.y`（pingback 偽裝）
   - 截斷／畸形瀏覽器 UA：以 `AppleWebKit/537.36` 結尾（無 Chrome／Safari token）、
     `Mozilla/5.0 (…) Chrome/NNN.0.0.0` 缺 AppleWebKit、以引號開頭
   - UA 為 `-` 或空字串（2026-08 佔 47%，109 個 IP 全掃 `.php`）
   - **IP 多數決**：同 IP 惡意佔比 ≥80% 且 ≥10 筆者，其餘打 `/` 的探路請求一併算惡意

7. **Real User**（真實使用者）— **IP 級**判定，四條件**全部**成立：
   - 以瀏覽器型 UA（`Mozilla/` 開頭且不含 bot／headless／Go-http／curl 等字樣）載入過任一：
     v3 bundle `/assets/index-<hash>.js`（或其他 Vite hash chunk）、v2 期的 `/assets/dist/tool.js|css`、
     `/data/manifest.json`、`/assets/data/nav.json`、`/api/setlist/manifest`、`/api/yt/latest`、
     `/api/stats/last-updated`、`/api/songlist.json`
   - 同 IP **零**惡意請求
   - 同 IP **無** bot UA 請求
   - 有站內脈絡：referer 含 `m-b.win`，或 SPA 路由（`/`, `/setlist`, `/clothes/*` …）拿過 200／304
   ※ 寬鬆版（只看 bundle）會把混用瀏覽器 UA 的掃描器算成真人（2026-08 有 28 個 IP 因此被剔除）。
   資料中心 IP 的 headless 渲染（各 3～5 筆、UA 像真人）仍會漏進來，看附錄 F 人工扣

8. **Unknown** — 都未命中。多為打 `/`／`robots.txt`／`favicon.ico` 一兩下就走的探路者、
   重放舊 index.html 抓舊 hash JS 的爬蟲、以及 headless 渲染

**輸出表：**

| Type | Requests | % | Unique IPs | 流量 MB |
|------|----------|---|------------|---------|
| Real User | N | X% | N | 真實受眾 |
| Search Engine | N | X% | N | SEO 來源 |
| AI Bot | N | X% | N | LLM 訓練 / 引用 |
| Social Preview | N | X% | N | 分享連結時的預覽 |
| Malicious Bot | N | X% | N | 攻擊 / 掃描 |
| Internal | N | X% | N | 開發者／CI／Lambda／PubSub |
| Unknown | N | X% | N | 無法分類 |

**重點觀察**：真人 IP 數才是「這個月有多少人來」的指標（2026-08 約 40 IP／月，TW／JP／TH 為主）；
請求數會被少數重度使用者拉高。

#### 4.5 Top IPs (Top 20)

| # | IP | Country | Requests | Edge | Sample Paths | Type |
|---|-----|---------|----------|------|-------------|------|
| 1 | x.x.x.x | TW | N | SIN | /path1, /path2 | Bot/Real |

**Edge Location Map (邊緣節點，不等於訪客國家)：**
```
NRT=Tokyo  TPE=Taipei  HKG=HongKong  KIX=Osaka   ICN=Seoul
SIN=Singapore  ORD=Chicago  IAD=Virginia  LAX=LA  SFO=SanFrancisco
FRA=Frankfurt  AMS=Amsterdam  TXL=Berlin  HAM=Hamburg
DFW=Dallas  IST=Istanbul  DEL=Delhi
```

#### 4.6 Country Distribution

對所有 IP 用 DB-IP Lite 查 country，列出兩張表（總流量含 bot；真實使用者＝4.4 第 7 類的 IP）。
US 在真人表裡通常是資料中心的 headless 渲染（各 3～5 筆），真受眾看 TW／JP／HK／TH／KR。

**4.6a 全流量國家分布 (Top 15)：**

| # | Country | Requests | % | 備註 |
|---|---------|----------|---|------|
| 1 | US | N | X% | 含大量 cloud datacenter（Azure, AWS） |
| 2 | TW | N | X% | 真實使用者主來源 |
| ... | | | | |

**4.6b 真實使用者國家分布：**

| # | Country | Unique IPs | Requests |
|---|---------|------------|----------|
| 1 | TW | N | N |
| 2 | JP | N | N |
| ... | | | |

> 對比 4.6a 與 4.6b，可看出哪些國家是 bot 居多 vs 真實使用者居多。

#### 4.7 Real User Traffic

**SPA Routes Accessed:**

| Route | Hits |
|-------|------|
| / | N |
| /songlist | N |

**Static Assets Loaded:**

| Asset | Hits |
|-------|------|
| /assets/index-HASH.js | N |
| /assets/index-HASH.css | N |
| /data/manifest.json | N |

**Edge Location Distribution (Real Traffic Only):**

| Edge | City | Hits | Target Audience? |
|------|------|------|-----------------|
| NRT | Tokyo | N | Yes (Japan) |
| TPE | Taipei | N | Yes (Taiwan) |

#### 4.8 Cache Efficiency

| Result Type | Count | % |
|------------|-------|---|
| Hit | N | X% |
| Miss | N | X% |
| Error | N | X% |

#### 4.9 BotBlockerFunction Effectiveness

| Category | Count | Note |
|----------|-------|------|
| Bot paths → 404 (blocked by function) | N | Function working |
| Bot paths → 301 (HTTP redirect先擋) | N | Bot used HTTP, redirected before function |
| Bot paths → 403 (S3 origin reject) | N | Path 不在 bucket（OAC 無 ListBucket ⇒ AccessDenied XML）／POST・OPTIONS 打 S3 ⇒ InvalidRequestMethod／Function UA blocklist（`x-edge-result-type` 可區分） |
| Bot paths → 200 (leaked) | N | Needs attention（理想為 0）。掃 `/` 的（Palo Alto Xpanse 等）拿 200 屬正常，首頁本來公開 |

※ 403→404 對齊方案（CloudFront Custom Error Response）2026-09-06 評估後**裁示不做**：
真人一個月只有 20 筆碰到 S3 403 且全是瀏覽器自動抓的缺圖／`.map`，收益趨近零，
卻會連帶改寫 API Gateway 與 `/tb/*` 的 403。不要再提。

#### 4.10 Hourly Traffic Pattern (台灣時間)

Show hourly request counts grouped by bot/real to identify attack windows. Hours in Taiwan time (UTC+8).

#### 4.11 Defense Recommendations (Free-First)

Based on the analysis, recommend actions prioritizing free solutions:

**Free options:**
- Add new path patterns to BotBlockerFunction (update `template.yaml`)
- Block specific high-frequency IPs/CIDRs in BotBlockerFunction
- Change HTTP redirect behavior if most bots use HTTP

**不要建議的（2026-09-06 已驗證無效或裁示不做）：**
- **UA blocklist／whitelist 對付假冒 AI 爬蟲**：偽裝者換個 UA 就過，真 Mistral／OpenAI／Anthropic
  的官方 IP 從未打過惡意路徑。防線只能是路徑規則（現況已 100% 擋下）。要驗真用官方 IP JSON：
  `openai.com/chatgpt-user.json`／`gptbot.json`／`searchbot.json`、`claude.com/crawling/bots.json`、
  `mistral.ai/mistralai-user-ips.json`
- 403→404 Custom Error Response（見 4.9）
- 把 `/graphql`、`/@fs/` 等從 S3 403 改成 Function 404：省的只是微量 S3 origin 請求費，優先度極低

**Paid options (mention only if necessary, with cost):**
- AWS WAF rate limiting (~$5/month + $0.60/M reqs)——流量全在免費額度內，掃描器已被免費層擋掉，
  目前沒有理由

### Step 5: Update Last Report Timestamp

Write the end time of this report to:
```
C:\Users\katy\.claude\projects\E--website-berry-pro\cf-report-last.txt
```

Format: `YYYY-MM-DD HH:MM:SS UTC`（使用 `date -u`）

## Important Notes

- All AWS commands must use `MSYS_NO_PATHCONV=1` prefix (Git Bash path conversion issue)
- Region is always `ap-northeast-1`
- S3 bucket: `berry-cloudfront-logs-495219733379`
- Log prefix: `cf-logs/`
- Distribution ID: `E2J83LAK96PIJH`
- Target audience regions: Taiwan, Japan, Hong Kong, Macau
- Use `zcat` to decompress `.gz` log files
- Skip comment lines starting with `#`
- Report language: Traditional Chinese (繁體中文)
- GeoIP DB: DB-IP Lite mmdb，自動更新（35 天 cache），attribution: "IP geolocation by DB-IP"
- GeoIP lookup script 路徑：`{skill_dir}/lookup-country.mjs`，第一次執行需 `npm install`（已配置 `package.json`）
- 分析腳本：`{skill_dir}/analyze.mjs`（零相依）；自家 IP 清單 `{skill_dir}/internal-ips.txt`（**gitignored，勿進版，勿在報告或 memory 以外的地方寫出具體 IP**）
- Step 5 的結束時間寫**日誌最後一筆的時間**而非「現在」：CloudFront 標準日誌投遞延遲可達數十分鐘，寫現在時刻會漏掉延遲到達的尾巴
- 已知的自家系統流量（別當成 Unknown）：AWS 東京排程函式每 10 分鐘 `GET /api/streamlist?limit=3`（UTC 14:00～19:50，UA `node`，每次不同 AWS JP IP；**來源尚未在 repo 內找到**，待確認）、snapshot cron 07:30／20:00 UTC 抓 `history.md`＋`changelog.json`、CI 每次部署 `npm run snapshot` 逐月抓 setlist（UA `node`，GitHub runner IP）

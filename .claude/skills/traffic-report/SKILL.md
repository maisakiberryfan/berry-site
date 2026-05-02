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

#### 4.4 Traffic Classification (5 類分類)

**分類順序（從上往下，命中即為該類）**：

1. **Search Engine Bot**（合法搜尋引擎） — UA 含以下任一：
   `Googlebot`, `Bingbot`, `BingPreview`, `Applebot`, `DuckDuckBot`, `YandexBot`, `Baiduspider`

2. **AI Bot**（AI 訓練 / 即時檢索）— UA 含以下任一：
   `GPTBot`, `ChatGPT-User`, `OAI-SearchBot`, `ClaudeBot`, `anthropic-ai`, `PerplexityBot`, `CCBot`

3. **Social Preview Bot**（分享預覽用）— UA 含以下任一：
   `facebookexternalhit`, `FacebookBot`, `TwitterBot`, `Discordbot`, `WhatsApp`, `Slackbot`, `LinkedInBot`

4. **Malicious Bot**（惡意 / 攻擊）— 命中以下任一：
   - UA 含 `Bytespider`, `AhrefsBot`, `SemrushBot`, `MJ12bot`, `DotBot`（aggressive scraper）
   - UA 含 `Palo Alto Networks`, `l9scan`, `leakix`, `expanse`, `censys`, `shodan`（網路安全掃描）
   - UA 為 `-` 或空字串
   - Path 命中：`.php`, `/wp-*`, `/.env`, `/.git`, `/xmlrpc`, `/cgi-bin`, `/admin`, `wlwmanifest`, `/ALFA_DATA`, `/vendor/`, `HNAP1`, `boaform`, `/media/system/`, `/cdn.js`, `/aws-config`, `/aws.config`, directory traversal (`..`)
   - Path 為 `/.well-known/` 但不是 `/.well-known/acme-challenge/`（ACME 給 cert 用）

5. **Real User**（真實使用者）— IP 滿足以下任一：
   - 載入 `/assets/dist/tool.js` 或 `/assets/dist/tool.css`（SPA bundle）
   - 載入 `/api/songlist.json`、`/api/yt/latest`、`/api/stats/last-updated` 等 SPA 入口 API
   - 載入 `/favicon.ico` 且同 IP 也訪問過 SPA 路徑（`/`, `/songlist`, `/setlist`, `/streamlist`, `/aliases`, `/analytics`）
   ※ 這個定義會把「首次訪問且 tool.js 從 CDN cache 命中沒回 origin」的真人也算進去

6. **Unknown**（其他）— 都未命中。可能是預覽 bot、未識別的 crawler、或載入頁面但沒下載 JS bundle 的訪客。

**輸出表：**

| Type | Requests | % | Unique IPs | Note |
|------|----------|---|------------|------|
| Real User | N | X% | N | 真實受眾 |
| Search Engine | N | X% | N | SEO 來源 |
| AI Bot | N | X% | N | LLM 訓練 / 引用 |
| Social Preview | N | X% | N | 分享連結時的預覽 |
| Malicious Bot | N | X% | N | 攻擊 / 掃描 |
| Unknown | N | X% | N | 無法分類 |

**重點觀察**：「Real User 請求數 vs Unknown 請求數」的比例可看出多少訪客真的在用網站、多少只是路過。

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

對所有 IP 用 DB-IP Lite 查 country，列出兩張表（總流量含 bot；真實使用者只看載過 tool.js 的 IP）。

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
| /assets/dist/tool.js | N |

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
| Bot paths → 403 (S3 origin reject) | N | Path 不在 bucket |
| Bot paths → 200 (leaked) | N | Needs attention（理想為 0） |

#### 4.10 Hourly Traffic Pattern (台灣時間)

Show hourly request counts grouped by bot/real to identify attack windows. Hours in Taiwan time (UTC+8).

#### 4.11 Defense Recommendations (Free-First)

Based on the analysis, recommend actions prioritizing free solutions:

**Free options:**
- Add new path patterns to BotBlockerFunction (update `template.yaml`)
- Block specific high-frequency IPs/CIDRs in BotBlockerFunction
- Change HTTP redirect behavior if most bots use HTTP

**Paid options (mention only if necessary, with cost):**
- AWS WAF rate limiting (~$5/month + $0.60/M reqs)

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

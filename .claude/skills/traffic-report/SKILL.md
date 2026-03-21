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
包括：對話中的狀態訊息、報告內容、時間區間說明等。

### 取得時間
```bash
date '+%Y-%m-%d %H:%M:%S'       # 台灣時間（系統時區 UTC+8）
date -u '+%Y-%m-%d %H:%M:%S'    # UTC
```

### 儲存規則
`cf-report-last.txt` 格式為 `YYYY-MM-DD HH:MM:SS UTC`（UTC 時間）。

## Execution Steps

### Step 0: Verify Current Time

在做任何事之前，先確認當前時間並顯示給用戶：
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

### Step 3: Parse and Analyze

Decompress all relevant log files and run analysis using awk/bash.

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

#### 4.4 Bot vs Real Traffic

**Bot Detection Rules:**
- Path pattern: `.php`, `/wp-*`, `/.env`, `/xmlrpc`, `/cgi-bin`, `/admin`, `/blog/`, `.xml`, `license.txt`, `wlwmanifest`, `/.well-known/` (non-ACME), `/ALFA_DATA`, `/vendor/`, directory traversal (`..`)
- User-Agent: `-` or empty
- Frequency: Same IP > 50 requests within 3 minutes

| Type | Requests | % | Unique IPs |
|------|----------|---|------------|
| Bot | N | X% | N |
| Real | N | X% | N |

#### 4.5 Top IPs (Top 20)

| # | IP | Requests | Edge | Sample Paths | Type |
|---|-----|----------|------|-------------|------|
| 1 | x.x.x.x | N | SIN (Singapore) | /path1, /path2 | Bot/Real |

**Edge Location Map:**
```
NRT=Tokyo  TPE=Taipei  HKG=HongKong  KIX=Osaka   ICN=Seoul
SIN=Singapore  ORD=Chicago  IAD=Virginia  LAX=LA  SFO=SanFrancisco
FRA=Frankfurt  AMS=Amsterdam  TXL=Berlin  HAM=Hamburg
DFW=Dallas  IST=Istanbul  DEL=Delhi
```

#### 4.6 Real User Traffic

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

#### 4.7 Cache Efficiency

| Result Type | Count | % |
|------------|-------|---|
| Hit | N | X% |
| Miss | N | X% |
| Error | N | X% |

#### 4.8 BotBlockerFunction Effectiveness

| Category | Count | Note |
|----------|-------|------|
| Bot paths → 404 (blocked) | N | Function working |
| Bot paths → 301 (HTTP redirect) | N | Bot used HTTP, redirected before function |
| Bot paths → 200 (leaked) | N | Needs attention |

#### 4.9 Hourly Traffic Pattern (台灣時間)

Show hourly request counts grouped by bot/real to identify attack windows.
Hours should be displayed in Taiwan time (UTC+8).

#### 4.10 Defense Recommendations (Free-First)

Based on the analysis, recommend actions prioritizing free solutions:

**Free options:**
- Add new path patterns to BotBlockerFunction (update `template.yaml`)
- Block specific high-frequency IPs/CIDRs in BotBlockerFunction
- Change HTTP redirect behavior if most bots use HTTP

**Paid options (mention only if necessary, with cost):**
- AWS WAF rate limiting (~$5/month)

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

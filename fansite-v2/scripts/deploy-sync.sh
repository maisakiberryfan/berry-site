#!/usr/bin/env bash
#
# fansite-v2（v3 站）靜態產物部署同步 —— 帶「舊 hash 資產保留窗口」
#
# 解決的問題：
#   Vite 產物是 hash 檔名（assets/index-COHsg1uB.js…），單純 `aws s3 sync --delete`
#   會在部署當下刪光舊 hash chunk。此時仍開著舊分頁的使用者一旦 lazy-load
#   （例：Analytics 的 QueryPanel、sql.js wasm）就吃 404、整頁壞掉。
#   對策：hash 資產只增不刪，舊物件放置 RETENTION_DAYS 天後才回收。
#
# 用法（環境變數或位置參數皆可）：
#   BUCKET=berry-fansite-v3-495219733379 DISTRIBUTION_ID=E1ZENENQETM5MD \
#     bash scripts/deploy-sync.sh
#   bash scripts/deploy-sync.sh berry-fansite-v3-495219733379 E1ZENENQETM5MD
#
#   DRY_RUN=1         只顯示會做什麼，不寫入 S3／不發 invalidation（sync 走 --dryrun）
#   RETENTION_DAYS=14 舊 hash 資產保留天數（預設 14）
#   ALLOW_MISSING_DATA=1  允許 dist/data/ 缺席——此時「跳過」data 同步，bucket 上既有
#                     快照原地保留（正常流程應先 `npm run snapshot`）
#
# 前置：dist/ 必須是本次要發佈的完整產物
#   npm run snapshot && VITE_ASSET_BASE=https://m-b.win npm run build
#
# 需要：aws cli v2、GNU date（Git Bash／GitHub Actions ubuntu 皆內建）。不需要 jq。

set -euo pipefail

# Git Bash（MSYS）會把「看起來像絕對路徑」的參數改寫成 Windows 路徑——
# CloudFront 的 --paths "/index.html" 會被改成 C:/Program Files/Git/index.html。
# 全域關閉轉換；本腳本一律用相對路徑（dist/、dist/assets/）故不受影響。
# 這兩個變數在 Linux 上不存在副作用。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

BUCKET="${1:-${BUCKET:-}}"
DISTRIBUTION_ID="${2:-${DISTRIBUTION_ID:-}}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
DRY_RUN="${DRY_RUN:-0}"
ALLOW_MISSING_DATA="${ALLOW_MISSING_DATA:-0}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$APP_DIR"

die() { echo "[deploy-sync] ✗ $*" >&2; exit 1; }
log() { echo "[deploy-sync] $*"; }

[ -n "$BUCKET" ] || die "未指定 BUCKET（環境變數或第一個位置參數）"
command -v aws >/dev/null 2>&1 || die "找不到 aws cli"

# --- 產物完整性把關（--delete 會清 bucket，這裡失手＝線上站被清空）-----------
[ -d dist ]             || die "dist/ 不存在——請先 npm run build"
[ -f dist/index.html ]  || die "dist/index.html 不存在——build 產物不完整"
[ -d dist/assets ]      || die "dist/assets/ 不存在——build 產物不完整"
# data 缺席／為空時絕不能拿它帶 --delete sync（等於清空線上快照）——
# ALLOW_MISSING_DATA=1 的語意是「跳過 data 同步」，線上舊快照原地保留，
# 前端首訪多幾個月份走 API 校正而已（與 CI 的 if: snapshot.outcome == 'success' 同哲學）
SKIP_DATA=0
if [ ! -d dist/data ] || [ -z "$(ls -A dist/data 2>/dev/null)" ]; then
  if [ "$ALLOW_MISSING_DATA" = "1" ]; then
    log "! dist/data/ 缺席或為空——跳過 data 同步，bucket 上既有快照原地保留"
    SKIP_DATA=1
  else
    die "dist/data/ 缺席或為空——請先 npm run snapshot（要跳過 data 同步請設 ALLOW_MISSING_DATA=1）"
  fi
fi

log "bucket=$BUCKET distribution=${DISTRIBUTION_ID:-（略過 invalidation）} 保留窗口=${RETENTION_DAYS}天"

# 注意：set -e 下不可寫 `[ cond ] && arr+=(x)`——條件不成立時整句退出碼 1 會直接中止腳本
SYNC_FLAGS=()
if [ "$DRY_RUN" = "1" ]; then
  log "DRY_RUN=1：sync 走 --dryrun，刪除與 invalidation 只列印不執行"
  SYNC_FLAGS+=(--dryrun)
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] $*"
  else
    "$@"
  fi
}

# 上傳順序是刻意的：資產 → 資料 → index.html。
# index.html 一定最後——它是入口，必須在它引用的東西都已就位之後才換掉，
# 否則會有一段「index.html 指向尚未上傳資產」的 404 窗口。

# --- 1) hash 資產：只增不刪 --------------------------------------------------
# 不帶 --delete：舊 hash 物件留給步驟 4 過了保留窗口再回收。
log "[1/5] 上傳 hash 資產（只增不刪）dist/assets/ → s3://$BUCKET/assets/"
aws s3 sync dist/assets/ "s3://$BUCKET/assets/" "${SYNC_FLAGS[@]}"

# --- 2) CDN 快照 data/：覆蓋 ＋ --delete 清過期月份 -------------------------
# 檔名固定（setlist-YYYY-MM.json），內容每次 snapshot 都會變 → 短快取。
# `public, max-age=300` 是為了與後端快照 cron（src/cron-jobs/snapshot.js）寫入
# 同一批 key 時用的值一致；兩邊不一致的話，部署後物件會失去 max-age，
# 之後 cron 又把它加回來，同一支檔案的快取行為飄移。
# 本地端 dist/data/ 的過期月份檔已由 fetch-snapshot.mjs 清過，這裡的 --delete
# 負責把 bucket 上的同批死檔清掉。
if [ "$SKIP_DATA" = "1" ]; then
  log "[2/5] 跳過 CDN 快照同步（ALLOW_MISSING_DATA=1）"
else
  log "[2/5] 上傳 CDN 快照 dist/data/ → s3://$BUCKET/data/"
  aws s3 sync dist/data/ "s3://$BUCKET/data/" --delete \
    --cache-control "public, max-age=300" "${SYNC_FLAGS[@]}"
fi

# --- 3) 其餘非 hash 檔（含 index.html）：覆蓋式 ＋ --delete 清死檔 -----------
# 涵蓋 index.html、favicon.ico、theme-init.js。
# --exclude 同時作用於來源與目的地（aws cli filter 語意），所以 --delete
# 不會碰到 assets/（保留窗口就靠這一點成立）與 data/（步驟 2 已各自處理）。
# ⚠️ 若日後把 /img、/pages 等現站靜態資源改放同一 bucket，必須讓它們進 dist/
#    或在此加 --exclude，否則會被 --delete 清掉（目前 v3 走 VITE_ASSET_BASE
#    指向主站 m-b.win，這些檔案不在本 bucket 內）。
log "[3/5] 上傳 index.html 等根層檔（含 --delete 清死檔）dist/ → s3://$BUCKET/"
aws s3 sync dist/ "s3://$BUCKET/" --delete \
  --exclude "assets/*" --exclude "data/*" "${SYNC_FLAGS[@]}"

# --- 4) 回收超過保留窗口的孤兒 hash 資產 -------------------------------------
# 刪除條件（兩者皆需成立）：本地 dist/assets/ 已無同名檔 ∧ LastModified 早於 N 天前。
# 這步失敗不該讓部署被判失敗——檔案都已同步完成，回收下次再做即可。
cleanup_stale_assets() {
  local cutoff listing key lastmod deleted=0 kept=0 alive=0 scanned=0

  if ! cutoff="$(date -u -d "${RETENTION_DAYS} days ago" +%Y-%m-%dT%H:%M:%S 2>/dev/null)"; then
    echo "  ! 本機 date 不支援 -d（非 GNU date），略過回收"
    return 0
  fi

  # aws cli 會自動分頁 list-objects-v2（botocore paginator），--query 套用在
  # 合併後的完整 Contents 上，因此 1000 筆以上也不會漏——前提是別加 --max-items
  # （加了才會產生 NextToken 截斷）。--output text 以 tab 分隔，免 jq 依賴。
  if ! listing="$(aws s3api list-objects-v2 \
      --bucket "$BUCKET" \
      --prefix "assets/" \
      --query 'Contents[].[Key,LastModified]' \
      --output text 2>&1)"; then
    echo "  ! 列出 s3://$BUCKET/assets/ 失敗，略過回收：${listing}"
    return 0
  fi
  # 空 prefix 時 aws cli 對 null 會印出 "None"
  if [ -z "$listing" ] || [ "$listing" = "None" ]; then
    echo "  – bucket assets/ 下無物件，無須回收"
    return 0
  fi

  # 本地檔案清單（key 形式：assets/xxx）。需要 bash 4+ 的關聯陣列。
  local -A local_keys=()
  local rel
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    local_keys["assets/${rel#./}"]=1
  done < <(cd dist/assets && find . -type f)

  while IFS=$'\t' read -r key lastmod; do
    [ -n "$key" ] || continue
    scanned=$((scanned + 1))
    # 本地仍有＝現役資產，永不刪
    if [ -n "${local_keys[$key]:-}" ]; then
      alive=$((alive + 1))
      continue
    fi
    # ISO8601（同格式、同為 UTC）字典序比較即等同時間比較；取前 19 字元
    # 以吃掉 "+00:00" / "Z" / 小數秒等尾巴差異
    if [[ "${lastmod:0:19}" < "$cutoff" ]]; then
      echo "  × 回收 $key（LastModified ${lastmod:0:19} < $cutoff）"
      if ! run aws s3 rm "s3://$BUCKET/$key"; then
        echo "  ! 刪除 $key 失敗（略過）"
        continue
      fi
      deleted=$((deleted + 1))
    else
      kept=$((kept + 1))
    fi
  done <<< "$listing"

  echo "  – 掃描 $scanned 個物件：現役 $alive、保留窗口內 $kept、回收 $deleted"
  return 0
}

log "[4/5] 回收 ${RETENTION_DAYS} 天前的孤兒 hash 資產"
cleanup_stale_assets || log "! 回收步驟異常結束（不影響部署結果）"

# --- 5) CloudFront invalidation ---------------------------------------------
# 只清 /index.html 與 /data/*：
#   * assets/ 免清——檔名內含內容 hash，內容一變 URL 就變，同一 URL 的邊緣快取
#     永遠是對的內容。清了反而白白消耗免費額度（1000 paths/月）並讓新版第一次
#     請求全部回源。（舊命令用的 "/assets/*" 就是這種無效清除。）
#   * index.html 是固定檔名的入口，每次部署內容都變，必清。
#   * data/*.json 是固定檔名的快照，內容隨每次 snapshot 變動，必清。
if [ -n "$DISTRIBUTION_ID" ]; then
  log "[5/5] CloudFront invalidation（/index.html, /data/*）"
  run aws cloudfront create-invalidation \
    --distribution-id "$DISTRIBUTION_ID" \
    --paths "/index.html" "/data/*"
else
  log "[5/5] 未指定 DISTRIBUTION_ID，略過 invalidation"
fi

log "✓ 完成"

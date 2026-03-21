#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_FILE="$SCRIPT_DIR/backup-and-export.log"

# ========================================
# Load .env
# ========================================
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  . "$SCRIPT_DIR/.env"
  set +a
fi

CONTAINER_NAME="${DB_CONTAINER_NAME:-db}"
DB_NAME="${DB_NAME:-mbdb}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-}"

GITHUB_TOKEN="${GITHUB_TOKEN:-}"
GITHUB_OWNER="${GITHUB_OWNER:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

DISCORD_WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

R2_ACCOUNT_ID="${R2_ACCOUNT_ID:-}"
R2_ACCESS_KEY_ID="${R2_ACCESS_KEY_ID:-}"
R2_SECRET_ACCESS_KEY="${R2_SECRET_ACCESS_KEY:-}"
R2_BUCKET="${R2_BUCKET:-}"
R2_PUBLIC_URL="${R2_PUBLIC_URL:-}"

BACKUP_DIR="$SCRIPT_DIR"
KEEP_BACKUPS=10

OUTPUT_DIR="${OUTPUT_DIR:-$SCRIPT_DIR}"
PARQUET_BASENAME="berry-data.parquet"
PARQUET_FILE="$OUTPUT_DIR/$PARQUET_BASENAME"

DUCKDB_IMAGE="duckdb/duckdb"
DUCKDB_NETWORK="db_default"

TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
DATE_STR="$(date +%Y-%m-%d)"

# ========================================
# Log Helpers
# ========================================
_log() {
  local LEVEL="$1"
  local MESSAGE="$2"
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] $LEVEL $MESSAGE" \
    | tee -a "$LOG_FILE" >&2
}

info()    { _log "INFO" "$1"; }
warn()    { _log "WARN" "$1"; }
error()   { _log "ERROR" "$1"; }
success() { _log "SUCCESS" "$1"; }

# ========================================
# Log Rotation (keep last 30 days)
# ========================================
rotate_logs() {
  if [ ! -f "$LOG_FILE" ]; then return; fi

  local TMP="${LOG_FILE}.tmp"
  local CUTOFF
  CUTOFF=$(date -d "30 days ago" +%s 2>/dev/null || date -v-30d +%s 2>/dev/null || echo 0)

  awk -v cutoff="$CUTOFF" '
    match($0, /^\[([0-9-]+ [0-9:]+)\]/, a) {
      cmd = "date -d \"" a[1] "\" +%s 2>/dev/null || date -j -f \"%Y-%m-%d %H:%M:%S\" \"" a[1] "\" +%s 2>/dev/null"
      cmd | getline ts
      close(cmd)
      if (ts+0 >= cutoff+0) print
      next
    }
    { print }
  ' "$LOG_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$LOG_FILE" || rm -f "$TMP"
}

# ========================================
# Discord Notification
# ========================================
send_discord_notification() {
  local title="$1"
  local description="$2"
  local color="${3:-3447003}"

  if [ -z "$DISCORD_WEBHOOK_URL" ]; then
    return
  fi

  # 轉義換行和引號
  description=$(printf '%s' "$description" | sed ':a;N;$!ba;s/\n/\\n/g;s/"/\\"/g')

  curl -sS -X POST \
    -H "Content-Type: application/json" \
    -d "{\"embeds\":[{\"title\":\"$title\",\"description\":\"$description\",\"color\":$color}]}" \
    "$DISCORD_WEBHOOK_URL" >/dev/null 2>&1 || true
}

# ========================================
# Error Exit
# ========================================
error_exit() {
  error "$1"
  send_discord_notification "❌ 備份或匯出失敗" "$1" 15158332
  info "====== BACKUP END (FAILED) ======"
  exit 1
}

# ========================================
# Functions
# ========================================
ensure_backup_dir() { mkdir -p "$BACKUP_DIR" "$OUTPUT_DIR"; }

check_docker_container() {
  if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    error_exit "Container not running: $CONTAINER_NAME"
  fi
}

check_duckdb_image() {
  if ! docker image inspect "$DUCKDB_IMAGE" &>/dev/null; then
    info "Pulling DuckDB image..."
    docker pull "$DUCKDB_IMAGE"
  fi
  info "DuckDB image: $DUCKDB_IMAGE"
}

create_backup() {
  local OUT="$BACKUP_DIR/mbdb_${TIMESTAMP}.sql"

  info "Starting database backup (container=$CONTAINER_NAME, db=$DB_NAME)..."

  if ! docker exec "$CONTAINER_NAME" mariadb-dump \
    -u"$DB_USER" -p"$DB_PASSWORD" \
    --single-transaction --routines --triggers \
    "$DB_NAME" -r /tmp/dbdump.sql 2>/dev/null; then
    error_exit "MariaDB dump failed"
  fi

  if ! docker cp "$CONTAINER_NAME:/tmp/dbdump.sql" "$OUT" 2>/dev/null; then
    error_exit "Copy dump failed"
  fi

  docker exec "$CONTAINER_NAME" rm -f /tmp/dbdump.sql 2>/dev/null || true

  info "Backup created: $OUT"
  printf "%s\n" "$OUT"
}

cleanup_old_backups() {
  cd "$BACKUP_DIR"
  local total
  total=$(ls -1 mbdb_*.sql 2>/dev/null | wc -l || echo 0)

  if [ "$total" -gt "$KEEP_BACKUPS" ]; then
    ls -1t mbdb_*.sql | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
    info "Cleaned up old SQL backups"
  fi
}

compare_backups() {
  local latest="$BACKUP_DIR/latest_mbdb.sql"
  local newfile="$1"

  [ ! -f "$latest" ] && return 0

  local oldhash newhash
  oldhash=$(grep -v '^-- ' "$latest" | sha256sum | cut -d' ' -f1)
  newhash=$(grep -v '^-- ' "$newfile" | sha256sum | cut -d' ' -f1)

  [[ "$oldhash" != "$newhash" ]]
}

run_parquet_export() {
  mkdir -p "$OUTPUT_DIR"
  info "Running parquet export (DuckDB Docker)..."

  local SQL_FILE="$SCRIPT_DIR/.export.sql"
  cat > "$SQL_FILE" << EXPORTSQL
INSTALL mysql;
LOAD mysql;
ATTACH 'host=db user=${DB_USER} password=${DB_PASSWORD} port=3306 database=${DB_NAME}' AS mariadb (TYPE MYSQL, READ_ONLY);
COPY (
  SELECT
    so.streamID, sl.title AS streamTitle, sl.time,
    sl.categories, sl.setlistComplete,
    so.segmentNo, so.trackNo, so.songID,
    s.songName, s.songNameEn, s.artist, s.artistEn,
    s.genre, s.tieup, so.note AS setlistNote, s.songNote
  FROM mariadb.setlist_ori so
  LEFT JOIN mariadb.streamlist sl ON so.streamID = sl.streamID
  LEFT JOIN mariadb.songlist s ON so.songID = s.songID
  ORDER BY sl.time DESC, so.segmentNo, so.trackNo
) TO '/data/${PARQUET_BASENAME}' (
  FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 100000
);
EXPORTSQL

  if ! docker run --rm -i \
    --network="$DUCKDB_NETWORK" \
    -v "$OUTPUT_DIR:/data" \
    "$DUCKDB_IMAGE" \
    duckdb < "$SQL_FILE"; then
    rm -f "$SQL_FILE"
    error_exit "Parquet export failed"
  fi

  rm -f "$SQL_FILE"

  if [ ! -f "$PARQUET_FILE" ]; then
    error_exit "Parquet file not found after export"
  fi
}

cleanup_old_parquet() {
  cd "$OUTPUT_DIR"
  local total
  total=$(ls -1 berry-data_*.parquet 2>/dev/null | wc -l || echo 0)

  if [ "$total" -gt "$KEEP_BACKUPS" ]; then
    ls -1t berry-data_*.parquet | tail -n +"$((KEEP_BACKUPS + 1))" | xargs -r rm -f
    info "Cleaned up old Parquet backups"
  fi
}

detect_parquet_changes() {
  local newfile="$1"
  local oldfile="$2"

  [ -z "$oldfile" ] || [ ! -f "$oldfile" ] && return 0

  local oldhash newhash
  oldhash=$(sha256sum "$oldfile" | cut -d' ' -f1)
  newhash=$(sha256sum "$newfile" | cut -d' ' -f1)

  [[ "$oldhash" != "$newhash" ]]
}

# ========================================
# GitHub Multi-File Commit (curl + jq)
# ========================================
github_multi_file_commit() {
  local DB_CHANGED="$1"
  local PQ_CHANGED="$2"
  local COMMIT_MESSAGE="$3"

  [ "$DB_CHANGED" -eq 0 ] && [ "$PQ_CHANGED" -eq 0 ] && return 1

  if [ -z "$GITHUB_TOKEN" ] || [ -z "$GITHUB_OWNER" ] || [ -z "$GITHUB_REPO" ]; then
    warn "GitHub config missing - skipping"
    return 1
  fi

  if ! command -v jq &>/dev/null; then
    warn "jq not installed - skipping GitHub upload"
    return 1
  fi

  local API="https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}"
  local AUTH="Authorization: Bearer ${GITHUB_TOKEN}"
  local ACCEPT="Accept: application/vnd.github+json"
  local API_VER="X-GitHub-Api-Version: 2022-11-28"

  info "----- GITHUB UPLOAD START -----"

  # Helper: GitHub API call
  _gh_api() {
    local method="$1" endpoint="$2"
    shift 2
    curl -sS -X "$method" -H "$AUTH" -H "$ACCEPT" -H "$API_VER" -H "User-Agent: backup-script" "$@" "${API}${endpoint}"
  }

  # 準備檔案清單
  local -a LOCAL_FILES=()
  local -a REMOTE_PATHS=()

  if [ "$DB_CHANGED" -eq 1 ] && [ -f "$BACKUP_DIR/latest_mbdb.sql" ]; then
    LOCAL_FILES+=("$BACKUP_DIR/latest_mbdb.sql")
    REMOTE_PATHS+=("latest_mbdb.sql")
  fi
  if [ "$PQ_CHANGED" -eq 1 ] && [ -f "$PARQUET_FILE" ]; then
    LOCAL_FILES+=("$PARQUET_FILE")
    REMOTE_PATHS+=("berry-data.parquet")
  fi

  if [ ${#LOCAL_FILES[@]} -eq 0 ]; then
    info "No files to upload"
    return 1
  fi

  info "Files to upload: ${#LOCAL_FILES[@]}"
  for f in "${LOCAL_FILES[@]}"; do
    local sz
    sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
    info "  - $(basename "$f") ($((sz / 1024)) KB)"
  done

  # Step 1: Get latest commit SHA
  info "Getting latest commit..."
  local LATEST_SHA
  LATEST_SHA=$(_gh_api GET "/git/ref/heads/${GITHUB_BRANCH}" | jq -r '.object.sha')
  info "Latest commit: ${LATEST_SHA:0:7}"

  # Step 2: Get base tree SHA
  local BASE_TREE
  BASE_TREE=$(_gh_api GET "/git/commits/${LATEST_SHA}" | jq -r '.tree.sha')

  # Step 3: Create blobs
  info "Creating blobs..."
  local TREE_ENTRIES="[]"
  local i
  for i in "${!LOCAL_FILES[@]}"; do
    local CONTENT
    CONTENT=$(base64 -w0 "${LOCAL_FILES[$i]}")
    local BLOB_SHA
    BLOB_SHA=$(printf '{"content":"%s","encoding":"base64"}' "$CONTENT" | \
      _gh_api POST "/git/blobs" -H "Content-Type: application/json" -d @- | jq -r '.sha')
    info "  Blob: ${REMOTE_PATHS[$i]} -> ${BLOB_SHA:0:7}"
    TREE_ENTRIES=$(echo "$TREE_ENTRIES" | jq --arg path "${REMOTE_PATHS[$i]}" --arg sha "$BLOB_SHA" \
      '. + [{"path": $path, "mode": "100644", "type": "blob", "sha": $sha}]')
  done

  # Step 4: Create tree
  info "Creating tree..."
  local NEW_TREE
  NEW_TREE=$(printf '{"base_tree":"%s","tree":%s}' "$BASE_TREE" "$TREE_ENTRIES" | \
    _gh_api POST "/git/trees" -H "Content-Type: application/json" -d @- | jq -r '.sha')
  info "New tree: ${NEW_TREE:0:7}"

  # Step 5: Create commit
  info "Creating commit..."
  local NEW_COMMIT
  NEW_COMMIT=$(printf '{"message":"%s","tree":"%s","parents":["%s"]}' "$COMMIT_MESSAGE" "$NEW_TREE" "$LATEST_SHA" | \
    _gh_api POST "/git/commits" -H "Content-Type: application/json" -d @- | jq -r '.sha')
  info "New commit: ${NEW_COMMIT:0:7}"

  # Step 6: Update ref
  info "Updating branch ref..."
  _gh_api PATCH "/git/refs/heads/${GITHUB_BRANCH}" -H "Content-Type: application/json" \
    -d "{\"sha\":\"${NEW_COMMIT}\",\"force\":false}" >/dev/null

  success "GitHub upload completed!"
  info "URL: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${NEW_COMMIT}"
  info "----- GITHUB UPLOAD END -----"
}

# ========================================
# R2 Upload (rclone)
# ========================================
upload_to_r2() {
  local PQFILE="$1"

  if ! command -v rclone &>/dev/null; then
    warn "rclone not installed - skipping R2 upload"
    return 1
  fi

  if [ ! -f "$PQFILE" ]; then
    warn "Parquet file not found: $PQFILE"
    return 1
  fi

  local FILE_SIZE
  FILE_SIZE=$(stat -c%s "$PQFILE" 2>/dev/null || echo 0)
  info "----- R2 UPLOAD START -----"
  info "Uploading $(basename "$PQFILE") ($((FILE_SIZE / 1024)) KB) to R2..."

  if rclone copyto "$PQFILE" "r2:${R2_BUCKET}/$(basename "$PQFILE")" --s3-no-check-bucket 2>&1; then
    success "R2 upload completed: $(basename "$PQFILE")"
  else
    error "R2 upload failed"
    info "----- R2 UPLOAD END -----"
    return 1
  fi

  info "----- R2 UPLOAD END -----"
}

# ========================================
# Main
# ========================================
main() {
  local start end dur
  start=$(date +%s)

  rotate_logs
  info "====== BACKUP START ======"

  ensure_backup_dir
  check_docker_container
  check_duckdb_image

  # 資料庫備份
  local BACKUP_FILE
  BACKUP_FILE=$(create_backup)
  cleanup_old_backups

  local DB_CHANGED=0
  if compare_backups "$BACKUP_FILE"; then
    DB_CHANGED=1
    cp "$BACKUP_FILE" "$BACKUP_DIR/latest_mbdb.sql"
    info "Database changes detected"
  else
    info "No database changes"
  fi

  # Parquet 匯出
  local PREV_PQ
  PREV_PQ=$(ls -1t "$OUTPUT_DIR"/berry-data_*.parquet 2>/dev/null | head -n 1 || true)

  run_parquet_export

  local PQ_TIMESTAMP="$OUTPUT_DIR/berry-data_${TIMESTAMP}.parquet"
  cp "$PARQUET_FILE" "$PQ_TIMESTAMP"

  local PQ_CHANGED=0
  if detect_parquet_changes "$PQ_TIMESTAMP" "$PREV_PQ"; then
    PQ_CHANGED=1
    info "Parquet changes detected"
  else
    info "No Parquet changes"
  fi

  cleanup_old_parquet

  # 組合 commit message
  local COMMIT_MESSAGE="$DATE_STR"
  if [ "$DB_CHANGED" -eq 1 ] && [ "$PQ_CHANGED" -eq 1 ]; then
    COMMIT_MESSAGE="$COMMIT_MESSAGE DB + parquet"
  elif [ "$DB_CHANGED" -eq 1 ]; then
    COMMIT_MESSAGE="$COMMIT_MESSAGE DB"
  elif [ "$PQ_CHANGED" -eq 1 ]; then
    COMMIT_MESSAGE="$COMMIT_MESSAGE parquet"
  fi

  # 上傳結果追蹤
  local GITHUB_OK=0
  local R2_OK=0

  # GitHub 上傳
  if [ "$DB_CHANGED" -eq 1 ] || [ "$PQ_CHANGED" -eq 1 ]; then
    if github_multi_file_commit "$DB_CHANGED" "$PQ_CHANGED" "$COMMIT_MESSAGE"; then
      GITHUB_OK=1
    fi
  fi

  # R2 上傳 (只上傳 Parquet)
  if [ "$PQ_CHANGED" -eq 1 ]; then
    if upload_to_r2 "$PARQUET_FILE"; then
      R2_OK=1
    fi
  fi

  # Discord 通知
  if [ "$DB_CHANGED" -eq 1 ] || [ "$PQ_CHANGED" -eq 1 ]; then
    end=$(date +%s)
    dur=$((end - start))

    local DB_SIZE PQ_SIZE DESC UPLOAD_STATUS
    DB_SIZE=$(stat -c%s "$BACKUP_DIR/latest_mbdb.sql" 2>/dev/null || echo 0)
    PQ_SIZE=$(stat -c%s "$PARQUET_FILE" 2>/dev/null || echo 0)

    UPLOAD_STATUS=""
    [ "$GITHUB_OK" -eq 1 ] && UPLOAD_STATUS="GitHub ✓"
    [ "$R2_OK" -eq 1 ] && UPLOAD_STATUS="$UPLOAD_STATUS R2 ✓"
    [ -z "$UPLOAD_STATUS" ] && UPLOAD_STATUS="無上傳"

    DESC="Commit: $COMMIT_MESSAGE
耗時: ${dur}s
大小:
 - latest_mbdb.sql: $((DB_SIZE / 1024)) KB
 - berry-data.parquet: $((PQ_SIZE / 1024)) KB
上傳: $UPLOAD_STATUS"

    send_discord_notification "📄 備份與匯出成功" "$DESC" 3066993
    success "Backup & export completed"
  else
    info "No changes detected - skipping upload"
  fi

  info "====== BACKUP END ======"
}

main

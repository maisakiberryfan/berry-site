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

NODE_BIN="${NODE_BIN:-node}"
PARQUET_SCRIPT="$SCRIPT_DIR/export-parquet.js"

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

check_node() {
  if ! command -v "$NODE_BIN" &>/dev/null; then
    error_exit "Node not found: $NODE_BIN"
  fi
  info "Using Node.js: $("$NODE_BIN" -v)"
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
  info "Running parquet export..."

  if ! "$NODE_BIN" "$PARQUET_SCRIPT"; then
    error_exit "Parquet export failed"
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
# GitHub Multi-File Commit (嵌入式 JS)
# ========================================
github_multi_file_commit() {
  local DB_CHANGED="$1"
  local PQ_CHANGED="$2"
  local COMMIT_MESSAGE="$3"

  [ "$DB_CHANGED" -eq 0 ] && [ "$PQ_CHANGED" -eq 0 ] && return 1

  local DBFILE=""
  local PQFILE=""

  [ "$DB_CHANGED" -eq 1 ] && DBFILE="$BACKUP_DIR/latest_mbdb.sql"
  [ "$PQ_CHANGED" -eq 1 ] && PQFILE="$PARQUET_FILE"

  info "Starting GitHub upload..."

  DB_CHANGED="$DB_CHANGED" \
  PQ_CHANGED="$PQ_CHANGED" \
  DBFILE="$DBFILE" \
  PQFILE="$PQFILE" \
  COMMIT_MESSAGE="$COMMIT_MESSAGE" \
  GITHUB_TOKEN="$GITHUB_TOKEN" \
  GITHUB_OWNER="$GITHUB_OWNER" \
  GITHUB_REPO="$GITHUB_REPO" \
  GITHUB_BRANCH="$GITHUB_BRANCH" \
  LOG_FILE="$LOG_FILE" \
  "$NODE_BIN" <<'GITHUB_JS_EOF'
const fs = require('fs');
const https = require('https');

// ============ Config ============
const {
  DB_CHANGED,
  PQ_CHANGED,
  DBFILE,
  PQFILE,
  COMMIT_MESSAGE,
  GITHUB_TOKEN,
  GITHUB_OWNER,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  LOG_FILE,
} = process.env;

// ============ Logging ============
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, msg) {
  const line = `[${ts()}] ${level} ${msg}\n`;
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

const info = (m) => log('INFO', m);
const error = (m) => log('ERROR', m);
const success = (m) => log('SUCCESS', m);

// ============ GitHub API Helper ============
function githubAPI(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GITHUB_OWNER}/${GITHUB_REPO}${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'backup-script',
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`GitHub API ${res.statusCode}: ${json.message || data}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ============ Core Functions ============
async function getLatestCommitSha() {
  const data = await githubAPI(`/git/ref/heads/${GITHUB_BRANCH}`);
  return data.object.sha;
}

async function getTreeSha(commitSha) {
  const data = await githubAPI(`/git/commits/${commitSha}`);
  return data.tree.sha;
}

async function createBlob(content, encoding = 'base64') {
  const data = await githubAPI('/git/blobs', 'POST', { content, encoding });
  return data.sha;
}

async function createTree(baseTreeSha, files) {
  const tree = files.map(f => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    sha: f.sha,
  }));

  const data = await githubAPI('/git/trees', 'POST', { base_tree: baseTreeSha, tree });
  return data.sha;
}

async function createCommit(message, treeSha, parentSha) {
  const data = await githubAPI('/git/commits', 'POST', {
    message,
    tree: treeSha,
    parents: [parentSha],
  });
  return data.sha;
}

async function updateRef(commitSha) {
  await githubAPI(`/git/refs/heads/${GITHUB_BRANCH}`, 'PATCH', { sha: commitSha, force: false });
}

// ============ Main ============
async function main() {
  info('----- GITHUB UPLOAD START -----');

  // 準備檔案清單
  const files = [];

  if (DB_CHANGED === '1' && DBFILE && fs.existsSync(DBFILE)) {
    files.push({ localPath: DBFILE, remotePath: 'latest_mbdb.sql' });
  }
  if (PQ_CHANGED === '1' && PQFILE && fs.existsSync(PQFILE)) {
    files.push({ localPath: PQFILE, remotePath: 'berry-data.parquet' });
  }

  if (files.length === 0) {
    info('No files to upload');
    return;
  }

  info(`Files to upload: ${files.length}`);
  files.forEach(f => {
    const size = Math.round(fs.statSync(f.localPath).size / 1024);
    info(`  - ${f.remotePath} (${size} KB)`);
  });

  // Step 1: 取得最新 commit
  info('Getting latest commit...');
  const latestCommitSha = await getLatestCommitSha();
  info(`Latest commit: ${latestCommitSha.substring(0, 7)}`);

  // Step 2: 取得 tree SHA
  const baseTreeSha = await getTreeSha(latestCommitSha);

  // Step 3: 創建 blobs
  info('Creating blobs...');
  const fileBlobs = [];

  for (const file of files) {
    const content = fs.readFileSync(file.localPath).toString('base64');
    const blobSha = await createBlob(content, 'base64');
    fileBlobs.push({ path: file.remotePath, sha: blobSha });
    info(`  Blob: ${file.remotePath} -> ${blobSha.substring(0, 7)}`);
  }

  // Step 4: 創建 tree
  info('Creating tree...');
  const newTreeSha = await createTree(baseTreeSha, fileBlobs);
  info(`New tree: ${newTreeSha.substring(0, 7)}`);

  // Step 5: 創建 commit
  info('Creating commit...');
  const newCommitSha = await createCommit(COMMIT_MESSAGE, newTreeSha, latestCommitSha);
  info(`New commit: ${newCommitSha.substring(0, 7)}`);

  // Step 6: 更新 ref
  info('Updating branch ref...');
  await updateRef(newCommitSha);

  success('GitHub upload completed!');
  info(`URL: https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/commit/${newCommitSha}`);
  info('----- GITHUB UPLOAD END -----');
}

main().catch(err => {
  error(`Upload failed: ${err.message}`);
  process.exit(1);
});
GITHUB_JS_EOF
}

# ========================================
# R2 Upload (嵌入式 JS)
# ========================================
upload_to_r2() {
  local PQFILE="$1"

  if [ -z "$R2_ACCOUNT_ID" ] || [ -z "$R2_ACCESS_KEY_ID" ] || [ -z "$R2_SECRET_ACCESS_KEY" ] || [ -z "$R2_BUCKET" ]; then
    warn "R2 config missing - skipping R2 upload"
    return 1
  fi

  if [ ! -f "$PQFILE" ]; then
    warn "Parquet file not found: $PQFILE"
    return 1
  fi

  info "Starting R2 upload..."

  R2_ACCOUNT_ID="$R2_ACCOUNT_ID" \
  R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" \
  R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" \
  R2_BUCKET="$R2_BUCKET" \
  PQFILE="$PQFILE" \
  LOG_FILE="$LOG_FILE" \
  "$NODE_BIN" --input-type=commonjs <<'R2_JS_EOF'
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  PQFILE,
  LOG_FILE,
} = process.env;

// ============ Logging ============
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(level, msg) {
  const line = `[${ts()}] ${level} ${msg}\n`;
  if (LOG_FILE) fs.appendFileSync(LOG_FILE, line);
  process.stderr.write(line);
}

const info = (m) => log('INFO', m);
const error = (m) => log('ERROR', m);
const success = (m) => log('SUCCESS', m);

// ============ Main ============
async function main() {
  info('----- R2 UPLOAD START -----');

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  const fileBuffer = fs.readFileSync(PQFILE);
  const fileName = path.basename(PQFILE);
  const fileSize = Math.round(fileBuffer.length / 1024);

  info(`Uploading ${fileName} (${fileSize} KB) to R2...`);

  const command = new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: fileName,
    Body: fileBuffer,
    ContentType: 'application/octet-stream',
  });

  await client.send(command);

  success(`R2 upload completed: ${fileName}`);
  info('----- R2 UPLOAD END -----');
}

main().catch(err => {
  error(`R2 upload failed: ${err.message}`);
  process.exit(1);
});
R2_JS_EOF
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
  check_node

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
    if [ -n "$GITHUB_TOKEN" ] && [ -n "$GITHUB_OWNER" ] && [ -n "$GITHUB_REPO" ]; then
      if github_multi_file_commit "$DB_CHANGED" "$PQ_CHANGED" "$COMMIT_MESSAGE"; then
        GITHUB_OK=1
      fi
    else
      warn "GitHub config missing - skipping GitHub upload"
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

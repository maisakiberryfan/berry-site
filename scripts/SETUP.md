# 備份管線伺服器設定

將 `backup-and-export.sh` 部署到新伺服器的步驟。

## 必要工具

| 工具 | 用途 | 安裝方式 |
|------|------|----------|
| Docker | MariaDB 容器 + DuckDB Parquet 匯出 | `curl -fsSL https://get.docker.com \| sh` |
| rclone | Cloudflare R2 上傳 | `curl -sSL https://rclone.org/install.sh \| bash` |
| jq | GitHub API JSON 解析 | `apt install jq` |
| curl | GitHub API / Discord webhook | 系統內建 |
| cron | 定時排程 | 系統內建 |

## 設定步驟

### 1. Docker + MariaDB

```bash
mkdir -p /root/DB && cd /root/DB

# 放入 docker-compose.yml（MariaDB service）
docker compose up -d

# 匯入資料庫
docker cp mbdb_backup.sql db:/tmp/
docker exec db mariadb -uroot -p < /tmp/mbdb_backup.sql
```

MariaDB 容器名必須是 `db`，Docker network 為 `db_default`。
DuckDB 透過此 network 連線 MariaDB（容器間直連 port 3306）。

### 2. DuckDB Docker Image

```bash
docker pull duckdb/duckdb
```

無需安裝到主機，以 `docker run --rm` 執行一次性匯出。

### 3. rclone R2 設定

```bash
mkdir -p ~/.config/rclone
cat > ~/.config/rclone/rclone.conf << 'EOF'
[r2]
type = s3
provider = Cloudflare
access_key_id = <R2_ACCESS_KEY_ID>
secret_access_key = <R2_SECRET_ACCESS_KEY>
endpoint = https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
EOF
```

驗證：`rclone ls r2:<bucket-name>/`

### 4. 環境變數

```bash
cp .env.example .env
# 編輯 .env，填入真實值
```

### 5. 部署腳本

```bash
chmod +x backup-and-export.sh
# 手動測試
./backup-and-export.sh
```

確認 log 輸出無錯誤，Discord 收到通知。

### 6. Cron 排程

```bash
crontab -e
# 新增（UTC 03:10 = 台灣 11:10）：
10 3 * * * /root/DB/backup-and-export.sh >> /root/DB/cron.log 2>&1
```

## 管線流程

```
cron (03:10 UTC)
  → mariadb-dump → .sql 備份（保留 10 份）
  → DuckDB Docker → .parquet 匯出（ZSTD 壓縮，保留 10 份）
  → 變更偵測（hash 比對）
  → GitHub API → sqlBackUp repo（公開紀錄）
  → rclone → R2（前端 DuckDB-WASM 使用）
  → Discord webhook 通知
```

## 回滾

```bash
# 如果新腳本出問題，恢復備份
cp /root/DB/backup-and-export.sh.before-duckdb /root/DB/backup-and-export.sh
```

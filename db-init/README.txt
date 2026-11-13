# 把公開備份放進這個資料夾（檔名結尾 .sql），資料庫容器第一次啟動時會自動匯入：
#   curl -L -o db-init/latest_mbdb.sql https://raw.githubusercontent.com/maisakiberryfan/sqlBackUp/main/latest_mbdb.sql
# 只在資料庫是空的時候匯入一次；之後這裡的檔案不會再被讀取。

---
name: commit
description: "Commit and push changes. With a message string, also updates changelog.json with translated versions for the homepage."
argument-hint: '["changelog message"]'
allowed-tools: Bash(git *), Bash(cd * && npm run build*), Read, Write, Edit, Glob, Grep
---

# Commit & Push (with optional changelog)

## Invocation

- `/commit` — commit only (不 push); auto-detect if changelog update is needed
- `/commit "新增歷史頁面"` — update changelog + commit (不 push)
- 累積多個 commit 後用 `/push` 一次推上去

## Changelog 判斷標準

Changelog 是給**一般網站訪客**看的，只記錄**使用者肉眼可見的變更**。

### 需要更新 changelog 的變更（使用者看得到）

- 新增頁面或區塊（如「新增歷史頁面」「新增衣裝頁面」）
- UI 外觀變更（如「更換 profile 圖片」「深色模式改版」）
- 新功能（如「新增歌曲搜尋」「新增多語言切換」）
- 內容更新（如「更新 2026 活動資料」）

### 不需要更新 changelog 的變更（使用者看不到）

- 後端 / API 變更（效能優化、bug fix、重構）
- 基礎設施（CI/CD、部署、CDN 設定、S3）
- 技術升級（套件版本更新、build 工具）
- 開發者文件（CLAUDE.md、README、skills）
- 安全性修補、bot 防禦規則
- 圖片來源切換（如 YouTube CDN → S3，使用者看不出差異）

## Behavior

### Step 1: Analyze changes

1. Run `git status` and `git diff` to review changes
2. **判斷變更是否為使用者可見**（依上方標準）
3. 決定是否需要更新 changelog：
   - 有帶 message 參數 → 直接用該 message 更新 changelog
   - 無參數，但變更是使用者可見的 → **建議一個 changelog 訊息，詢問用戶確認**
   - 無參數，變更不可見 → 不更新 changelog

### Step 2: Update changelog（如需要）

1. **Detect input language** — determine if the message is zh, en, ja, or mixed
2. **Translate** to the other two languages. Rules:
   - Keep technical terms in their original form (e.g., "dark mode", "API")
   - For mixed zh+en input like "新增 dark mode", translate naturally
   - Translations should be natural and concise, not literal
3. **Write `fansite/changelog.json`**:
```json
{
  "time": "{current time in ISO 8601, +08:00 timezone}",
  "msg": {
    "zh": "...",
    "en": "...",
    "ja": "..."
  }
}
```
   - The file contains only the latest entry (overwrite, no history)
   - Time: auto-generated, use `date -Iseconds` to get current time with timezone offset
   - Multiline messages: store with `\n` in JSON strings
4. **Build frontend**: `cd fansite && npm run build:js`

### Step 3: Verify CLAUDE.md

1. Read `CLAUDE.md` and check if it accurately reflects the current state of the codebase
2. If any section is outdated due to the changes being committed (e.g., API endpoints added/removed, architecture changes, new features), update `CLAUDE.md` accordingly
3. Skip this step if the changes are minor and don't affect anything documented in `CLAUDE.md`

### Step 4: Commit & push

1. Run `git status` and `git diff` to review all changes (including any CLAUDE.md updates)
2. Draft a commit message (developer-facing, conventional commits style)
3. Stage relevant files and commit (do NOT push)

## Important

- Always follow the repo's commit message conventions (see `git log --oneline -5`)
- The changelog message is **user-facing** — 用訪客能理解的語言描述，不提技術細節
- The git commit message is **developer-facing** — follows conventional commits format
- Never commit `.env`, `.dev.vars`, or credential files

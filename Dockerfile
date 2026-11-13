# 單機部署用的映像：一個 Node 程序跑整個站（entry-node.js）。
# 搭配 docker-compose.yml 使用，步驟見 docs/HANDOVER.md 的路線 A。

# ── 建置階段：裝相依、建前端 ─────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

# 先只複製相依清單再安裝：之後改程式碼不會讓這幾層快取失效
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY lambda/setlist-matcher/package.json lambda/setlist-matcher/package-lock.json lambda/setlist-matcher/
RUN cd lambda/setlist-matcher && npm ci --omit=dev

COPY fansite-v2/package.json fansite-v2/package-lock.json fansite-v2/
RUN cd fansite-v2 && npm ci

COPY fansite-v2 fansite-v2
RUN cd fansite-v2 && npm run build

# ── 執行階段 ─────────────────────────────────────────────────────────────────
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules node_modules
COPY --from=build /app/lambda/setlist-matcher/node_modules lambda/setlist-matcher/node_modules
COPY --from=build /app/fansite-v2/dist fansite-v2/dist

COPY package.json entry-node.js entry-worker.js ./
COPY src src
COPY lambda/setlist-matcher/package.json lambda/setlist-matcher/
COPY lambda/setlist-matcher/src lambda/setlist-matcher/src
COPY fansite-v2/scripts/fetch-snapshot.mjs fansite-v2/scripts/
COPY fansite/img fansite/img
COPY fansite/pages/history.md fansite/pages/
COPY fansite/changelog.json fansite/

# 資料快照由排程寫到這裡（compose 會掛一個 volume 上來），要讓非 root 的執行帳號寫得進去
RUN mkdir -p fansite-v2/public/data && chown -R node:node fansite-v2/public
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "entry-node.js"]

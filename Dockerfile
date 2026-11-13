# Make My Space CRM + Operations — single image: API + web app.
# Build:  docker build -t mms-platform .
# Run:    see docker-compose.yml

# ---------- 1. build the API ----------
FROM node:22-alpine AS build
WORKDIR /app/apps/api
COPY apps/api/package.json apps/api/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY apps/api/ ./
RUN npm run build && npm prune --omit=dev

# ---------- 2. self-host the browser libraries (no CDN at runtime) ----------
FROM node:22-alpine AS vendor
WORKDIR /v
RUN npm init -y >/dev/null && npm install --no-audit --no-fund react@18.3.1 react-dom@18.3.1 htm@3.1.1 \
 && mkdir -p out && cp node_modules/react/umd/react.production.min.js node_modules/react-dom/umd/react-dom.production.min.js node_modules/htm/dist/htm.umd.js out/
COPY apps/web/public /web
RUN cp out/* /web/ \
 && sed -i -e 's#https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js#/react.production.min.js#' \
           -e 's#https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js#/react-dom.production.min.js#' \
           -e 's#https://unpkg.com/htm@3.1.1/dist/htm.umd.js#/htm.umd.js#' /web/index.html

# ---------- 3. runtime ----------
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 WEB_DIR=/app/apps/web/public STORAGE_LOCAL_DIR=/data/uploads
WORKDIR /app/apps/api
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/api/migrations ./migrations
COPY --from=build /app/apps/api/package.json ./
COPY --from=vendor /web /app/apps/web/public
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/src/server.js"]

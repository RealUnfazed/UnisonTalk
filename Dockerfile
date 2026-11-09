# UnisonTalk server (also serves the client). No build step: it's plain Node.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads
WORKDIR /app

# Dependencies first, so editing app code doesn't reinstall them. `npm ci` when
# a lockfile is committed (reproducible); plain install otherwise.
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY server ./server
COPY client ./client

# Uploads live on a volume, owned by the unprivileged user the app runs as.
RUN mkdir -p /data/uploads/avatars && chown -R node:node /data /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1

# `node` directly (not `npm start`) so SIGTERM reaches the app and the graceful shutdown runs.
CMD ["node", "server/server.js"]

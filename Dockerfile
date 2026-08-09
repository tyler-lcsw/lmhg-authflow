FROM node:22-bookworm-slim AS deps

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    npm_config_build_from_source=true

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        g++ \
        make \
        pkg-config \
        python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/package*.json ./

COPY --chown=node:node . .
RUN mkdir -p /data \
    && chown node:node /data

USER node

EXPOSE 3000
CMD ["node", "server.js"]

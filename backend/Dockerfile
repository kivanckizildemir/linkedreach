# Lightweight Node base
FROM node:20-slim

# System deps required by Playwright's Chromium
RUN apt-get update && apt-get install -y \
    wget gnupg ca-certificates \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2 libpangocairo-1.0-0 libxshmfence1 \
    fonts-liberation xdg-utils libx11-xcb1 \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all deps (including playwright for browser install)
COPY package*.json ./
RUN npm ci

# Download only Chromium (skip Firefox/WebKit)
RUN npx playwright install chromium

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

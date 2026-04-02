# Use lightweight Node base + install system Chromium (much smaller than playwright image)
FROM node:20-slim

# Playwright/Chromium system dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2 libpangocairo-1.0-0 libxshmfence1 \
    fonts-liberation xdg-utils \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium, skip its own download
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Install prod deps first (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev

# Install dev deps for TypeScript build
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

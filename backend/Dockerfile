FROM mcr.microsoft.com/playwright:v1.50.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install devDeps needed for build (tsx/tsc), then prune
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Install only chromium for LinkedIn automation
RUN npx playwright install chromium

# Remove dev dependencies after build
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

# Use the official Playwright image — Chromium + all system deps pre-installed
# This is the main reason deploys were slow/flaky: installing Chromium on every build
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

# Install Node dependencies
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies to keep image lean
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

FROM node:20-slim

WORKDIR /app

# Install all deps (including playwright for browser install)
COPY package*.json ./
RUN npm ci

# Download Chromium + all system deps. Retry up to 3 times on network failure.
RUN npx playwright install chromium --with-deps || \
    npx playwright install chromium --with-deps || \
    npx playwright install chromium --with-deps

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies
RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

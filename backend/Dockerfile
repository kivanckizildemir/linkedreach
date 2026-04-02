# Base image: node:20-slim + Chromium pre-installed (built by GitHub Actions).
# No browser download on every deploy — builds take ~30s instead of ~3min.
# Source: ghcr.io/kivanckizildemir/linkedreach-base:latest (public package)
FROM ghcr.io/kivanckizildemir/linkedreach-base:latest

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

EXPOSE 3001

CMD ["node", "dist/combined.js"]

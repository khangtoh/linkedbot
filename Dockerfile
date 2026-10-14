FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
# LINKEDBOT_DATA must sit on the persistent volume: it holds the session vault, daily usage and leads.
ENV NODE_ENV=production PORT=8080 LINKEDBOT_DATA=/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
# Headless Chromium plus its system libraries, at the Playwright version pinned in the lockfile.
RUN npm ci --omit=dev \
 && npx playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/server.js"]

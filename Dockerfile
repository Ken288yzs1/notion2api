# Dockerfile
FROM node:20-alpine

ENV NODE_ENV=production \
    PNPM_HOME="/pnpm"
RUN corepack enable

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

COPY . .

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://0.0.0.0:${PORT:-7860}/health || exit 1

CMD ["npm", "start"]

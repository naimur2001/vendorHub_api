FROM node:22-slim
WORKDIR /app

# Prisma needs OpenSSL
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# install everything (the prisma CLI is a dev dependency and is needed for migrate deploy)
COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
USER node
EXPOSE 4000
CMD ["node", "src/server.js"]
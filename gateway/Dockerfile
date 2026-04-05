FROM docker.1ms.run/library/node:22-alpine

WORKDIR /app

# Copy root workspace deps (clawxrouter needs @sinclair/typebox etc.)
COPY package.json package-lock.json ./
RUN npm install --omit=dev

# Copy gateway deps
COPY gateway/package.json gateway/package-lock.json ./gateway/
RUN cd gateway && npm install --omit=dev

# Copy source
COPY clawxrouter/ ./clawxrouter/
COPY gateway/src/ ./gateway/src/
COPY gateway/tsconfig.json ./gateway/

WORKDIR /app/gateway

EXPOSE 8070

CMD ["npx", "tsx", "src/server.ts"]

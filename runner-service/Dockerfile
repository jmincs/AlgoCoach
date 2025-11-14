FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

FROM base AS deps
RUN npm install

FROM deps AS builder
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev && apk add --no-cache docker-cli
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/server.js"]



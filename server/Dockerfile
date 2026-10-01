# 云顶山景区观光车平台 —— 后端（NestJS + SQLite/MySQL）
FROM node:22-slim AS build
WORKDIR /app

#  better-sqlite3 在部分基础镜像上需要本地编译工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行镜像 ----
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# SQLite 数据文件目录（可挂载 volume 持久化）
RUN mkdir -p /app/data
VOLUME ["/app/data"]
ENV SQLITE_PATH=/app/data/app.sqlite
ENV PORT=3001
EXPOSE 3001

CMD ["node", "dist/main.js"]

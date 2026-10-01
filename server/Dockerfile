# 云顶山观光车平台 —— 后端镜像（NestJS + SQLite 零外部依赖）
FROM node:20-bookworm-slim AS base
WORKDIR /app

# 先拷依赖清单，利用缓存层
COPY package*.json ./
RUN npm install --omit=dev=false

# 拷贝源码并编译
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 运行期：保留 better-sqlite3 原生模块即可
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# 数据文件放在可挂载卷
RUN mkdir -p /app/data
VOLUME ["/app/data"]
CMD ["node", "dist/main.js"]

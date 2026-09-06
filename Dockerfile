# ---- ccnu_lesson_agent 多阶段构建 ----
# 阶段1：构建前端 web/dist
FROM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 阶段2：构建 Go 服务端
FROM golang:1.27-alpine AS server
ENV GOPROXY=https://goproxy.cn,direct
WORKDIR /app/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

# 阶段3：运行镜像（alpine 最小）
FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 app
WORKDIR /app
COPY --from=server /out/api /app/api
COPY --from=web /app/web/dist /app/web/dist
USER app
ENV PORT=8080 WEB_DIST=/app/web/dist
EXPOSE 8080
CMD ["/app/api"]

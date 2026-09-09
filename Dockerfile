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
# 把 SKILL.md 技能目录复制为镜像默认技能（部署时可挂载 volume 覆盖以实现运行时管理）
RUN mkdir -p /out/skills && cp -r skills/* /out/skills/ 2>/dev/null || true

# 阶段3：运行镜像（alpine 最小）
FROM alpine:3.20
# catdoc：老式 .doc（catdoc）与 .xls（xls2csv）文本提取
RUN apk add --no-cache ca-certificates tzdata catdoc && adduser -D -u 10001 app
WORKDIR /app
COPY --from=server /out/api /app/api
COPY --from=web /app/web/dist /app/web/dist
# 默认技能直接作为 /app/skills（属主 app）；named volume 首次挂载会复制镜像内容与属主
COPY --from=server /out/skills /app/skills
COPY --from=server /out/skills /app/skills-default
RUN mkdir -p /app/uploads /app/artifacts && chown -R app:app /app/skills /app/skills-default /app/uploads /app/artifacts
USER app
ENV PORT=8080 WEB_DIST=/app/web/dist SKILLS_DIR=/app/skills SKILLS_DEFAULT=/app/skills-default UPLOAD_DIR=/app/uploads ARTIFACT_DIR=/app/artifacts
EXPOSE 8080
CMD ["/app/api"]

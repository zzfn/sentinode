.PHONY: dev dev-server dev-web dev-agent build help

# 从 .env.local 加载环境变量
ENV := $(shell [ -f .env.local ] && echo "set -a && . ./.env.local && set +a &&" || echo "")

## 确保本地数据库存在（首次使用前运行一次）
db-init:
	@$(ENV) psql "$$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1 && \
	  echo "数据库已就绪" || \
	  (psql postgres://onoo:onoo@localhost:5432/postgres \
	    -c "CREATE DATABASE sentinode" && echo "已创建 sentinode 数据库")

## 并行启动 server + web + agent（Ctrl-C 一起退出）
dev:
	@lsof -ti:50051 | xargs kill -9 2>/dev/null || true
	@lsof -ti:8080  | xargs kill -9 2>/dev/null || true
	@$(ENV) RUST_BACKTRACE=1 trap 'kill 0' INT; \
	cargo run --bin sentinode-server & \
	(sleep 3 && cargo run --bin sentinode-agent) & \
	(cd web && bun run dev) & \
	wait

## 仅启动 gRPC server
dev-server:
	@$(ENV) cargo run --bin sentinode-server

## 仅启动前端
dev-web:
	cd web && bun run dev

## 仅启动 agent
dev-agent:
	@$(ENV) cargo run --bin sentinode-agent

## 构建全部
build:
	cargo build --workspace
	cd web && bun run build

help:
	@grep -E '^##' Makefile | sed 's/## //'

.PHONY: dev dev-server dev-web dev-agent build help

# 从 .env.local 加载环境变量
ENV := $(shell [ -f .env.local ] && echo "set -a && . ./.env.local && set +a &&" || echo "")

## 并行启动 server + web（Ctrl-C 一起退出）
dev:
	@$(ENV) trap 'kill 0' INT; \
	cargo run --bin sentinode-server & \
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

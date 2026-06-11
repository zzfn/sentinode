FROM rust:latest AS chef
RUN cargo install cargo-chef --locked
WORKDIR /app

# 计算依赖指纹（只看 Cargo.toml / Cargo.lock）
FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

# 编译依赖层（recipe 不变则完全命中缓存）
FROM chef AS builder
RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
COPY --from=planner /app/recipe.json recipe.json
RUN cargo chef cook --release --recipe-path recipe.json
# 依赖已缓存，只编译业务代码
COPY . .
RUN cargo build --release --bin sentinode-server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/sentinode-server /usr/local/bin/
EXPOSE 50051 8080
CMD ["sentinode-server"]

FROM rust:1.82-alpine AS builder
WORKDIR /app
RUN apk add --no-cache musl-dev
COPY . .
RUN rustup target add x86_64-unknown-linux-musl && \
    cargo build --release --bin sentinode-agent --target x86_64-unknown-linux-musl

FROM scratch
COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/sentinode-agent /
ENTRYPOINT ["/sentinode-agent"]

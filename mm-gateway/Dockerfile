FROM rust:latest AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --bin mm-gateway

FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/mm-gateway /usr/local/bin/mm-gateway

ENTRYPOINT ["/usr/local/bin/mm-gateway"]

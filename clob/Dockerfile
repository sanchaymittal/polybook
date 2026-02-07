FROM rust:latest AS builder
WORKDIR /app
COPY . .
RUN cargo build --release --bin polybook-clob

FROM debian:bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/polybook-clob /usr/local/bin/polybook-clob

# Expose the port
EXPOSE 3030

ENTRYPOINT ["/usr/local/bin/polybook-clob"]

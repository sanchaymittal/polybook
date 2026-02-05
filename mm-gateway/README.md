# MM-Gateway

Market Maker Gateway for PolyBook - A standalone Rust service that acts as a real market maker, participating in Polybook markets with EIP-712 signed orders.

## Features

- **On-chain inventory tracking** - Queries USDC and ERC-1155 token balances
- **EIP-712 order signing** - Compatible with CLOB verification
- **Spread-based quoting** - Configurable spread and order sizes
- **Automatic re-quoting** - Monitors fills and adjusts quotes
- **Inventory limits** - Prevents over-exposure on either side

## Quick Start

```bash
# 1. Start Anvil (in separate terminal)
anvil --port 8545

# 2. Deploy contracts (in separate terminal)
cd ../ctf-exchange
forge script script/DeployLocalEnv.s.sol --rpc-url http://127.0.0.1:8545 --broadcast

# 3. Start CLOB (in separate terminal)
cd ../clob
EXCHANGE_ADDR=0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0 cargo run

# 4. Run MM-Gateway
cargo run
```

## Configuration

Environment variables (or `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `MM_PRIVATE_KEY` | Anvil #4 | Market maker's private key |
| `MM_ADDRESS` | Anvil #4 address | Market maker's address |
| `CLOB_URL` | `http://127.0.0.1:3030` | CLOB service URL |
| `RPC_URL` | `http://127.0.0.1:8545` | Ethereum RPC URL |
| `SPREAD_BPS` | `200` | Spread in basis points (2%) |
| `ORDER_SIZE` | `50000000` | Order size (50 tokens, scaled 1e6) |
| `MAX_INVENTORY` | `500000000` | Max position per side |
| `QUOTE_INTERVAL_MS` | `5000` | Quote refresh interval (ms) |
| `FAIR_PRICE` | `0.5` | Initial fair price (0-1) |
| `YES_TOKEN_ID` | Market-specific | YES outcome token ID |
| `NO_TOKEN_ID` | Market-specific | NO outcome token ID |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       MM-Gateway                             │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│ QuoteEngine │   Signer    │  Inventory  │ OrderbookAdapter │
│ (pricing)   │ (EIP-712)   │ (on-chain)  │ (CLOB HTTP)      │
└──────┬──────┴──────┬──────┴──────┬──────┴──────────┬───────┘
       │             │             │                 │
       │             │             ▼                 ▼
       │             │     ┌───────────────┐ ┌─────────────┐
       │             │     │    Anvil      │ │    CLOB     │
       │             │     │  (Port 8545)  │ │ (Port 3030) │
       │             │     └───────────────┘ └─────────────┘
       │             │             │                 │
       │             │             └────────┬────────┘
       │             │                      ▼
       │             │              ┌─────────────────┐
       │             └─────────────►│  CTF Exchange   │
       │                            │   (On-Chain)    │
       └───────────────────────────►└─────────────────┘
```

## Main Loop

1. **Sync inventory** - Query on-chain USDC + token balances
2. **Poll fills** - Check for executed trades on our orders
3. **Cancel stale orders** - Remove orders older than 5 minutes
4. **Generate quotes** - Compute bid/ask based on spread and inventory
5. **Submit orders** - Sign and post to CLOB
6. **Sleep** - Wait for next quote interval

## Testing

```bash
# Unit tests (no external services needed)
cargo test

# Integration tests (requires Anvil + CLOB running)
cargo test --test mm_integration -- --ignored --nocapture
```

## License

MIT

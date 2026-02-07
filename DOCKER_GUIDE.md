
# Docker Deployment Guide

This guide explains how to run the PolyBook stack using Docker Compose. This is the recommended way to run the system for testing and production-like environments, especially for the Arc Testnet.

## Prerequisites

-   [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine installed.
-   `docker compose` available in your terminal.

## Services

The `docker-compose.yml` orchestrates the following services:

1.  **`clob`**: The Rust-based Central Limit Order Book and Matching Engine.
    -   *Port*: `3030`
    -   *Role*: Matches orders and relays matches to the blockchain.
2.  **`lifecycle-manager`**: TypeScript service for market automation.
    -   *Role*: Creates markets on-chain, registers them in CLOB, and resolves them upon expiration.
    -   *Naming*: Creates markets with `btc-up-and-down-5min-{startTimestamp}` slug.
3.  **`mm-maker`** (MM Gateway): Rust-based Market Maker bot.
    -   *Role*: Seeds markets (mints YES/NO tokens) and provides liquidity (BUY/SELL orders).

## Setup

1.  **Environment Variables**:
    Ensure you have a `.env` file in the root directory. This file is passed to all containers. The critical variables are:

    ```env
    # Network
    RPC_URL=https://rpc.blockdaemon.testnet.arc.network # Use a reliable RPC to avoid rate limits
    CHAIN_ID=5042002

    # Addresses (Arc Testnet)
    USDC_ADDRESS=0x9e11B2412Ea321FFb3C2f4647812C78aAA055a47
    CTF_ADDRESS=0x41eB51a330c937B9c221D33037F7776716887c21
    EXCHANGE_ADDRESS=0xde94c82340142d919089978286a86c61d934ba31
    ADAPTER_ADDRESS=0x81Ca8cAfEb16b88955D22F229aAD4c1b89a576d4
    
    # Init Keys
    DEPLOYER_PRIVATE_KEY=... # Account with ETH for gas
    MM_PRIVATE_KEY=...       # Account with ETH and USDC for market making
    MM_ADDRESS=...
    
    # External APIs
    STORK_API_KEY=...
    ```

## Running the Stack

### 1. Start All Services
Build and start the services in detached mode:

```bash
docker compose up -d --build
```

### 2. View Logs
To follow the logs of all services:
```bash
docker compose logs -f
```

To view a specific service (e.g., `lifecycle-manager`):
```bash
docker compose logs -f lifecycle-manager
```

### 3. Verify System Health

**Lifecycle Manager**:
Should show:
- `🚀 Creating Automated Market: btc-up-and-down-5min-...`
- `✅ Transaction Confirmed!`
- `✅ Token Registration Tx: ...`

**MM Maker**:
Should show:
- `INFO mm_gateway: Seeding market ... with 1000000 USDC...` (if auto-seeding enabled)
- `INFO mm_gateway::inventory: Split position successful!`
- `INFO mm_gateway: Order submitted: BUY ...`

**CLOB**:
Should show:
- `INFO polybook_clob: Order ... added`

## Common Issues & Troubleshooting

### RPC Rate Limits
If you see errors like `429 Too Many Requests` or `daily request limit reached`:
1.  **Solution**: Switch `RPC_URL` in `.env`.
2.  **Apply**: Run `docker compose down && docker compose up -d` to force the environment update. *Note: `docker compose restart` is often insufficient for env var updates.*

### Contracts/Addresses Mismatch
Ensure `CHAIN_ID`, `CTF_ADDRESS`, and `USDC_ADDRESS` match the environment you are deployment to (Local Anvil vs Arc Testnet). The `docker-compose.yml` is pre-configured for **Arc Testnet** by default.

### Market Seeding Failed
If `mm-maker` fails to seed:
-   Check if `MM_PRIVATE_KEY` account has enough **Native ETH** for gas.
-   Check if `MM_PRIVATE_KEY` account has enough **USDC** for the seed amount (`SEED_AMOUNT` in `docker-compose.yml`).

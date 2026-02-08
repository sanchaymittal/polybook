# Environment Configuration

## Overview
This project uses two environment files to support parallel development:

1. **`.env`** - Production/Docker configuration (Arc Testnet, Yellow Network **disabled**)
2. **`.env.local`** - Local development with Yellow Network support (**enabled**)

## Usage

### Docker (Production)
Docker Compose automatically uses `.env`:
```bash
docker compose up -d --build
```
- `USE_YELLOW=false`
- Uses standard Arc Testnet USDC: `0x9e11B2412Ea321FFb3C2f4647812C78aAA055a47`

### Local Development (Yellow Network)
For local testing with Yellow Network, use `.env.local`:
```bash
# Load .env.local
export $(grep -v '^#' .env.local | xargs)

# Run mm-gateway
cargo run --bin mm-gateway
```
- `USE_YELLOW=true`
- Uses Yellow-specific USDC: `YELLOW_USDC_ADDRESS`
- Connects to Yellow Network WebSocket

## Key Differences

| Variable | `.env` (Docker) | `.env.local` (Yellow) |
|----------|----------------|----------------------|
| `USE_YELLOW` | `false` | `true` |
| `USDC_ADDRESS` | Arc Testnet USDC | Arc Testnet USDC (for CLOB) |
| `YELLOW_USDC_ADDRESS` | N/A | Yellow Network USDC |
| `CUSTODY_ADDRESS` | N/A | Nitrolite Custody |
| `CTF_YELLOW_VALVE_ADDRESS` | N/A | Yellow Valve Contract |

## Important Notes

- **Never commit `.env.local`** - It's in `.gitignore`
- Docker ignores `.env.local` and only uses `.env`
- When switching between modes, make sure to rebuild:
  ```bash
  # For Docker
  docker compose down && docker compose up -d --build
  
  # For local
  cargo clean && cargo build --release
  ```

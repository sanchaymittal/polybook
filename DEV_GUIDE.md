
# Development Guide

## Environment Standards

To ensure consistent behavior across development environments, please follow these standards.

### 1. Node.js Management: `nvm`
We use `nvm` to manage Node.js versions.
- **Why**: Ensures all developers use the exact same Node.js version (v24.13.0).
- **Setup**:
  ```bash
  nvm install
  nvm use
  ```
- **Reference**: [nvm-sh/nvm](https://github.com/nvm-sh/nvm)

### 2. Package Manager: `pnpm`
We use `pnpm` instead of `npm` or `yarn`.
- **Why**: Faster, disk-efficient, and stricter dependency handling.
- **Setup**:
  ```bash
  npm install -g pnpm
  pnpm install
  ```

### 3. Smart Contracts: `Foundry`
We use Foundry (`forge`, `cast`, `anvil`) for Solidity development.
- **Why**: Fast interactions, Solidity-based tests, and powerful debugging tools.
- **Setup**:
  ```bash
  curl -L https://foundry.paradigm.xyz | bash
  foundryup
  ```

---

## Quick Start (Local Environment)

### 1. Setup Node
```bash
nvm use
npm install -g pnpm
pnpm install
```

### 2. Setup Contracts
```bash
cd contracts
forge install
# Start anvil in a separate terminal
anvil
```

**Deploy to Local Anvil:**
```bash
# In ctf-exchange directory or using polybook scripts
./deploy_exchange.sh local
# OR manually using forge script
forge script script/DeployLocalEnv.s.sol --broadcast --rpc-url http://127.0.0.1:8545 --private-key $DEPLOYER_KEY
```

### 3. Setup services
You need two terminals to run the core services:

**Terminal 1: Rust CLOB (Matcher + Relay)**
```bash
cd clob
cargo run
```

**Terminal 2: Agent Gateway (x402 + Public API)**
```bash
cd agent-gateway
pnpm dev
```

### 4. Verification (End-to-End Tests)

We have a dedicated E2E script for the de-orchestrated system. Ensure services are running.

**De-Orchestrated E2E:**
```bash
npx tsx scripts/e2e-deorchestrated.ts
```

---

## Service Configuration

### Rust CLOB `.env`
- `RPC_URL`: Local anvil URL (`http://localhost:8545`)
- `DEPLOYER_PRIVATE_KEY`: Private key for the relay worker (Account #0 recommended for local)
- `USDC_ADDRESS`: Deployed USDC mock
- `CTF_ADDRESS`: Deployed CTF contract
- `EXCHANGE_ADDR`: Deployed CTF Exchange

### Agent Gateway `.env`
- `CLOB_URL`: URL of the Rust CLOB (`http://localhost:3030`)
- `EXCHANGE_ADDR`: Deployed CTF Exchange (For EIP-712 DOMAIN)
- `PORT`: 3402

### MM Gateway `.env`
- `CLOB_URL`: URL of the Rust CLOB
- `RPC_URL`: Local anvil URL
- `PRIVATE_KEY`: Market Maker Account Key
- `MARKET_ID`: Target Market ID for quoting

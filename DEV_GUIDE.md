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

### 4. Key Management: `cast`
We use `cast` (part of Foundry) for secure key management.
- **Why**: Avoids plain-text private keys in `.env` files. Keys are encrypted in `~/.foundry/keystores`.
- **Reference**: [Foundry Private Key Wallet](https://getfoundry.sh/cast/reference/wallet/private-key/)

**Importing a Key (Secure):**
```bash
cast wallet import <ACCOUNT_NAME> --interactive
```

**Using the Key in Scripts:**
```bash
forge script script/Deploy.s.sol \
  --account <ACCOUNT_NAME> \
  --sender <SENDER_ADDRESS> \
  --rpc-url <RPC_URL> \
  --broadcast
```

- **Generate Development Key (Disposable):**
  ```bash
  cast wallet new
  ```

- **Why is a Private Key needed?**
  The Orchestrator acts as an agent that interacts with the Yellow Network L2. It needs a private key to:
  1. **Authenticate**: Log in to the Yellow Network WebSocket via ECSDA signature.
  2. **Sign State**: Sign off-chain state updates (Yellow L2 channels).
  3. **Submit Transactions**: Commit settlement proofs to the on-chain registry.

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
forge test
# Start anvil in a separate terminal
anvil
```

### 3. Setup services
You need three terminals to run the core services:

**Terminal 1: Rust CLOB (Matcher + Relay)**
```bash
cd clob
cargo run
```

**Terminal 2: Orchestrator (Manager + Signer)**
```bash
cd orchestrator
# Ensure .env has PRIVATE_KEY and RPC_URL=http://localhost:8545
pnpm dev
```

**Terminal 3: Agent Gateway (x402 + Public API)**
```bash
cd agent-gateway
pnpm dev
```

### 4. Verification (End-to-End Tests)

We have two main E2E test scripts in the `orchestrator` service. Ensure all services in Step 3 are running before executing these.

**Option A: Real E2E (Direct CLOB + On-chain)**
This tests the full lifecycle including liquidity provision, order matching in the Rust CLOB, and on-chain settlement.
```bash
npx tsx scripts/real-e2e.ts
```

**Option B: Two-Trader E2E (Gateway + Orchestrator)**
This tests the high-level API via the Agent Gateway and the Orchestrator's skill system.
```bash
npx tsx scripts/two-traders-e2e.ts
```

---

## Service Configuration

### Orchestrator `.env`
- `PRIVATE_KEY`: Private key for the relay worker (Account #0 recommended for local)
- `RPC_URL`: Local anvil URL (`http://localhost:8545`)
- `CLOB_URL`: URL of the Rust CLOB (`http://localhost:3030`)

### Agent Gateway `.env`
- `ORCHESTRATOR_URL`: URL of the Orchestrator (`http://localhost:3031`)
- `PORT`: 3402

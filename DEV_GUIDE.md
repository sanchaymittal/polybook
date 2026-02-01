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

## Quick Start (New Environment)

```bash
# 1. Setup Node
nvm use

# 2. Install Dependencies
pnpm install

# 3. Setup Contracts
cd contracts
forge install
forge test

# 4. Setup CLOB
cd ../clob
pnpm install

# 5. Connect Keys
# Generate a random key for dev:
cast wallet new
# Copy Private Key to .env (PRIVATE_KEY=...)
```

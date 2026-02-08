# Environment Configuration Summary

## Changes Made

### 1. Separate Environment Files
- **`.env`** - Docker/Production (Yellow Network **disabled**)
  - `USE_YELLOW=false`
  - Uses standard Arc Testnet USDC: `0x9e11B2412Ea321FFb3C2f4647812C78aAA055a47`
  
- **`.env.local`** - Local Development (Yellow Network **enabled**)
  - `USE_YELLOW=true`
  - Uses Yellow-specific USDC: `YELLOW_USDC_ADDRESS=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
  - Includes all Nitrolite contract addresses

### 2. Code Changes

#### `mm-gateway/src/config.rs`
- Added `yellow_usdc_address: String` field to `MMConfig` struct
- Loads from `YELLOW_USDC_ADDRESS` env var (falls back to `USDC_ADDRESS` if not set)

#### `mm-gateway/src/inventory.rs`
- Added `yellow_usdc_address: Address` field to `InventoryManager` struct
- Updated `sync()` method to use correct USDC address based on `use_yellow` flag:
  ```rust
  let usdc_addr_to_query = if self.use_yellow {
      self.yellow_usdc_address  // Yellow Network USDC
  } else {
      self.usdc_address         // Standard Arc Testnet USDC
  };
  ```
- Improved error messages to indicate which address type failed

### 3. Documentation
- Created `ENV_SETUP.md` with usage instructions for both modes

## Root Cause of "Buffer Overrun" Error

The error occurred because:
1. When `USE_YELLOW=true`, the code was querying address `0x1c7D...` (Yellow USDC)
2. But it was using the standard ERC20 ABI which didn't match Yellow's contract
3. This caused "ABI decoding failed: buffer overrun while deserializing"

## Solution

Now the system correctly:
- Uses `USDC_ADDRESS` for Docker/CLOB operations
- Uses `YELLOW_USDC_ADDRESS` for Yellow Network operations
- Logs which mode is active: `(Yellow: true/false)`

## Usage

### Docker (Production)
```bash
docker compose up -d --build
# Uses .env with USE_YELLOW=false
```

### Local Development (Yellow)
```bash
export $(grep -v '^#' .env.local | xargs)
cargo run --bin mm-gateway
# Uses .env.local with USE_YELLOW=true
```

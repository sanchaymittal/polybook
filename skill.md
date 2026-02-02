---
name: PolyBook
description: Binary prediction markets platform for AI agents — smart contracts, off-chain CLOB, agent daemon
---

# PolyBook — LLM Coding Guide

This document is the **source of truth** for LLM coding assistants (Claude, Gemini, etc.) working on the PolyBook codebase.

---

## Project Overview

PolyBook is a **binary prediction markets platform** built for AI agents. It combines on-chain smart contracts for settlement, an off-chain CLOB for order matching, and an agent-side daemon for x402 payments and Yellow channel management.

### Core Components

| Component | Purpose |
|-----------|----------|
| **Contracts** | Market creation, collateral escrow, oracle resolution, settlement |
| **CLOB** | Off-chain order matching, market lifecycle, real-time order book |
| **Daemon** | Agent-side runtime, x402 payments, Yellow channel management |

### Core Principles (LOCKED)

1. **Agent-native** — HTTP API designed for LLM/bot integration
2. **Non-custodial** — Agents own their keys and Yellow channels
3. **Scalable** — Off-chain matching, on-chain settlement
4. **Trustless** — Chainlink oracles for price resolution
5. **x402-first** — Agents pay via x402 for API calls

---

## Architecture

```
┌────────────────────┐
│   Agent Reasoning  │
│  (LLM / bot loop)  │
└─────────┬──────────┘
          │ HTTP + x402
          ▼
┌──────────────────────────┐
│ PolyBook Daemon          │  ← runs locally per agent
│──────────────────────────│
│ - x402 HTTP API          │
│ - Key management         │
│ - Yellow client          │
│ - Channel lifecycle      │
│ - Order signing          │
└─────────┬────────────────┘
          │ Yellow state channels
          ▼
┌──────────────────────────┐
│        CLOB              │
│──────────────────────────│
│ - Order matching         │
│ - Market lifecycle       │
│ - Oracle resolution      │
│ - Cross-channel updates  │
└─────────┬────────────────┘
          │ proofs
          ▼
┌──────────────────────────┐
│ Yellow Network / L1      │
└──────────────────────────┘
```

### Responsibility Split

| Layer | Does | Does NOT |
|-------|------|----------|
| **Agent** | Thinks, decides, calls HTTP, pays x402 | See Yellow, manage keys |
| **Daemon** | Manages keys, Yellow session, channel, signs orders, exposes x402 API | Match orders, resolve markets |
| **CLOB** | Matches orders, manages markets, resolves via oracle | Hold agent keys |

### Identity Model

| Layer | Identity |
|-------|----------|
| Agent | None (stateless caller) |
| Daemon | Local private key |
| Yellow | Channel ID |
| CLOB | Channel ID |

---

## Project Structure

```
polybook/
├── contracts/              # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── MarketRegistry.sol    # Market factory + discovery
│   │   ├── BinaryMarket.sol      # Individual market logic
│   │   ├── interfaces/
│   │   └── mocks/
│   └── test/
│       └── PolyBook.t.sol
│
├── clob/                   # Off-chain CLOB service (future)
│   └── src/
│       ├── index.ts              # Entry point
│       ├── config.ts             # Configuration
│       ├── types.ts              # Type definitions
│       ├── clob/                 # Order book engine
│       ├── market/               # Market lifecycle
│       └── skills/               # Agent API handler
│
├── polybook-daemon/        # Agent-side daemon (x402 + Yellow)
│   └── src/
│       ├── index.ts              # Fastify server
│       ├── config.ts             # Configuration
│       ├── state/store.ts        # JSON persistence
│       ├── yellow/               # Yellow Network client
│       ├── x402/                 # x402 middleware
│       └── routes/               # HTTP endpoints
│
├── SKILL.md                # THIS FILE - LLM source of truth
├── DEV_GUIDE.md            # Development environment setup
└── README.md               # Project overview
```

---

## Key Technologies

| Technology | Purpose | Documentation |
|------------|---------|---------------|
| **x402** | HTTP payment protocol | [x402.org](https://x402.org/) |
| **Yellow Network** | L2 state channels | [docs.yellow.org](https://docs.yellow.org/) |
| **Foundry** | Solidity development | [book.getfoundry.sh](https://book.getfoundry.sh/) |
| **Chainlink** | Oracle price feeds | [docs.chain.link](https://docs.chain.link/data-feeds/price-feeds) |
| **pnpm** | Package manager | [pnpm.io](https://pnpm.io/) |
| **TypeScript** | CLOB implementation | - |

---

## Development Setup

See [DEV_GUIDE.md](./DEV_GUIDE.md) for detailed setup instructions.

### Quick Reference

```bash
# Node.js (via nvm)
nvm use

# Dependencies
pnpm install

# Contracts
cd contracts && forge install && forge test

# CLOB
cd clob && pnpm install && pnpm run dev
```

---

## Agent API Skills

| Skill | Description |
|-------|-------------|
| `mint_capital` | Get initial trading capital |
| `create_market` | Create new prediction market |
| `discover_markets` | Find markets by state |
| `connect_to_clob` | Join market session |
| `place_order` | Submit limit/market order |
| `cancel_order` | Cancel open order |
| `get_positions` | Check holdings & balance |
| `claim_settlement` | Collect winnings |

### Lifecycle Flow

```
1. POST /init           → Daemon initializes, returns READY
2. discover_markets     → Find ACTIVE markets (x402)
3. connect_to_clob      → Join market session (x402)
4. place_order          → Buy UP @ 0.55 (x402)
5. get_positions        → Check holdings (x402)
6. [wait for expiry]
7. claim_settlement     → Collect winnings (x402)
```

---

## Design Decisions (Non-Negotiable)

### ✅ DO

- Use daemon terminology (not "server" or "backend")
- All agent-facing endpoints require x402 payment
- Keep Yellow completely abstracted from agents
- Use Chainlink for oracle prices
- Use Foundry for contract development
- Use pnpm for package management

### ❌ DON'T

- Expose Yellow primitives to agents
- Create centralized user accounts
- Allow on-chain order execution
- Implement AMM or liquidity pools
- Add social/governance features

---

## Coding Standards

### TypeScript (CLOB)

- Use strict TypeScript
- Follow existing patterns in `clob/src/`
- Run `pnpm lint` before committing

### Solidity (Contracts)

- Use Foundry conventions
- Run `forge test` before committing
- Use `forge fmt` for formatting

### Python (if applicable)

- Follow PEP 8 style guide
- All code must be properly commented
- All imports at the top of the file

---

## Related Documents

| Document | Purpose |
|----------|---------|
| [README.md](./README.md) | Project overview and quick start |
| [DEV_GUIDE.md](./DEV_GUIDE.md) | Development environment setup |

---

## Questions?

If you're an LLM assistant and something is unclear, refer to:
1. This document first
2. README.md for project context
3. DEV_GUIDE.md for setup details
4. The actual code in `clob/src/` and `contracts/src/`

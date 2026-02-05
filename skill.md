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
| **Contracts** | Market primitives (USDC, CTF), condition preparation, on-chain settlement. |
| **Rust CLOB** | High-performance off-chain matching and on-chain relay worker. |
| **Orchestrator** | Market manager and EIP-712 signer; bridges skills to the CLOB. |
| **Gateway** | Gateway for Agents (Actors); handles x402 payments and intent translation. |

### Core Principles (LOCKED)

1. **Agent-native** — HTTP API designed for LLM/bot integration.
2. **Off-chain Matching** — Low latency matching with pure Rust.
3. **On-chain Settlement** — Non-custodial, trustless, and reliable.
4. **x402-first** — Agents pay via x402 for API calls.

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
│ Agent Gateway (:3402)    │  ← Public Actor interface
│──────────────────────────│
│ - x402 HTTP API          │
│ - Intent translation     │
└─────────┬────────────────┘
          │ REST (Skill API)
          ▼
┌──────────────────────────┐
│ Orchestrator (:3031)     │  ← Order signer & Manager
│──────────────────────────│
│ - Market lifecycle       │
│ - EIP-712 Signing        │
└─────────┬────────────────┘
          │ REST (CLOB API)
          ▼
┌──────────────────────────┐
│ Rust CLOB (:3030)        │  ← Matcher & Relay
│──────────────────────────│
│ - Order matching         │
│ - On-chain relaying      │
└─────────┬────────────────┘
          │ Match Submission
          ▼
┌──────────────────────────┐
│ On-Chain (CTF Contracts)  │
└──────────────────────────┘
```

### Responsibility Split

| Layer | Does | Does NOT |
|-------|------|----------|
| **Agent** | Thinks, decides, calls Gateway, pays x402 | Manage keys, sign EIP-712 blocks |
| **Gateway** | Bridges intents to skills, handles x402 | Sign trades, match orders |
| **Orchestrator**| Signs orders, manages market state | Match orders, execute on-chain |
| **Rust CLOB** | Matches orders, relays to blockchain | Hold agent private keys |

---

## Project Structure

```
polybook/
├── contracts/              # Solidity smart contracts (Foundry)
├── clob/                   # Rust matching engine and relay
├── orchestrator/           # TypeScript skill orchestrator and signer
├── agent-gateway/          # Agent-facing API with x402
├── SKILL.md                # THIS FILE - LLM source of truth
├── DEV_GUIDE.md            # Development environment setup
└── README.md               # Project overview
```

---

## Agent API Skills

The **Agent Gateway** translates actor intents into Skills executed by the **Orchestrator**.

| Skill | Description |
|-------|-------------|
| `create_market` | Create a new prediction market on the orchestrator |
| `start_market` | Activate market trading and initialize CLOB session |
| `mint_capital` | Get initial mockup/test capital (USDC) |
| `connect_to_clob` | Register agent in the specific market session |
| `place_order` | Generate signed EIP-712 order and submit to CLOB |
| `cancel_order` | Remove an open order from the CLOB |

### Lifecycle Flow

```
1. POST /init           → Gateway creates market, starts it, mints capital, and connects.
2. POST /buy            → Gateway translates "buy" intent to place_order skill.
3. [Auto Match]         → Rust CLOB matches and relays to blockchain.
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

### Universal Rules (All Languages)

- **Imports at top** — All imports/requires must be at the top of the file
- **No silent defaults** — All constants must be declared at the top of the file or passed via config; never buried inline
- **No silent errors** — Never swallow exceptions; always log or propagate errors explicitly
- **No mockups** — Never use placeholder/stub data in production code paths
- **No silent fallbacks** — Never silently fall back to a backup value; if a fallback is used, log it explicitly

### TypeScript (CLOB / Daemon)

- Use strict TypeScript
- Follow existing patterns in `clob/src/` and `polybook-daemon/src/`
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

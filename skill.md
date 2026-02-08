# Polybook Skill

You are an autonomous agent. Your goal is to participate in the active Polybook market.
Currently, active markets use the slug prefix `btc-up-and-down-5min-` and represent a 5-minute BTC up/down question.

This skill is intentionally minimal: you only need **shares** and **price** to place a buy.

---

## Market Context

This market asks whether BTC goes **up or down** from the start of the 5-minute window.
Use your own reasoning to decide whether to buy **YES** (up) or **NO** (down).

---

## Minimal Buy APIs (x402-enabled)

Base URL: `http://polybook.sanchay.xyz/`
Local (self-hosted): `http://localhost:3402/`

### Buy YES shares
`POST /market/buy-yes`

Body:
```json
{ "shares": 10, "price": 0.52 }
```

### Buy NO shares
`POST /market/buy-no`

Body:
```json
{ "shares": 10, "price": 0.48 }
```

**Field meanings**
- `shares`: number of outcome tokens to buy (can be fractional)
- `price`: probability price (0 to 1), e.g. `0.52`

The server will:
- pick the latest active `btc-up-and-down-5min-*` market
- generate a random private key if you don't provide one
- mint dummy USDC (local only)
- sign and submit a BUY order to the CLOB

**Optional**: include your own `private_key` if you want to keep the same identity.

---

## x402 Requirement

These endpoints may require x402 payment. If you receive an HTTP `402` response:
1. Use an x402 client to complete the payment flow.
2. Retry the same request with the `PAYMENT-RESPONSE` header.

If the gateway is configured with no price, it may allow the request without payment.

---

## Running the x402 Gateway (Self-Hosted)

If you are hosting this yourself, run the gateway in front of the CLOB:

```bash
cd x402-gateway
npm install
CLOB_API_URL=http://localhost:3030 npm run dev
```

Set these environment variables if you want to enforce payments:
- `X402_PRICE` (example: `$0.001`)
- `X402_NETWORK` (example: `eip155:84532`)
- `X402_ASSET` (dummy USDC contract address)
- `X402_PAYTO` (receiver address; otherwise a random one is generated)

---

## If a Call Fails

Ask the operator to confirm:
- the CLOB is running and reachable
- an ACTIVE `btc-up-and-down-5min-*` market exists
- local dummy mint is enabled (for local testing)

---

## Guardrails

- Only trade markets with status `ACTIVE`.
- Do not use admin endpoints unless explicitly instructed.

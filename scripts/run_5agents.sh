#!/bin/bash

# Multi-Agent Simulation using mm-gateway
# Runs 5 trading agents with different strategies for 30 minutes

set -e

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║    Starting 2 Fresh Trading Agents (30 minutes)             ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Load environment
source .env

# Create logs directory
mkdir -p logs

# Kill existing agents if running
pkill -f "target/debug/mm-gateway" || pkill -f "target/release/mm-gateway" || true
sleep 2

# Wait for CLOB to be ready
echo "Checking CLOB availability..."
MAX_RETRIES=10
RETRY_COUNT=0
while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    if curl -s http://127.0.0.1:3030/health > /dev/null 2>&1; then
        echo "✓ CLOB is ready!"
        break
    fi
    echo "  Waiting for CLOB... ($((RETRY_COUNT + 1))/$MAX_RETRIES)"
    sleep 2
    RETRY_COUNT=$((RETRY_COUNT + 1))
done

if [ $RETRY_COUNT -eq $MAX_RETRIES ]; then
    echo "❌ ERROR: CLOB is not available at http://127.0.0.1:3030"
    echo "Please start CLOB first: cd clob && cargo run --bin polybook-clob"
    exit 1
fi
echo ""

# ═══════════════════════════════════════════════════════════════
# IMPORTANT: Token Types on Arc Testnet
# ═══════════════════════════════════════════════════════════════
# 1. Native USDC (18 decimals) - from Circle faucet
#    - Used automatically for GAS FEES by the blockchain
#    - Agents funded via https://faucet.circle.com/
#
# 2. Dummy USDC (6 decimals) - ERC20 at USDC_ADDRESS in .env
#    - Used for COLLATERAL and TRADING
#    - Minted via mint_dummy_usdc.ts
#    - mm-gateway reads this from USDC_ADDRESS env var
# ═══════════════════════════════════════════════════════════════

# Fresh agent private keys (funded with native USDC for gas + dummy USDC for collateral)
AGENT_KEYS=(
    "0x1f0a1d782caae8aded760378d403a4efec607d21f00213985b511b332c8b766d"  # Agent 1
    "0x467abdc065a4919fd99f8004a5dfce29c6bdf534ba520ef3741c2b1992d4430a"  # Agent 2
)

# Agent addresses (derived from private keys above)
AGENT_ADDRS=(
    "0xC76Ccfacbc10dD62Fe57f98b0e5391B39959c9fe"  # Agent 1
    "0x5B13716AEb102812Ba2Eb0471B4f49EA4262652F"  # Agent 2
)

# Different strategies for each agent
SPREADS=(200 250)  # Different spread in bps
SIZES=(50000000 30000000)  # Different order sizes (50 and 30 tokens)
INTERVALS=(3000 4000)  # Different quote intervals

# Start each agent
for i in {0..1}; do
    AGENT_NUM=$((i + 1))
    echo ""
    echo "Starting Agent $AGENT_NUM (Spread: ${SPREADS[$i]}bps, Size: $((${SIZES[$i]} / 1000000)) tokens)..."
    
    cd mm-gateway
    MM_PRIVATE_KEY=${AGENT_KEYS[$i]} \
    MM_ADDRESS=${AGENT_ADDRS[$i]} \
    SPREAD_BPS=${SPREADS[$i]} \
    ORDER_SIZE=${SIZES[$i]} \
    QUOTE_INTERVAL_MS=${INTERVALS[$i]} \
    cargo run --release 2>&1 | tee ../logs/agent_${AGENT_NUM}.log &
    
    AGENT_PID=$!
    echo $AGENT_PID > ../logs/agent_${AGENT_NUM}.pid
    cd ..
    echo "  Agent $AGENT_NUM started (PID: $AGENT_PID, Address: ${AGENT_ADDRS[$i]})"
    
    sleep 2
done

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  2 fresh agents started! Running for 30 minutes...          ║"
echo "║  Logs: logs/agent_*.log                                     ║"
echo "║  Monitor: tail -f logs/agent_1.log                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Wait 30 minutes
sleep 1800

# Cleanup
echo ""
echo "═══ Stopping Agents ═══"
for i in {1..2}; do
    if [ -f logs/agent_${i}.pid ]; then
        kill $(cat logs/agent_${i}.pid) 2>/dev/null || true
        rm -f logs/agent_${i}.pid
    fi
done

echo "Simulation complete!"

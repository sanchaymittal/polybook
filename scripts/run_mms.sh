#!/bin/bash
# Run 5 MM instances in parallel

# Market configuration (Defaults or pass as env)
MARKET_ID=${MARKET_ID:-1}
YES_TOKEN_ID=${YES_TOKEN_ID:-"41069470821908003820423618366673725376269941223722400569053573765861956451072"}
NO_TOKEN_ID=${NO_TOKEN_ID:-"56313735484794408456925599043858882156820008852269395108189660012550632661236"}

# Private keys for 5 accounts (funded via fund_mms.sh)
KEYS=(
    "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
    "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"
    "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"
    "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97"
    "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
)

# Addresses (for reference/logging, not strictly needed as config derives from key)
# But we can set MM_ADDRESS env var just in case config uses it.
ADDRESSES=(
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
)

# Spread configuration for variety
SPREADS=(100 150 200 250 300) # bps

echo "Starting 5 MMs for Market $MARKET_ID..."

for i in {0..4}; do
    KEY=${KEYS[$i]}
    ADDR=${ADDRESSES[$i]}
    SPREAD=${SPREADS[$i]}
    
    echo "Launching MM #$i ($ADDR) with Spread $SPREAD bps..."
    
    # Run in background
    MM_PRIVATE_KEY=$KEY \
    MM_ADDRESS=$ADDR \
    MARKET_ID=$MARKET_ID \
    YES_TOKEN_ID=$YES_TOKEN_ID \
    NO_TOKEN_ID=$NO_TOKEN_ID \
    SPREAD_BPS=$SPREAD \
    cargo run --manifest-path mm-gateway/Cargo.toml > "mm_$i.log" 2>&1 &
done

echo "All MMs launched in background. Logs in mm_0.log to mm_4.log."

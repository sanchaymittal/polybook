#!/bin/bash
# Fund 5 MM accounts (Anvil Accounts 5-9) with 10M USDC each

RPC_URL="http://127.0.0.1:8545"
USDC="0x5fbdb2315678afecb367f032d93f642f64180aa3"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

# Accounts to fund
ACCOUNTS=(
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9"
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955"
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f"
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"
)

AMOUNT=10000000000000 # 10M USDC (6 decimals)

echo "Funding 5 MM accounts..."

for ACC in "${ACCOUNTS[@]}"; do
    echo "Funding $ACC with 10M USDC..."
    cast send $USDC "mint(address,uint256)" $ACC $AMOUNT \
        --private-key $DEPLOYER_KEY \
        --rpc-url $RPC_URL
done

echo "Funding complete."


import { createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { CONTRACTS, RPC_URL, LP_ADDRESS } from '../contracts.js';
import { MARKET_STATE } from '../market-state.js';

const CTF_ABI = [
    {
        name: 'balanceOf',
        type: 'function',
        inputs: [
            { name: 'account', type: 'address' },
            { name: 'id', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'getCollectionId',
        type: 'function',
        inputs: [
            { name: 'parentCollectionId', type: 'bytes32' },
            { name: 'conditionId', type: 'bytes32' },
            { name: 'indexSet', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
    },
    {
        name: 'getPositionId',
        type: 'function',
        inputs: [
            { name: 'collateralToken', type: 'address' },
            { name: 'collectionId', type: 'bytes32' },
        ],
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
    },
    {
        name: 'getConditionId',
        type: 'function',
        inputs: [
            { name: 'oracle', type: 'address' },
            { name: 'questionId', type: 'bytes32' },
            { name: 'outcomeSlotCount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'pure',
    },
] as const;

async function main() {
    const publicClient = createPublicClient({
        chain: anvil,
        transport: http(RPC_URL),
    });

    // 1. Get Condition ID
    const conditionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getConditionId',
        args: [MARKET_STATE.oracle, MARKET_STATE.questionId, BigInt(MARKET_STATE.outcomeSlotCount)],
    });
    console.log(`Condition ID: ${conditionId}`);

    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

    try {
        // 2. Get Position IDs for Yes (IndexSet 1) and No (IndexSet 2) - Assuming binary
        // Binary: [A, B] -> IndexSet 1 (0b01) and 2 (0b10)
        for (let i = 1; i <= 2; i++) {
            const indexSet = BigInt(1 << (i - 1)); // 1 or 2
            console.log(`Checking IndexSet ${indexSet}...`);

            const collectionId = await publicClient.readContract({
                address: CONTRACTS.CTF,
                abi: CTF_ABI,
                functionName: 'getCollectionId',
                args: [parentCollectionId, conditionId, indexSet],
            });
            console.log(`Collection ID: ${collectionId}`);

            const positionId = await publicClient.readContract({
                address: CONTRACTS.CTF,
                abi: CTF_ABI,
                functionName: 'getPositionId',
                args: [CONTRACTS.USDC, collectionId],
            });
            console.log(`Position ID: ${positionId}`);

            const balance = await publicClient.readContract({
                address: CONTRACTS.CTF,
                abi: CTF_ABI,
                functionName: 'balanceOf',
                args: [LP_ADDRESS, positionId],
            });

            console.log(`Outcome ${i} (IndexSet ${indexSet}) Position ID: ${positionId}`);
            console.log(`LP Balance: ${balance.toString()}`);
        }
    } catch (error) {
        console.error("Error in check-balances:", error);
        process.exit(1);
    }
}

main();

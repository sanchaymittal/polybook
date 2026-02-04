
import { createPublicClient, http } from 'viem';
import { anvil } from 'viem/chains';
import { CONTRACTS, RPC_URL } from '../contracts.js';
import { MARKET_STATE } from '../market-state.js';

const CTF_ABI = [
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

    console.log('Computing Condition ID...');
    const conditionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: CTF_ABI,
        functionName: 'getConditionId',
        args: [MARKET_STATE.oracle, MARKET_STATE.questionId, BigInt(MARKET_STATE.outcomeSlotCount)],
    });
    console.log(`Condition ID: ${conditionId}`);

    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

    // Test for IndexSet 1
    console.log('Testing getCollectionId for IndexSet 1...');
    try {
        const colId1 = await publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'getCollectionId',
            args: [parentCollectionId, conditionId, 1n],
        });
        console.log(`IndexSet 1 CollectionId: ${colId1}`);
    } catch (e) {
        console.error('Failed for IndexSet 1:', e);
    }

    // Test for IndexSet 2
    console.log('Testing getCollectionId for IndexSet 2...');
    try {
        const colId2 = await publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: CTF_ABI,
            functionName: 'getCollectionId',
            args: [parentCollectionId, conditionId, 2n],
        });
        console.log(`IndexSet 2 CollectionId: ${colId2}`);
    } catch (e) {
        console.error('Failed for IndexSet 2:', e);
    }
}

main();

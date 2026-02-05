import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { anvil } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, RPC_URL } from '../orchestrator/src/contracts.js';

const ADMIN_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Account #0
const admin = privateKeyToAccount(ADMIN_PK);

async function main() {
    const walletClient = createWalletClient({
        account: admin,
        chain: anvil,
        transport: http(RPC_URL),
    });

    const exchangeAbi = [
        {
            name: 'registerToken',
            type: 'function',
            inputs: [
                { name: 'token', type: 'uint256' },
                { name: 'complement', type: 'uint256' },
                { name: 'conditionId', type: 'bytes32' },
            ],
            outputs: [],
        },
    ] as const;

    const conditionId = '0xd9116a0d7566d8c6d1e5914fcc328bdf0db42a4c1b9a4d7c9ccf1ebbbb66e3d5';
    const yesTokenId = 61378011527142424347118046087792028415421176150217020092334026086220015056018n;
    const noTokenId = 80315191450012662879158319692646288784059511771765477514951832885214983202919n;

    console.log('Registering tokens on Exchange:', CONTRACTS.EXCHANGE);
    const tx = await walletClient.writeContract({
        address: CONTRACTS.EXCHANGE,
        abi: exchangeAbi,
        functionName: 'registerToken',
        args: [yesTokenId, noTokenId, conditionId as `0x${string}`],
    });

    console.log('Registration TX:', tx);
    console.log('Tokens registered successfully!');
}

main().catch(console.error);

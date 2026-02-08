
import { createWalletClient, http, parseEther, createPublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem/utils';
import { config } from 'dotenv';

config();

const RPC_URLS = (process.env.RPC_URL || '').split(',').map(u => u.trim()).filter(Boolean);
const arcChain = defineChain({
    id: 5042002,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: {
        default: { http: RPC_URLS },
        public: { http: RPC_URLS },
    },
});

// Explicitly use the key that has funds
const DEPLOYER_PRIVATE_KEY = '0x17e0c712f9ea0821e255f820224ee3eb65de3abfc2a57c4fd5103396fe931024' as `0x${string}`;
const TAKER_ADDRESS = '0xa8d93Ad5Df49FA95ccE48261932b08eC3708DaF5' as `0x${string}`;

async function main() {
    const account = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const client = createWalletClient({
        account,
        chain: arcChain,
        transport: http(RPC_URLS[0]),
    });

    const publicClient = createPublicClient({
        chain: arcChain,
        transport: http(RPC_URLS[0]),
    });

    console.log(`Funding gas for taker ${TAKER_ADDRESS} from ${account.address}...`);

    const balance = await publicClient.getBalance({ address: account.address });
    console.log(`Deployer balance: ${balance}`);

    if (balance === 0n) {
        throw new Error("Deployer has no gas!");
    }

    const hash = await client.sendTransaction({
        to: TAKER_ADDRESS,
        value: parseEther('1'), // Send 1 USDC-gas
    });

    console.log(`Transaction submitted: ${hash}`);
}

main().catch(console.error);

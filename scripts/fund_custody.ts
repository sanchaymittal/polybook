import { config } from 'dotenv';
import {
    createPublicClient,
    createWalletClient,
    http,
    parseUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

config({ path: '.env' });

const CHAIN_ID = parseInt(process.env.CHAIN_ID || '5042002');
const RPC_URL = process.env.RPC_URL?.split(',')[0] || 'https://rpc.testnet.arc.network';
const USDC_ADDRESS = process.env.USDC_ADDRESS;
const CUSTODY_ADDRESS = process.env.CUSTODY_ADDRESS;
const PRIVATE_KEY = process.env.MM_PRIVATE_KEY;

if (!USDC_ADDRESS || !CUSTODY_ADDRESS || !PRIVATE_KEY) {
    console.error('❌ Missing required environment variables');
    process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const publicClient = createPublicClient({
    transport: http(RPC_URL)
});

const walletClient = createWalletClient({
    account,
    transport: http(RPC_URL),
    chain: {
        id: CHAIN_ID,
        name: 'Arc Testnet',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: {
            default: { http: [RPC_URL] },
            public: { http: [RPC_URL] }
        }
    }
});

// ERC20 ABI (minimal)
const ERC20_ABI = [
    {
        inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
        name: 'approve',
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function'
    },
    {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function'
    }
] as const;

// Custody ABI (minimal - deposit function)
const CUSTODY_ABI = [
    {
        inputs: [
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' }
        ],
        name: 'deposit',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    }
] as const;

async function main() {
    console.log('🏦 Funding Custody Contract');
    console.log('Wallet:', account.address);
    console.log('USDC:', USDC_ADDRESS);
    console.log('Custody:', CUSTODY_ADDRESS);
    console.log('');

    // Step 1: Try to get USDC from faucet (optional)
    console.log('📡 Attempting to request USDC from CLOB faucet...');
    try {
        const response = await fetch('http://127.0.0.1:3030/faucet', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address: account.address })
        });

        if (response.ok) {
            const data = await response.json();
            console.log('✅ Faucet response:', data);
            console.log('⏳ Waiting for faucet transaction to be mined...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
            console.log('⚠️  Faucet not available (HTTP', response.status, ') - will use existing balance');
        }
    } catch (error) {
        console.log('⚠️  Faucet not available - will use existing balance');
    }

    // Step 2: Check USDC balance
    console.log('\n💰 Checking USDC balance...');
    const balance = await publicClient.readContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address]
    });
    console.log(`Balance: ${balance} (${Number(balance) / 1e6} USDC)`);

    if (balance === 0n) {
        console.error('❌ No USDC balance. Faucet may have failed.');
        process.exit(1);
    }

    // Step 3: Approve Custody contract
    const depositAmount = parseUnits('1000', 6); // Deposit 1000 USDC
    console.log(`\n🔓 Approving Custody contract for ${Number(depositAmount) / 1e6} USDC...`);

    const approveHash = await walletClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [CUSTODY_ADDRESS as `0x${string}`, depositAmount]
    });
    console.log('Approve tx:', approveHash);
    console.log('⏳ Waiting for approval confirmation...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 4: Deposit to Custody
    console.log(`\n💳 Depositing ${Number(depositAmount) / 1e6} USDC to Custody contract...`);

    const depositHash = await walletClient.writeContract({
        address: CUSTODY_ADDRESS as `0x${string}`,
        abi: CUSTODY_ABI,
        functionName: 'deposit',
        args: [USDC_ADDRESS as `0x${string}`, depositAmount]
    });
    console.log('Deposit tx:', depositHash);
    console.log('⏳ Waiting for deposit confirmation...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    console.log('\n✅ Deposit complete!');
    console.log('The local Clearnode should detect this deposit and credit your ledger.');
    console.log('You can now run test_yellow_interaction.ts');
}

main().catch(console.error);

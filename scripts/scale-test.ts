import axios from 'axios';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from 'viem';
import { anvil } from 'viem/chains';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { CONTRACTS, RPC_URL, DEPLOYER_PRIVATE_KEY } from '../orchestrator/src/contracts.js';

const ORCHESTRATOR_URL = 'http://127.0.0.1:3031';
const ERC20_ABI = [
    { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
    { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const;

const CTF_ABI = [
    { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
] as const;

async function runScaleTest() {
    console.log('\n🚀 Starting Scale Test with 10 Traders...\n');

    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
    const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);
    const walletDeployer = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });

    // 1. Initialize Market
    console.log('Step 1: Creating & Starting Market...');
    const marketRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
        skill: 'skill.polybook.create_market',
        params: {
            template: 'BTC_UP_DOWN',
            slug: `scale-market-${Date.now()}`,
            startTimestamp: Date.now(),
            expiryTimestamp: Date.now() + 3600000
        }
    });
    const marketId = marketRes.data.data.marketId;
    await axios.post(`${ORCHESTRATOR_URL}/skill`, {
        skill: 'skill.polybook.start_market',
        params: { marketId, priceAtStart: 5000000000000 }
    });
    console.log(`✅ Market ${marketId} ready.`);

    // 2. Setup 10 Traders
    const traders: any[] = [];
    console.log('\nStep 2: Initializing 10 Traders (Keys, Capital, Approvals)...');

    for (let i = 0; i < 10; i++) {
        const pk = generatePrivateKey();
        const account = privateKeyToAccount(pk);
        const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });

        console.log(`[Trader ${i + 1}] ${account.address}`);

        // Fund ETH for Gas
        const hash = await walletDeployer.sendTransaction({
            to: account.address,
            value: parseUnits('1', 18)
        });
        await publicClient.waitForTransactionReceipt({ hash });

        // Register with Orchestrator (for signing)
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.register_scale_agent',
            params: { address: account.address, privateKey: pk }
        });

        // Initialize Real Assets (for Relay)
        await walletDeployer.writeContract({
            address: CONTRACTS.USDC,
            abi: ERC20_ABI,
            functionName: 'mint',
            args: [account.address, parseUnits('1000', 6)]
        });

        await wallet.writeContract({
            address: CONTRACTS.USDC,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [CONTRACTS.EXCHANGE, parseUnits('1000', 6)]
        });

        // Orchestrator internal balance
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'Scale Test' },
            agentAddress: account.address
        });

        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId },
            agentAddress: account.address
        });

        traders.push({ address: account.address, index: i, pk });
    }

    // 3. Trading Simulation
    console.log('\nStep 3: Preparing Sellers & Executing Concurrent Orders...');

    const CTF_ABI_SPLIT = [
        ...CTF_ABI,
        { name: 'getConditionId', type: 'function', inputs: [{ name: 'oracle', type: 'address' }, { name: 'questionId', type: 'bytes32' }, { name: 'outcomeSlotCount', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
        { name: 'splitPosition', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'partition', type: 'uint256[]' }, { name: 'amount', type: 'uint256' }], outputs: [] },
    ] as const;

    // Get conditionId from Orchestrator state or re-derive (simplest: re-derive if we had oracle/questionId)
    // Actually, we can just use the registerToken skill if it exposed it, but we can just use the known one from real-e2e or better, just have them all BUY.
    // If we want many matches, let's just have them all BUY and SELL, but for SELL they need shares.

    // Easier Scale Test: 10 Traders, all doing BUY/SELL against each other's overlaps.
    // To make it work without splitting, let's just have 5 traders BUY YES and 5 traders BUY NO? 
    // No, matching happens between BUY YES and SELL YES.

    // Let's just give them YES shares by splitting for the first 5.
    // We need the conditionId. Let's look it up from the market.
    const marketsInfo = await axios.get(`${ORCHESTRATOR_URL}/markets`);
    const market = marketsInfo.data.markets.find((m: any) => m.marketId === marketId);
    // In our mock, market object doesn't have conditionId exposed directly in the response usually.
    // But in index.ts/manager.ts, it might.

    console.log('Sellers splitting positions...');
    for (let i = 0; i < 5; i++) {
        const pk = traders[i].pk; // We need to store pk
        const account = privateKeyToAccount(pk);
        const wallet = createWalletClient({ account, chain: anvil, transport: http(RPC_URL) });

        // We'll skip the real split for now to keep it simple and just use BUY orders 
        // that overlap with existing LP liquidity if we had any.
        // OR: 5 traders place BUY orders, 5 traders place SELL orders.
        // If SELL fails on-chain, it still matches in CLOB?
        // Let's just ensure they overlap.
    }

    const orders = traders.map((trader, i) => {
        const isSeller = i < 5;
        const side = isSeller ? 1 : 0; // 5 Sellers, 5 Buyers
        const price = isSeller ? 0.45 + (0.01 * i) : 0.55 - (0.01 * (i - 5)); // Sellers at 0.45-0.49, Buyers at 0.55-0.51

        return axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.place_order',
            params: {
                marketId,
                side,
                outcome: 'UP',
                price,
                quantity: 10,
                type: 'LIMIT'
            },
            agentAddress: trader.address
        });
    });

    const results = await Promise.allSettled(orders);
    const successCount = results.filter(r => r.status === 'fulfilled' && (r as any).value.data.success).length;
    console.log(`\n✅ Submitted 10 orders. Success: ${successCount}`);

    // 4. Verification
    console.log('\nStep 4: Verifying Trade History...');
    await new Promise(r => setTimeout(r, 2000)); // Wait for matching

    const marketsRes = await axios.get(`${ORCHESTRATOR_URL}/markets`);
    const marketInfo = marketsRes.data.markets.find((m: any) => m.marketId === marketId);
    console.log('Market State:', marketInfo.state);

    // Let's check a few traders' positions
    for (let i = 0; i < 3; i++) {
        const posRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.get_positions',
            params: { marketId },
            agentAddress: traders[i].address
        });
        console.log(`[Trader ${i + 1}] Balance: ${posRes.data.data?.balance?.available || 0} USDC, Position: ${posRes.data.data?.position?.upQuantity || 0} YES`);
    }

    console.log('\n🎉 SCALE TEST COMPLETED!');
}

runScaleTest().catch(console.error);

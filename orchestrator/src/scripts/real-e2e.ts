import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, keccak256 } from 'viem';
import { anvil } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, RPC_URL, LP_PRIVATE_KEY, TRADER_A_PRIVATE_KEY, DEPLOYER_PRIVATE_KEY } from '../contracts.js';

/**
 * Real End-to-End Test Run
 * 
 * Flow:
 * 1. Setup Accounts & Clients
 * 2. Mint USDC to LP and Trader A
 * 3. Give Allowances (Exchange & CTF)
 * 4. Prepare Condition on CTF
 * 5. Split Position (LP provides liquidity)
 * 6. Register Market on CTFExchange
 * 7. Place Maker Order (LP, SELL YES)
 * 8. Place Taker Order (Trader A, BUY YES)
 * 9. Verify Match in CLOB & On-Chain
 */

const CLOB_URL = 'http://127.0.0.1:3030';

// EIP-712 Types for signing
const DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: 31337,
    verifyingContract: CONTRACTS.EXCHANGE as `0x${string}`,
};

const TYPES = {
    Order: [
        { name: 'salt', type: 'uint256' },
        { name: 'maker', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'taker', type: 'address' },
        { name: 'tokenId', type: 'uint256' },
        { name: 'makerAmount', type: 'uint256' },
        { name: 'takerAmount', type: 'uint256' },
        { name: 'expiration', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'feeRateBps', type: 'uint256' },
        { name: 'side', type: 'uint8' },
        { name: 'signatureType', type: 'uint8' },
    ],
} as const;

// ABIs
const ERC20_ABI = [
    { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
    { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
    { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] }
] as const;

const CTF_ABI = [
    { name: 'prepareCondition', type: 'function', inputs: [{ name: 'oracle', type: 'address' }, { name: 'questionId', type: 'bytes32' }, { name: 'outcomeSlotCount', type: 'uint256' }], outputs: [] },
    { name: 'getConditionId', type: 'function', inputs: [{ name: 'oracle', type: 'address' }, { name: 'questionId', type: 'bytes32' }, { name: 'outcomeSlotCount', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
    { name: 'splitPosition', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'partition', type: 'uint256[]' }, { name: 'amount', type: 'uint256' }], outputs: [] },
    { name: 'getCollectionId', type: 'function', inputs: [{ name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'indexSet', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
    { name: 'getPositionId', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'collectionId', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }] },
    { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
    { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }
] as const;

const EXCHANGE_ABI = [
    { name: 'registerToken', type: 'function', inputs: [{ name: 'token', type: 'uint256' }, { name: 'complement', type: 'uint256' }, { name: 'conditionId', type: 'bytes32' }], outputs: [] }
] as const;

async function main() {
    console.log('\n🚀 Starting Real End-to-End Test Run...\n');

    // 1. Setup
    const lp = privateKeyToAccount(LP_PRIVATE_KEY);
    const traderA = privateKeyToAccount(TRADER_A_PRIVATE_KEY);
    const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
    const walletLP = createWalletClient({ account: lp, chain: anvil, transport: http(RPC_URL) });
    const walletA = createWalletClient({ account: traderA, chain: anvil, transport: http(RPC_URL) });
    const walletDeployer = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });

    // 2. Mint USDC
    console.log('Minting USDC to LP and Trader A...');
    const mintAmount = parseUnits('1000', 6);
    await walletDeployer.writeContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'mint', args: [lp.address, mintAmount] });
    await walletDeployer.writeContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'mint', args: [traderA.address, mintAmount] });

    // 3. Approvals
    console.log('Granting approvals...');
    await walletLP.writeContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'approve', args: [CONTRACTS.CTF, mintAmount] });
    await walletLP.writeContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'setApprovalForAll', args: [CONTRACTS.EXCHANGE, true] });
    await walletA.writeContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'approve', args: [CONTRACTS.EXCHANGE, mintAmount] });

    // 4. Prepare Condition
    const oracle = lp.address; // Oracle is LP for simplicity
    const questionId = keccak256(Buffer.from(`Question-${Date.now()}`));
    console.log('Preparing condition...');
    await walletLP.writeContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'prepareCondition', args: [oracle, questionId, 2n] });
    const conditionId = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'getConditionId', args: [oracle, questionId, 2n] }) as `0x${string}`;
    console.log('Condition ID:', conditionId);

    // 5. Provide Liquidity (Split Position)
    console.log('LP Providing Liquidity (Splitting 100 USDC)...');
    const splitAmount = parseUnits('100', 6);
    await walletLP.writeContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'splitPosition', args: [CONTRACTS.USDC, '0x0000000000000000000000000000000000000000000000000000000000000000', conditionId, [1n, 2n], splitAmount] });

    // Derived Token IDs
    const collIdYes = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'getCollectionId', args: ['0x0000000000000000000000000000000000000000000000000000000000000000', conditionId, 1n] }) as `0x${string}`;
    const collIdNo = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'getCollectionId', args: ['0x0000000000000000000000000000000000000000000000000000000000000000', conditionId, 2n] }) as `0x${string}`;
    const yesTokenId = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'getPositionId', args: [CONTRACTS.USDC, collIdYes] }) as bigint;
    const noTokenId = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'getPositionId', args: [CONTRACTS.USDC, collIdNo] }) as bigint;
    console.log('YES Token ID:', yesTokenId.toString());
    console.log('NO Token ID:', noTokenId.toString());

    // 6. Register Market
    console.log('Registering tokens on Exchange...');
    await walletDeployer.writeContract({ address: CONTRACTS.EXCHANGE, abi: EXCHANGE_ABI, functionName: 'registerToken', args: [yesTokenId, noTokenId, conditionId] });

    // 7. Sign & Place Orders
    console.log('\n--- Trading Phase ---\n');

    const amountShares = parseUnits('10', 6); // 10 shares
    const amountUSDC = parseUnits('5', 6);    // 0.50 price -> 5 USDC

    const makerOrder = {
        salt: BigInt(Date.now()),
        maker: lp.address,
        signer: lp.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: yesTokenId,
        makerAmount: amountShares,
        takerAmount: amountUSDC,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 1, // SELL
        signatureType: 0,
    };

    const takerOrder = {
        salt: BigInt(Date.now() + 1),
        maker: traderA.address,
        signer: traderA.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: yesTokenId,
        makerAmount: amountUSDC,
        takerAmount: amountShares,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 0, // BUY
        signatureType: 0,
    };

    console.log('Signing orders...');
    const makerSig = await walletLP.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Order', message: makerOrder });
    const takerSig = await walletA.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'Order', message: takerOrder });

    const makerReq = {
        maker: makerOrder.maker,
        signer: makerOrder.signer,
        taker: makerOrder.taker,
        token_id: yesTokenId.toString(),
        salt: makerOrder.salt.toString(),
        maker_amount: makerOrder.makerAmount.toString(),
        taker_amount: makerOrder.takerAmount.toString(),
        expiration: makerOrder.expiration.toString(),
        nonce: makerOrder.nonce.toString(),
        fee_rate_bps: makerOrder.feeRateBps.toString(),
        side: 'SELL',
        signature_type: 0,
        signature: makerSig,
        order_hash: 'maker-' + Date.now(),
        price: '500000',
        quantity: amountShares.toString()
    };

    const takerReq = {
        maker: takerOrder.maker,
        signer: takerOrder.signer,
        taker: takerOrder.taker,
        token_id: yesTokenId.toString(),
        salt: takerOrder.salt.toString(),
        maker_amount: takerOrder.makerAmount.toString(),
        taker_amount: takerOrder.takerAmount.toString(),
        expiration: takerOrder.expiration.toString(),
        nonce: takerOrder.nonce.toString(),
        fee_rate_bps: takerOrder.feeRateBps.toString(),
        side: 'BUY',
        signature_type: 0,
        signature: takerSig,
        order_hash: 'taker-' + Date.now(),
        price: '500000',
        quantity: amountShares.toString()
    };

    console.log('Submitting SELL order...');
    const mRes = await fetch(`${CLOB_URL}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makerReq) });
    console.log('Maker Response:', await mRes.json());

    console.log('Submitting BUY order...');
    const tRes = await fetch(`${CLOB_URL}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(takerReq) });
    const tData: any = await tRes.json();
    console.log('Taker Response:', tData);

    if (tData.success && tData.trades?.length > 0) {
        console.log('\n✅ Match successful in CLOB!');
        console.log('Waiting for on-chain relay (5s)...');
        await new Promise(r => setTimeout(r, 5000));

        // Final check: Taker should have YES tokens now
        const takerBalance = await publicClient.readContract({ address: CONTRACTS.CTF, abi: CTF_ABI, functionName: 'balanceOf', args: [traderA.address, yesTokenId] }) as bigint;
        console.log(`Final Trader A YES Balance: ${formatUnits(takerBalance, 6)} shares`);

        if (takerBalance >= amountShares) {
            console.log('\n🎉 ALL TESTS PASSED! Trade executed and settled on-chain.\n');

            // 10. Resolution & Redemption
            console.log('--- Resolution & Redemption Phase ---\n');

            console.log('Reporting payouts (YES wins)...');
            await walletLP.writeContract({
                address: CONTRACTS.CTF,
                abi: [...CTF_ABI, { name: 'reportPayouts', type: 'function', inputs: [{ name: 'questionId', type: 'bytes32' }, { name: 'payouts', type: 'uint256[]' }], outputs: [] }],
                functionName: 'reportPayouts',
                args: [questionId, [1n, 0n]]
            });

            console.log('Trader A redeeming YES positions...');
            const takerUsdcBefore = await publicClient.readContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [traderA.address] }) as bigint;
            await walletA.writeContract({
                address: CONTRACTS.CTF,
                abi: [...CTF_ABI, { name: 'redeemPositions', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'indexSets', type: 'uint256[]' }], outputs: [] }],
                functionName: 'redeemPositions',
                args: [CONTRACTS.USDC, '0x0000000000000000000000000000000000000000000000000000000000000000', conditionId, [1n]]
            });

            const takerUsdcAfter = await publicClient.readContract({ address: CONTRACTS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [traderA.address] }) as bigint;
            console.log(`Trader A USDC after redemption: ${formatUnits(takerUsdcAfter, 6)} (+ ${formatUnits(takerUsdcAfter - takerUsdcBefore, 6)})`);

            if (takerUsdcAfter > takerUsdcBefore) {
                console.log('\n🎉 FULL LIFECYCLE VERIFIED! Condition -> Trade -> Resolution -> Redemption.');
            }
        }
    } else {
        console.error('\n❌ CLOB Match failed!', tData.error);
    }
}

main().catch(console.error);

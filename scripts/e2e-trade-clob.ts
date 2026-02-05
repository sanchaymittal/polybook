import { createPublicClient, createWalletClient, http, parseUnits, keccak256, encodeAbiParameters, parseAbiParameters, toBytes } from 'viem';
import { anvil } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, RPC_URL, LP_ADDRESS, LP_PRIVATE_KEY, TRADER_A_PRIVATE_KEY, TRADER_A_ADDRESS, DEPLOYER_PRIVATE_KEY } from '../orchestrator/src/contracts.js';

const TAKER_A_PK = TRADER_A_PRIVATE_KEY;
const MAKER_PK = LP_PRIVATE_KEY;

const taker = privateKeyToAccount(TAKER_A_PK);
const maker = privateKeyToAccount(MAKER_PK);
const deployer = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const CLOB_URL = 'http://127.0.0.1:3030';

// EIP-712 Types
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

async function signOrder(account: any, order: any) {
    const walletClient = createWalletClient({
        account,
        chain: anvil,
        transport: http(RPC_URL),
    });

    const signature = await walletClient.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: 'Order',
        message: order,
    });

    return signature;
}

async function main() {
    console.log('\n🚀 Starting Self-Contained E2E Trade Verification...\n');

    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
    const walletClientDeployer = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });
    const walletClientTaker = createWalletClient({ account: taker, chain: anvil, transport: http(RPC_URL) });
    const walletClientMaker = createWalletClient({ account: maker, chain: anvil, transport: http(RPC_URL) });

    const usdcAbi = [
        { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
        { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }
    ] as const;

    const ctfAbi = [
        { name: 'prepareCondition', type: 'function', inputs: [{ name: 'oracle', type: 'address' }, { name: 'questionId', type: 'bytes32' }, { name: 'outcomeSlotCount', type: 'uint256' }], outputs: [] },
        { name: 'getConditionId', type: 'function', inputs: [{ name: 'oracle', type: 'address' }, { name: 'questionId', type: 'bytes32' }, { name: 'outcomeSlotCount', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
        { name: 'getCollectionId', type: 'function', inputs: [{ name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'indexSet', type: 'uint256' }], outputs: [{ name: '', type: 'bytes32' }] },
        { name: 'getPositionId', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'collectionId', type: 'bytes32' }], outputs: [{ name: '', type: 'uint256' }] },
        { name: 'splitPosition', type: 'function', inputs: [{ name: 'collateralToken', type: 'address' }, { name: 'parentCollectionId', type: 'bytes32' }, { name: 'conditionId', type: 'bytes32' }, { name: 'partition', type: 'uint256[]' }, { name: 'amount', type: 'uint256' }], outputs: [] },
        { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] },
        { name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] },
    ] as const;

    const exchangeAbi = [
        { name: 'registerToken', type: 'function', inputs: [{ name: 'token', type: 'uint256' }, { name: 'complement', type: 'uint256' }, { name: 'conditionId', type: 'bytes32' }], outputs: [] },
        { name: 'addOperator', type: 'function', inputs: [{ name: 'operator_', type: 'address' }], outputs: [] },
    ] as const;

    // 1. Prepare Condition
    console.log('Step 1: Preparing Condition...');
    const questionId = keccak256(toBytes(`e2e-test-${Date.now()}`));
    const oracle = deployer.address;
    const outcomeSlotCount = 2n;

    const prepHash = await walletClientDeployer.writeContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'prepareCondition',
        args: [oracle, questionId, outcomeSlotCount],
    });
    await publicClient.waitForTransactionReceipt({ hash: prepHash });

    const conditionId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'getConditionId',
        args: [oracle, questionId, outcomeSlotCount],
    });
    console.log(`✅ Condition prepared: ${conditionId}`);

    // 2. Compute Token IDs & Register
    console.log('\nStep 2: Computing Token IDs & Registering on Exchange...');
    const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';

    const collectionIdYes = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'getCollectionId',
        args: [parentCollectionId, conditionId, 1n],
    });
    const collectionIdNo = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'getCollectionId',
        args: [parentCollectionId, conditionId, 2n],
    });

    const yesTokenId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'getPositionId',
        args: [CONTRACTS.USDC, collectionIdYes],
    });
    const noTokenId = await publicClient.readContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'getPositionId',
        args: [CONTRACTS.USDC, collectionIdNo],
    });

    const regHash = await walletClientDeployer.writeContract({
        address: CONTRACTS.EXCHANGE,
        abi: exchangeAbi,
        functionName: 'registerToken',
        args: [yesTokenId, noTokenId, conditionId],
    });
    await publicClient.waitForTransactionReceipt({ hash: regHash });
    console.log(`✅ Tokens registered on Exchange.`);

    // 3. Setup LP Assets
    console.log('\nStep 3: Setting up LP Assets (Split 100 USDC)...');
    await walletClientDeployer.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'mint',
        args: [maker.address, parseUnits('100', 6)],
    });
    await walletClientMaker.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'approve',
        args: [CONTRACTS.CTF, parseUnits('100', 6)],
    });
    const splitHash = await walletClientMaker.writeContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'splitPosition',
        args: [CONTRACTS.USDC, parentCollectionId, conditionId, [1n, 2n], parseUnits('100', 6)],
    });
    await publicClient.waitForTransactionReceipt({ hash: splitHash });

    await walletClientMaker.writeContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'setApprovalForAll',
        args: [CONTRACTS.EXCHANGE, true],
    });
    console.log(`✅ LP Ready with ${yesTokenId} tokens.`);

    // 4. Setup Taker Assets
    console.log('\nStep 4: Setting up Taker Assets (Mint 100 USDC)...');
    await walletClientDeployer.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'mint',
        args: [taker.address, parseUnits('100', 6)],
    });
    await walletClientTaker.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'approve',
        args: [CONTRACTS.EXCHANGE, parseUnits('100', 6)],
    });
    console.log(`✅ Taker Ready.`);

    // 5. Place Orders & Match
    console.log('\nStep 5: Placing Orders & Matching in CLOB...');

    const makerOrderMsg = {
        salt: BigInt(Date.now()),
        maker: maker.address,
        signer: maker.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: yesTokenId,
        makerAmount: parseUnits('10', 6), // 10 shares
        takerAmount: parseUnits('5', 6), // 5 USDC
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 1, // SELL
        signatureType: 0,
    };

    const takerOrderMsg = {
        salt: BigInt(Date.now() + 1),
        maker: taker.address,
        signer: taker.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: yesTokenId,
        makerAmount: parseUnits('5', 6), // 5 USDC
        takerAmount: parseUnits('10', 6), // 10 shares
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 0, // BUY
        signatureType: 0,
    };

    const makerSig = await signOrder(maker, makerOrderMsg);
    const takerSig = await signOrder(taker, takerOrderMsg);

    const makerReq = {
        maker: makerOrderMsg.maker,
        signer: makerOrderMsg.signer,
        taker: makerOrderMsg.taker,
        token_id: yesTokenId.toString(),
        salt: makerOrderMsg.salt.toString(),
        maker_amount: makerOrderMsg.makerAmount.toString(),
        taker_amount: makerOrderMsg.takerAmount.toString(),
        expiration: makerOrderMsg.expiration.toString(),
        nonce: makerOrderMsg.nonce.toString(),
        fee_rate_bps: makerOrderMsg.feeRateBps.toString(),
        side: 'SELL',
        signature_type: 0,
        signature: makerSig,
        order_hash: `maker-${Date.now()}`,
        price: '500000',
        quantity: '10000000'
    };

    const takerReq = {
        maker: takerOrderMsg.maker,
        signer: takerOrderMsg.signer,
        taker: takerOrderMsg.taker,
        token_id: yesTokenId.toString(),
        salt: takerOrderMsg.salt.toString(),
        maker_amount: takerOrderMsg.makerAmount.toString(),
        taker_amount: takerOrderMsg.takerAmount.toString(),
        expiration: takerOrderMsg.expiration.toString(),
        nonce: takerOrderMsg.nonce.toString(),
        fee_rate_bps: takerOrderMsg.feeRateBps.toString(),
        side: 'BUY',
        signature_type: 0,
        signature: takerSig,
        order_hash: `taker-${Date.now()}`,
        price: '500000',
        quantity: '10000000'
    };

    const mRes = await fetch(`${CLOB_URL}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makerReq) });
    if (!mRes.ok) throw new Error(`Maker submission failed: ${await mRes.text()}`);
    console.log('Maker Order Submitted.');

    const tRes = await fetch(`${CLOB_URL}/order`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(takerReq) });
    if (!tRes.ok) throw new Error(`Taker submission failed: ${await tRes.text()}`);
    const tData = await tRes.json() as any;

    if (tData.success && tData.trades?.length > 0) {
        console.log('✅ Trade matched in CLOB!');
        console.log('Waiting for relay worker (5s)...');
        await new Promise(r => setTimeout(r, 5000));

        const traderAYesBalance = await publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: ctfAbi,
            functionName: 'balanceOf',
            args: [taker.address, yesTokenId],
        });
        console.log(`\nFinal Trader A YES Balance: ${traderAYesBalance} shares (Expected 10000000)`);

        if (traderAYesBalance > 0n) {
            console.log('\n🎉 ALL TESTS PASSED! Trade executed and settled on-chain.');
        } else {
            console.log('\n❌ Verification Failed: Balance not updated on-chain. Check clob.log.');
        }
    } else {
        console.error('❌ Match failed in CLOB:', tData.error || 'No trades produced');
    }
}

main().catch(console.error);

import { createPublicClient, createWalletClient, http, parseUnits, keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import { anvil } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { CONTRACTS, RPC_URL, LP_ADDRESS, LP_PRIVATE_KEY } from '../contracts.js';

// Anvil Accounts
const TAKER_A_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'; // Account #2
const MAKER_PK = LP_PRIVATE_KEY;

const taker = privateKeyToAccount(TAKER_A_PK);
const maker = privateKeyToAccount(MAKER_PK);

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
    console.log('--- Starting E2E Trade Verification ---');

    const publicClient = createPublicClient({ chain: anvil, transport: http(RPC_URL) });
    const deployer = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    const walletClientDeployer = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC_URL) });

    const usdcAbi = [
        { name: 'mint', type: 'function', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
        { name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] }
    ] as const;

    console.log('Minting USDC to Taker...');
    await walletClientDeployer.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'mint',
        args: [taker.address, parseUnits('100', 6)],
    });

    console.log('Taker approving Exchange to spend USDC...');
    const walletClientTaker = createWalletClient({ account: taker, chain: anvil, transport: http(RPC_URL) });
    await walletClientTaker.writeContract({
        address: CONTRACTS.USDC,
        abi: usdcAbi,
        functionName: 'approve',
        args: [CONTRACTS.EXCHANGE, parseUnits('100', 6)],
    });

    const ctfAbi = [
        { name: 'setApprovalForAll', type: 'function', inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }], outputs: [] }
    ] as const;
    console.log('LP (Maker) approving Exchange to spend shares...');
    const walletClientMaker = createWalletClient({ account: maker, chain: anvil, transport: http(RPC_URL) });
    await walletClientMaker.writeContract({
        address: CONTRACTS.CTF,
        abi: ctfAbi,
        functionName: 'setApprovalForAll',
        args: [CONTRACTS.EXCHANGE, true],
    });

    // 1. Prepare Order Parameters
    const tokenId = '61378011527142424347118046087792028415421176150217020092334026086220015056018';

    // Maker: SELL 10 shares @ 0.50
    const makerOrderMsg = {
        salt: BigInt(Date.now()),
        maker: maker.address,
        signer: maker.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: BigInt(tokenId),
        makerAmount: parseUnits('10', 6), // 10 shares (6 decimals)
        takerAmount: parseUnits('5', 6), // 5 USDC (6 decimals)
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 1, // SELL
        signatureType: 0, // EOA
    };

    // Taker: BUY 10 shares @ 0.50
    const takerOrderMsg = {
        salt: BigInt(Date.now() + 1),
        maker: taker.address,
        signer: taker.address,
        taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        tokenId: BigInt(tokenId),
        makerAmount: parseUnits('5', 6), // 5 USDC
        takerAmount: parseUnits('10', 6), // 10 shares
        expiration: BigInt(Math.floor(Date.now() / 1000) + 3600),
        nonce: 0n,
        feeRateBps: 0n,
        side: 0, // BUY
        signatureType: 0, // EOA
    };

    console.log('Signing orders...');
    const makerSig = await signOrder(maker, makerOrderMsg);
    const takerSig = await signOrder(taker, takerOrderMsg);

    const makerReq = {
        maker: makerOrderMsg.maker,
        signer: makerOrderMsg.signer,
        taker: makerOrderMsg.taker,
        token_id: makerOrderMsg.tokenId.toString(),
        salt: makerOrderMsg.salt.toString(),
        maker_amount: makerOrderMsg.makerAmount.toString(),
        taker_amount: makerOrderMsg.takerAmount.toString(),
        expiration: makerOrderMsg.expiration.toString(),
        nonce: makerOrderMsg.nonce.toString(),
        fee_rate_bps: makerOrderMsg.feeRateBps.toString(),
        side: 'SELL',
        signature_type: 0,
        signature: makerSig,
        order_hash: 'maker-hash',
        price: '500000',
        quantity: '10000000' // 10 * 10^6
    };

    const takerReq = {
        maker: takerOrderMsg.maker,
        signer: takerOrderMsg.signer,
        taker: takerOrderMsg.taker,
        token_id: takerOrderMsg.tokenId.toString(),
        salt: takerOrderMsg.salt.toString(),
        maker_amount: takerOrderMsg.makerAmount.toString(),
        taker_amount: takerOrderMsg.takerAmount.toString(),
        expiration: takerOrderMsg.expiration.toString(),
        nonce: takerOrderMsg.nonce.toString(),
        fee_rate_bps: takerOrderMsg.feeRateBps.toString(),
        side: 'BUY',
        signature_type: 0,
        signature: takerSig,
        order_hash: 'taker-hash',
        price: '500000',
        quantity: '10000000' // 10 * 10^6
    };

    console.log('Submitting Maker Order...');
    const mRes = await fetch(`${CLOB_URL}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makerReq),
    });
    const mText = await mRes.text();
    console.log('Maker Raw Response:', mText);
    if (!mRes.ok) throw new Error('Maker submission failed');

    console.log('Submitting Taker Order (Should trigger match)...');
    const tRes = await fetch(`${CLOB_URL}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(takerReq),
    });
    const tText = await tRes.text();
    console.log('Taker Raw Response:', tText);
    if (!tRes.ok) throw new Error('Taker submission failed');
    const tData = JSON.parse(tText);

    if (tData.success && tData.trades && tData.trades.length > 0) {
        console.log('✅ Trade matched in CLOB!');
        console.log('Waiting for relay worker to execute on-chain...');
        await new Promise(r => setTimeout(r, 5000));
        console.log('Verification complete. Check server logs for relay status.');
    } else {
        console.error('❌ Match failed in CLOB:', tData.error || 'No trades produced');
    }
}

main().catch(console.error);

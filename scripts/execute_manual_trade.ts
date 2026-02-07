import { createWalletClient, http, createPublicClient, defineChain, parseAbi, parseUnits, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const CLOB_API_URL = process.env.CLOB_API_URL || 'http://127.0.0.1:3030';
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as Hex;
const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '5042002');
const EXCHANGE_ADDRESS = getAddress(process.env.EXCHANGE_ADDRESS!);
const USDC_ADDRESS = getAddress(process.env.USDC_ADDRESS!);

const ARC_TESTNET = defineChain({
    id: CHAIN_ID,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
        default: { http: [RPC_URL] },
        public: { http: [RPC_URL] },
    },
});

const account = privateKeyToAccount(PRIVATE_KEY);
const wallet = createWalletClient({ account, chain: ARC_TESTNET, transport: http() });
const publicClient = createPublicClient({ chain: ARC_TESTNET, transport: http() });

const ERC20_ABI = parseAbi([
    "function mint(address to, uint256 amount) external",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)"
]);

const DOMAIN = {
    name: 'Polymarket CTF Exchange',
    version: '1',
    chainId: CHAIN_ID, // viem handles bigint/number conversion
    verifyingContract: EXCHANGE_ADDRESS,
} as const;

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

async function signOrder(order: any) {
    return await wallet.signTypedData({
        domain: DOMAIN,
        types: TYPES,
        primaryType: 'Order',
        message: order,
    });
}

async function main() {
    console.log("🚀 Executing Manual Trade to Verify Matching...");

    // 1. Fetch Active Market
    try {
        const marketsRes = await axios.get(`${CLOB_API_URL}/markets?status=ACTIVE`);
        const markets = marketsRes.data.markets;
        if (!markets || markets.length === 0) throw new Error("No active markets found!");

        // Pick the first one
        const market = markets[0];
        console.log(`📊 Found Market: ${market.slug}`);
        console.log(`   YES Token: ${market.yes_token_id}`);

        // 2. Prepare Match Params (Buy 10 YES at 0.51)
        const price = 0.51;
        const qty = 10;
        const priceWei = parseUnits(price.toString(), 6);
        const qtyWei = parseUnits(qty.toString(), 6);

        const makerAmount = parseUnits((price * qty).toString(), 6); // USDC to pay (5.1 USDC)
        const takerAmount = qtyWei; // Tokens to receive

        // 3. Mint USDC if needed
        const usdcBal = await publicClient.readContract({
            address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address]
        });
        console.log(`💰 USDC Balance: ${Number(usdcBal) / 1e6} (Need: ${Number(makerAmount) / 1e6})`);

        if (usdcBal < makerAmount) {
            console.log("   Minting 100 USDC...");
            const mintTx = await wallet.writeContract({
                address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'mint',
                args: [account.address, parseUnits('100', 6)]
            });
            await publicClient.waitForTransactionReceipt({ hash: mintTx });
            console.log("   ✅ Minted.");
        }

        // 4. Approve Exchange
        console.log("🔓 Approving Exchange...");
        const approveTx = await wallet.writeContract({
            address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve',
            args: [EXCHANGE_ADDRESS, makerAmount * 10n] // Approve plenty
        });
        await publicClient.waitForTransactionReceipt({ hash: approveTx });
        console.log("   ✅ Approved.");

        // 5. Build and Sign Order
        const salt = BigInt(Math.floor(Math.random() * 1000000));
        const expiration = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 mins

        const orderData = {
            salt,
            maker: account.address,
            signer: account.address,
            taker: '0x0000000000000000000000000000000000000000',
            tokenId: BigInt(market.yes_token_id),
            makerAmount,
            takerAmount,
            expiration,
            nonce: 0n,
            feeRateBps: 0n,
            side: 0, // BUY
            signatureType: 0, // EOA
        };

        console.log("✍️ Signing Order...");
        const signature = await signOrder(orderData);

        // 6. Submit to CLOB
        const payload = {
            ...orderData,
            tokenId: orderData.tokenId.toString(),
            makerAmount: orderData.makerAmount.toString(),
            takerAmount: orderData.takerAmount.toString(),
            salt: orderData.salt.toString(),
            expiration: orderData.expiration.toString(),
            nonce: orderData.nonce.toString(),
            feeRateBps: orderData.feeRateBps.toString(),
            signature,
            price: parseUnits(price.toString(), 6).toString(),
            quantity: qtyWei.toString(),
            side: "BUY",
            order_hash: "0x" // CLOB will compute
        };

        // Remove helper fields not in API payload (CLOB ignores them usually, but clean is better)
        // Actually CLOB needs specific fields. MM-Gateway sends:
        // maker, token_id, side, price, quantity, order_hash, salt, signer, taker, maker_amount, taker_amount, expiration, nonce, fee_rate_bps, signature_type, signature

        // Remap to match what MM-Gateway sends exactly
        const apiPayload = {
            maker: account.address,
            token_id: orderData.tokenId.toString(),
            side: "BUY",
            price: priceWei.toString(),
            quantity: qtyWei.toString(),
            order_hash: "0x0000000000000000000000000000000000000000000000000000000000000000", // Placeholder
            salt: orderData.salt.toString(),
            signer: account.address,
            taker: '0x0000000000000000000000000000000000000000',
            maker_amount: orderData.makerAmount.toString(),
            taker_amount: orderData.takerAmount.toString(),
            expiration: orderData.expiration.toString(),
            nonce: "0",
            fee_rate_bps: "0",
            signature_type: 0,
            signature
        };

        console.log("📤 Submitting to CLOB...");
        const res = await axios.post(`${CLOB_API_URL}/order`, apiPayload);

        if (res.data.success) {
            console.log("✅ Order Submitted Successfully!");
            console.log("   Order ID:", res.data.order_id);
            console.log("   Trades:", JSON.stringify(res.data.trades, null, 2));
        } else {
            console.error("❌ Submission Failed:", res.data);
        }

    } catch (e: any) {
        console.error("❌ Error:", e.response?.data || e.message);
    }
}

main();

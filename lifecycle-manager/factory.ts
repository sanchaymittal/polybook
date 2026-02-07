import { createWalletClient, http, parseAbi, getAddress, keccak256, createPublicClient, defineChain, encodePacked } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import axios from 'axios';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '5042002');
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;

const ADAPTER_ADDRESS = getAddress(process.env.ADAPTER_ADDRESS!);
const CLOB_API_URL = process.env.CLOB_API_URL!;

const ADAPTER_ABI = parseAbi([
    "function initialize(bytes32 assetId, uint8 marketType, int256 strikePrice, uint256 expiration, string description, bytes storkData) external returns (bytes32)"
]);

const STORK_API_KEY = process.env.STORK_API_KEY!;
const STORK_API_URL = process.env.STORK_API_URL || 'https://rest.jp.stork-oracle.network';

// MarketType enum values
const MarketType = {
    PRICE_ABOVE_STRIKE: 0,
    PRICE_RANGE_UP_DOWN: 1
};

// Official Stork getLatestUpdateData implementation
async function getLatestUpdateData(endpoint: string, authKey: string, assetIds: string) {
    const response = await fetch(`${endpoint}/v1/prices/latest?assets=${assetIds}`, {
        headers: {
            Authorization: `Basic ${authKey}`,
        },
    });

    const rawJson = await response.text();
    const safeJsonText = rawJson.replace(
        /(?<!["\d])\b\d{16,}\b(?!["])/g, // Regex to find large integers not already in quotes
        (match: any) => `"${match}"`, // Convert large numbers to strings
    );

    const responseData = JSON.parse(safeJsonText);

    return Object.keys(responseData.data).map((key: any) => {
        const data = responseData.data[key];

        return {
            temporalNumericValue: {
                timestampNs: data.stork_signed_price.timestamped_signature.timestamp,
                quantizedValue: data.stork_signed_price.price,
            },
            id: data.stork_signed_price.encoded_asset_id,
            publisherMerkleRoot: data.stork_signed_price.publisher_merkle_root,
            valueComputeAlgHash: '0x' + data.stork_signed_price.calculation_alg.checksum,
            r: data.stork_signed_price.timestamped_signature.signature.r,
            s: data.stork_signed_price.timestamped_signature.signature.s,
            v: data.stork_signed_price.timestamped_signature.signature.v,
        };
    });
}

// Convert Stork update object to encoded bytes using ethers (like official Stork code)
function encodeStorkUpdate(update: any): `0x${string}` {
    console.log("\n=== ENCODING STORK UPDATE ===");
    console.log("timestampNs:", update.temporalNumericValue.timestampNs);
    console.log("quantizedValue:", update.temporalNumericValue.quantizedValue);
    console.log("v (hex):", update.v, "-> (decimal):", parseInt(update.v, 16));
    console.log("=============================\n");

    // Convert object to array format for unnamed tuples
    // The structure is: ((uint64,int192),bytes32,bytes32,bytes32,bytes32,bytes32,uint8)[]
    const updateArray = [[
        [
            update.temporalNumericValue.timestampNs,  // Keep as string, ethers will convert
            update.temporalNumericValue.quantizedValue  // Keep as string, ethers will convert
        ],
        update.id,
        update.publisherMerkleRoot,
        update.valueComputeAlgHash,
        update.r,
        update.s,
        update.v  // Keep as hex string, ethers will convert
    ]];

    console.log("updateArray structure:");
    console.log("- Outer array length:", updateArray.length);
    console.log("- Inner array length:", updateArray[0].length);
    console.log("- Inner tuple length:", updateArray[0][0].length);
    console.log("Full structure:", JSON.stringify(updateArray, null, 2));

    // Use ethers AbiCoder
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
        ['((uint64,int192),bytes32,bytes32,bytes32,bytes32,bytes32,uint8)[]'],
        [updateArray]  // Wrap in another array
    ) as `0x${string}`;

    console.log("✅ Encoded successfully, length:", encoded.length);
    return encoded;
}

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

export async function createNextMarket() {
    const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({
        account,
        chain: ARC_TESTNET,
        transport: http()
    });

    const assetId = "BTCUSD";
    const duration = parseInt(process.env.MARKET_DURATION_SECONDS || "300");
    const now = Math.floor(Date.now() / 1000);
    // Align to the next boundary (e.g. if now is 12:02, next expiration is 12:05)
    const nextBoundary = Math.floor(now / duration) * duration + duration;
    const startTimestamp = nextBoundary - duration;
    const expiration = BigInt(nextBoundary);

    const description = `btc-up-and-down-5min-${startTimestamp}`;
    const slug = `btc-up-and-down-5min-${startTimestamp}`;

    console.log(`🚀 Creating Automated Market: ${slug}`);

    // 1. Fetch opening price from Stork API using official format
    console.log("📊 Fetching opening price from Stork...");
    const updates = await getLatestUpdateData(STORK_API_URL, STORK_API_KEY, assetId);
    const update = updates[0];

    const openingPrice = BigInt(update.temporalNumericValue.quantizedValue);
    console.log(`✅ Opening Price: ${openingPrice / (10n ** 18n)} (raw: ${openingPrice})`);

    // 2. Encode Stork update data
    const encodedAssetId = update.id as `0x${string}`;
    const storkData = encodeStorkUpdate(update);

    // 3. On-Chain Init
    console.log(`🔑 Using Encoded Asset ID: ${encodedAssetId}`);
    // Stork requires a fee (typically 1 wei per update)
    const storkFee = 1n; // 1 wei per update
    console.log(`💰 Sending Stork fee: ${storkFee} wei`);

    try {
        const tx = await wallet.writeContract({
            address: ADAPTER_ADDRESS,
            abi: ADAPTER_ABI,
            functionName: 'initialize',
            args: [
                encodedAssetId, // Use encoded ID instead of padded string
                MarketType.PRICE_RANGE_UP_DOWN,  // UP/DOWN market type
                0n,  // strikePrice unused for UP_DOWN markets
                expiration,
                description,
                storkData  // Stork signed price data
            ],
            value: storkFee  // Send fee for Stork update
        });
        console.log(`✅ Transaction Sent: ${tx}`);

        // Wait for receipt
        console.log("⏳ Waiting for transaction confirmation...");
        const publicClient = createPublicClient({
            chain: ARC_TESTNET,
            transport: http()
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
        if (receipt.status === 'reverted') {
            console.error("❌ Transaction Reverted!", receipt);
            process.exit(1);
        }
        console.log("✅ Transaction Confirmed!");
    } catch (e: any) {
        const msg = e.shortMessage || e.message || "";
        if (msg.includes("Question already initialized") || msg.includes("Reason: Question already initialized")) {
            console.log("⚠️ Market already initialized on-chain. Proceeding to import...");
        } else {
            console.error("❌ Initialization Failed:", msg);
            throw e;
        }
    }

    // 2. Derive IDs (matching StorkCtfAdapter.sol)
    console.log("🧮 Deriving Question and Condition IDs...");
    const questionID = keccak256(encodePacked(
        ['bytes32', 'uint8', 'int256', 'uint256', 'string', 'address'],
        [encodedAssetId, MarketType.PRICE_RANGE_UP_DOWN, 0n, expiration, description, account.address]
    ));

    const conditionID = keccak256(encodePacked(
        ['address', 'bytes32', 'uint256'],
        [ADAPTER_ADDRESS, questionID, 2n]
    ));

    console.log(`Question ID: ${questionID}`);
    console.log(`Condition ID: ${conditionID}`);

    console.log("Waiting for confirmation...");
    await new Promise(r => setTimeout(r, 10000));

    // 3. Import to CLOB
    console.log("🧮 Calculating Token IDs for CLOB Import...");
    const parentCollectionId = "0x0000000000000000000000000000000000000000000000000000000000000000";

    const CTF_ADDRESS = getAddress(process.env.CTF_ADDRESS || "0x41eB51a330c937B9c221D33037F7776716887c21");
    const USDC_ADDRESS = getAddress(process.env.USDC_ADDRESS || "0x9e11B2412Ea321FFb3C2f4647812C78aAA055a47");

    const CTF_ABI = parseAbi([
        "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)",
        "function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)"
    ]);

    const publicClient = createPublicClient({
        chain: ARC_TESTNET,
        transport: http()
    });

    const collectionId1 = await publicClient.readContract({
        address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'getCollectionId',
        args: [parentCollectionId, conditionID, 1n]
    });
    const collectionId2 = await publicClient.readContract({
        address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'getCollectionId',
        args: [parentCollectionId, conditionID, 2n]
    });

    const noTokenId = await publicClient.readContract({
        address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'getPositionId',
        args: [USDC_ADDRESS, collectionId1]
    });
    const yesTokenId = await publicClient.readContract({
        address: CTF_ADDRESS, abi: CTF_ABI, functionName: 'getPositionId',
        args: [USDC_ADDRESS, collectionId2]
    });

    // 3.5. Register tokens on Exchange
    console.log("📝 Registering tokens on Exchange...");
    const EXCHANGE_ADDRESS = getAddress(process.env.EXCHANGE_ADDRESS!);
    const EXCHANGE_ABI = parseAbi([
        "function registerToken(uint256 token, uint256 complement, bytes32 conditionId) external"
    ]);

    try {
        const regTx = await wallet.writeContract({
            address: EXCHANGE_ADDRESS,
            abi: EXCHANGE_ABI,
            functionName: 'registerToken',
            args: [yesTokenId, noTokenId, conditionID]
        });
        console.log(`✅ Token Registration Tx: ${regTx}`);
        await publicClient.waitForTransactionReceipt({ hash: regTx });
        console.log("✅ Tokens Registered on Exchange!");
    } catch (e: any) {
        const msg = e.shortMessage || e.message || "";
        if (msg.includes("AlreadyRegistered")) {
            console.log("⚠️ Tokens already registered on Exchange.");
        } else {
            console.error("❌ Token Registration Failed:", msg);
            throw e;
        }
    }

    // 4. Import to CLOB

    try {
        await axios.post(`${CLOB_API_URL}/admin/import-market`, {
            slug,
            question: description,
            question_id: questionID,
            condition_id: conditionID,
            yes_token_id: yesTokenId.toString(),
            no_token_id: noTokenId.toString()
        });
        console.log("✅ Market Imported to CLOB!");

        // 4. Save to Local Registry
        const registryPath = path.join(__dirname, 'registry.json');
        let registry: any[] = [];
        try {
            registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        } catch (e) { }

        registry.push({
            question_id: questionID,
            condition_id: conditionID,
            slug,
            question: description,
            yes_token_id: yesTokenId.toString(),
            no_token_id: noTokenId.toString()
        });
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        console.log("💾 Market Saved to Local Registry!");
    } catch (e: any) {
        console.error("❌ CLOB Import Failed:", e.response?.data || e.message);
    }
}

// Check if running directly
if (import.meta.url === `file://${process.argv[1]}`) {
    createNextMarket().catch((error) => {
        console.error("Fatal error:", error);
        process.exit(1);
    });
}

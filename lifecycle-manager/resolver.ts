import { createWalletClient, http, fallback, parseAbi, getAddress, encodeAbiParameters, parseAbiParameters } from 'viem';
import { ethers } from 'ethers';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '5042002');
const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;
const ADAPTER_ADDRESS = getAddress(process.env.ADAPTER_ADDRESS!);

const STORK_API_KEY = 'YXJjLWhhY2stNjozZmEzZTE5Ni1mODUxLTQzZmYtYjFlOS0zY2ExNWJjZWM2OGI=';
const STORK_API_URL = 'https://rest.jp.stork-oracle.network';

const ADAPTER_ABI = parseAbi([
    "function resolve(bytes32 questionID, bytes storkData) external payable"
]);

// Safe JSON parser for large integers (Stork API)
async function getLatestUpdateData(endpoint: string, authKey: string, assetIds: string) {
    const response = await fetch(`${endpoint}/v1/prices/latest?assets=${assetIds}`, {
        headers: {
            Authorization: `Basic ${authKey}`,
        },
    });

    const rawJson = await response.text();
    const safeJsonText = rawJson.replace(
        /(?<!["\d])\b\d{16,}\b(?!["])/g,
        (match: any) => `"${match}"`,
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

// Convert Stork update object to encoded bytes using ethers (matches working factory.ts)
function encodeStorkUpdate(update: any): `0x${string}` {
    const updateArray = [[
        [
            update.temporalNumericValue.timestampNs,
            update.temporalNumericValue.quantizedValue
        ],
        update.id,
        update.publisherMerkleRoot,
        update.valueComputeAlgHash,
        update.r,
        update.s,
        update.v
    ]];

    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const encoded = abiCoder.encode(
        ['((uint64,int192),bytes32,bytes32,bytes32,bytes32,bytes32,uint8)[]'],
        [updateArray]
    ) as `0x${string}`;

    return encoded;
}

const ARC_TESTNET = defineChain({
    id: CHAIN_ID,
    name: 'Arc Testnet',
    network: 'arc-testnet',
    nativeCurrency: { decimals: 18, name: 'Ether', symbol: 'ETH' },
    rpcUrls: {
        default: { http: RPC_URL.split(',').map(url => url.trim()) },
        public: { http: RPC_URL.split(',').map(url => url.trim()) },
    },
});

/**
 * Resolve an expired market by fetching closing price from Stork and calling resolve()
 */
export async function resolveMarket(questionID: string) {
    const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({
        account,
        chain: ARC_TESTNET,
        transport: fallback(RPC_URL.split(',').map(url => http(url.trim())))
    });

    const assetId = "BTCUSD";

    console.log(`🔍 Resolving Market: ${questionID}`);

    // 1. Fetch closing price from Stork API using safe method
    console.log("📊 Fetching closing price from Stork...");
    const updates = await getLatestUpdateData(STORK_API_URL, STORK_API_KEY, assetId);
    const update = updates[0];
    const closingPrice = BigInt(update.temporalNumericValue.quantizedValue);
    console.log(`✅ Closing Price: ${closingPrice / (10n ** 18n)} (raw: ${closingPrice})`);

    // 2. Encode Stork update data
    const storkData = encodeStorkUpdate(update);

    // 3. Call resolve on adapter
    console.log("📝 Calling resolve() on adapter...");
    const tx = await wallet.writeContract({
        address: ADAPTER_ADDRESS,
        abi: ADAPTER_ABI,
        functionName: 'resolve',
        args: [questionID as `0x${string}`, storkData as `0x${string}`],
        value: 1n
    });

    console.log(`✅ Resolution Transaction Sent: ${tx}`);
    console.log("⏳ Waiting for confirmation...");
    await new Promise(r => setTimeout(r, 10000));
    console.log("✅ Market Resolved!");
}

/**
 * Resolve all expired markets from the registry
 */
export async function resolveExpiredMarkets() {
    const registryPath = path.join(__dirname, 'registry.json');
    let registry: any[] = [];

    try {
        registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch (e) {
        console.error("❌ No registry found");
        return;
    }

    const now = Math.floor(Date.now() / 1000);

    for (const market of registry) {
        // Extract expiration from slug (format: btc-up-and-down-5min-<timestamp>)
        const expirationMatch = market.slug.match(/(\d+)$/);
        if (!expirationMatch) continue;

        const expiration = parseInt(expirationMatch[1]);

        if (expiration <= now) {
            console.log(`\n⏰ Market expired: ${market.slug}`);
            try {
                await resolveMarket(market.question_id);
            } catch (e: any) {
                console.error(`❌ Resolution failed: ${e.message}`);
            }
        } else {
            console.log(`⏳ Market not yet expired: ${market.slug} (expires in ${expiration - now}s)`);
        }
    }
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
    const questionID = process.argv[2];

    if (questionID) {
        resolveMarket(questionID).catch(console.error);
    } else {
        resolveExpiredMarkets().catch(console.error);
    }
}

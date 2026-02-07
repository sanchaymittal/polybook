
import { createPublicClient, http, fallback, parseAbi, getAddress } from 'viem';
import { defineChain } from 'viem';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const RPC_URL = process.env.RPC_URL || 'https://rpc.testnet.arc.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '5042002');
const ADAPTER_ADDRESS = getAddress(process.env.ADAPTER_ADDRESS!);
const CLOB_API_URL = process.env.CLOB_API_URL!;

const ADAPTER_ABI = parseAbi([
    "event QuestionResolved(bytes32 indexed questionID, int256 price, bool result)"
]);

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

export async function startSyncer() {
    const client = createPublicClient({
        chain: ARC_TESTNET,
        transport: fallback(RPC_URL.split(',').map(url => http(url.trim()))),
        pollingInterval: 10_000, // Poll events every 10s instead of default 4s
    });

    console.log(`📡 Syncer started. Monitoring resolutions on ${ADAPTER_ADDRESS}...`);

    client.watchContractEvent({
        address: ADAPTER_ADDRESS,
        abi: ADAPTER_ABI,
        eventName: 'QuestionResolved',
        onLogs: async (logs) => {
            for (const log of logs) {
                const { questionID } = (log as any).args;
                console.log(`🏁 Resolution Event Detected: ${questionID}`);

                // Find market in CLOB that matches this questionID
                try {
                    const marketsRes = await axios.get(`${CLOB_API_URL}/markets`);
                    const market = marketsRes.data.markets.find((m: any) => m.question_id.toLowerCase() === questionID.toLowerCase());

                    if (market) {
                        const { result } = (log as any).args;
                        console.log(`📤 Updating CLOB status for Market ${market.market_id} to RESOLVED with result: ${result}...`);
                        await axios.post(`${CLOB_API_URL}/admin/update-status`, {
                            market_id: market.market_id,
                            status: "RESOLVED",
                            result: result
                        });
                        console.log("✅ CLOB Sync Successful!");
                    } else {
                        console.warn(`⚠️ No CLOB market found for Question ID ${questionID}`);
                    }
                } catch (e: any) {
                    console.error("❌ Syncer CLOB Update Failed:", e.message);
                }
            }
        }
    });
}

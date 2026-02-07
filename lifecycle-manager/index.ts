
import { createNextMarket } from './factory.js';
import { startSyncer } from './syncer.js';
import { resolveMarket } from './resolver.js';
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config({ path: '../.env' });

const CLOB_API_URL = process.env.CLOB_API_URL || (() => { throw new Error("CLOB_API_URL not set") })();
const CHECK_INTERVAL_MS = 10000; // 10 seconds for more precise 5-min alignment

import { createWalletClient, http, parseAbi, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY!;
const RPC_URL = process.env.RPC_URL || (() => { throw new Error("RPC_URL not set") })();
const CHAIN_ID = parseInt(process.env.CHAIN_ID || (() => { throw new Error("CHAIN_ID not set") })());
const ADAPTER_ADDRESS = getAddress(process.env.ADAPTER_ADDRESS!);
const CTF_ADDRESS = getAddress(process.env.CTF_ADDRESS!);
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

// Redundant local ABI removed in favor of resolver.ts

async function checkAndResolveMarkets(activeMarkets: any[]) {
    const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
    const wallet = createWalletClient({
        account,
        chain: ARC_TESTNET,
        transport: http()
    });

    const now = Math.floor(Date.now() / 1000);

    for (const market of activeMarkets) {
        const match = market.slug.match(/(\d+)$/);
        if (match) {
            const expiry = parseInt(match[1]);
            if (now > expiry) {
                console.log(`⏰ Market ${market.slug} Expired! Triggering Resolution...`);
                let shouldUpdateClob = false;
                try {
                    await resolveMarket(market.question_id);
                    console.log(`✅ On-chain Resolution Successful for ${market.slug}`);
                    shouldUpdateClob = true;
                } catch (e: any) {
                    const msg = e.shortMessage || e.message || "";
                    console.log(`⚠️ Resolution for ${market.slug} failed:`, msg);
                    if (msg.includes("Already resolved") || msg.includes("Reason: Already resolved")) {
                        console.log("⚠️ Market actually already resolved. Marking as RESOLVED in CLOB.");
                        shouldUpdateClob = true;
                    }
                }

                if (shouldUpdateClob) {
                    try {
                        console.log(`📝 Updating CLOB status for Market ${market.market_id} to RESOLVED...`);
                        await axios.post(`${CLOB_API_URL}/admin/update-status`, {
                            market_id: market.market_id,
                            status: "RESOLVED",
                            result: null // We don't have the result easily here yet, but this stops the loop
                        });
                        console.log("✅ CLOB Sync Successful!");
                    } catch (clobErr: any) {
                        console.error("❌ Failed to update CLOB status:", clobErr.message);
                    }
                }
            }
        }
    }
}

async function runLifecycle() {
    console.log("🛠️ Starting PolyBook Lifecycle Manager...");

    // 1. Start the Event Syncer (Background)
    await startSyncer();

    // 2. Main Rotation Loop
    while (true) {
        try {
            console.log("\n🔍 Checking Market Status...");
            const marketsRes = await axios.get(`${CLOB_API_URL}/markets?status=ACTIVE`);
            const activeMarkets = marketsRes.data.markets;

            // Find btc-up-and-down markets
            const now = Math.floor(Date.now() / 1000);
            const rotationMarkets = activeMarkets.filter((m: any) => m.slug.startsWith("btc-up-and-down-5min"));
            const futureMarkets = rotationMarkets.filter((m: any) => {
                const match = m.slug.match(/(\d+)$/);
                return match && parseInt(match[1]) > now;
            });

            console.log(`📊 Found ${rotationMarkets.length} active rotation market(s). (${futureMarkets.length} are in the future)`);

            // Check if we need to create a new one
            if (futureMarkets.length === 0) {
                console.log("❗ No future rotation markets found! Creating next...");
                await createNextMarket();
            }

            // check and resolve ANY active markets that are expired
            await checkAndResolveMarkets(activeMarkets);

        } catch (e: any) {
            console.error("❌ Lifecycle Loop Error:", e.message);
        }

        await new Promise(r => setTimeout(r, CHECK_INTERVAL_MS));
    }
}

runLifecycle().catch(console.error);

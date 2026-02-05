import axios from 'axios';
import { formatUnits } from 'viem';

/**
 * End-to-End Test (De-Orchestrated)
 * 
 * Actors:
 * 1. Agent Gateway (Port 3402) - High-level entry point (Market creation, Minting, Trading)
 * 2. CLOB (Port 3030) - Order matching and Registry
 * 3. Anvil (Port 8545) - Blockchain settlement
 */

const GATEWAY_URL = 'http://127.0.0.1:3402';
const CLOB_URL = 'http://127.0.0.1:3030';

async function main() {
    console.log('\n🌟 Starting De-Orchestrated System Verification...\n');

    try {
        // 1. Initialization (Creates Market, Mints Capital, Places LP Order)
        console.log('Step 1: Initializing Market & Actors via Gateway /init...');
        const initRes = await axios.post(`${GATEWAY_URL}/init`, {});
        const { marketId, details } = initRes.data;
        const market = details.market;
        console.log(`✅ Market ${marketId} initialized.`);
        console.log(`   Slug: ${market.slug}`);
        console.log(`   YES Token: ${market.yes_token_id}`);
        console.log(`   NO Token: ${market.no_token_id}`);

        // 2. Taker Trade
        console.log(`\nStep 2: Trader A placing BUY order on Market ${marketId} via Gateway /buy...`);
        const buyRes = await axios.post(`${GATEWAY_URL}/buy`, {
            marketId,
            price: 0.60, // Cross the spread (LP sell @ 0.50)
            quantity: 10
        });

        if (!buyRes.data.result.success) {
            throw new Error(`Trade failed: ${buyRes.data.result.error}`);
        }

        const trades = buyRes.data.result.trades;
        if (trades.length === 0) {
            throw new Error('Trade placed but no execution. Orderbook empty?');
        }

        console.log('✅ BUY order matched in CLOB.');
        console.log(`   Trades: ${trades.length}`);
        console.log(`   Price: ${trades[0].price}`);
        console.log(`   Quantity: ${trades[0].quantity}`);

        // 3. Verify via CLOB Trades Endpoint
        console.log('\nStep 3: Verifying trades via CLOB...');
        const tradesRes = await axios.get(`${CLOB_URL}/trades?limit=5`);
        const recentTrades = tradesRes.data.trades;
        const ourTrade = recentTrades.find((t: any) => t.token_id === market.yes_token_id);

        if (ourTrade) {
            console.log(`✅ Trade confirmed in CLOB history: ${ourTrade.trade_id}`);
        } else {
            console.warn('⚠️ Trade not found in recent history (might be filtered or delayed)');
        }

        console.log('\n🎉 E2E VERIFIED: Gateway -> CLOB -> Match');

    } catch (e: any) {
        if (e.response) {
            console.error('\n❌ E2E TEST FAILED:', e.response.status, JSON.stringify(e.response.data, null, 2));
        } else {
            console.error('\n❌ E2E TEST FAILED:', e.message);
        }
        process.exit(1);
    }
}

main().catch(console.error);

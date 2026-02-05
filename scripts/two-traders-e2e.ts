import axios from 'axios';
import { Outcome, Side, OrderType } from '../orchestrator/src/types.js';

const GATEWAY_URL = 'http://127.0.0.1:3402';
const ORCHESTRATOR_URL = 'http://127.0.0.1:3031';

const TRADER_A = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // Account #2
const TRADER_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'; // Account #1

// Set global axios defaults
axios.defaults.headers.post['Content-Type'] = 'application/json';
axios.defaults.timeout = 10000; // 10s timeout

async function runE2E() {
    console.log('\n🌟 Starting Two-Trader Full-Lifecycle E2E Test...\n');

    try {
        // 1. Initialize Market & Actors
        console.log('Step 1: Initializing Environment via Gateway /init...');
        const initRes = await axios.post(`${GATEWAY_URL}/init`, {});
        const { marketId } = initRes.data;
        console.log(`✅ Market ${marketId} initialized.`);

        // 2. Setup Trader B
        console.log('\nStep 2: Setting up Trader B via Orchestrator...');
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.mint_capital',
            params: { intent: 'Trader B setup' },
            agentAddress: TRADER_B
        });
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.connect_to_clob',
            params: { marketId },
            agentAddress: TRADER_B
        });
        console.log('✅ Trader B ready.');

        // 3. Trading Phase
        console.log('\nStep 3: Trading phase (waiting 1s for market activation)...');
        await new Promise(r => setTimeout(r, 1000));

        // Trader A Buys YES (10 shares @ 0.55)
        console.log('[Trader A] Placing BUY order (10 @ 0.55) via Gateway /buy...');
        const buyRes = await axios.post(`${GATEWAY_URL}/buy`, {
            price: 0.55,
            quantity: 10
        }, {
            headers: { 'Authorization': 'paid_actor_token' }
        });
        console.log('Trader A Order Result:', JSON.stringify(buyRes.data.result, null, 2));

        // Trader B Sells YES (5 shares @ 0.53) - ensure different price to trigger match if needed
        console.log('\n[Trader B] Placing SELL order (5 @ 0.53) via Skill API...');
        const sellRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.place_order',
            params: {
                marketId,
                side: 1, // SELL
                outcome: 'UP',
                price: 0.53,
                quantity: 5,
                type: 'LIMIT'
            },
            agentAddress: TRADER_B
        });
        console.log('Trader B Order Result:', JSON.stringify(sellRes.data, null, 2));

        // 4. Verify Positions
        console.log('\nStep 4: Verifying positions...');
        const posARes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.get_positions',
            params: { marketId },
            agentAddress: TRADER_A
        });
        const posBRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.get_positions',
            params: { marketId },
            agentAddress: TRADER_B
        });

        console.log(`Trader A YES Balance: ${posARes.data.data?.position?.upQuantity || 0} shares`);
        console.log(`Trader B YES Balance: ${posBRes.data.data?.position?.upQuantity || 0} shares`);

        // 5. Market Resolution
        console.log('\nStep 5: Resolving Market (UP wins)...');
        const resolveRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.resolve_market',
            params: { marketId, outcome: 'UP' },
            agentAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' // LP/Oracle
        });
        console.log('Resolution Result:', JSON.stringify(resolveRes.data, null, 2));

        // 6. Redemption/Claim
        console.log('\nStep 6: Claiming settlements...');
        const claimRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.claim_settlement',
            params: { marketId },
            agentAddress: TRADER_A
        });
        console.log('Trader A Claim Result:', claimRes.data.data?.message || 'Failed');

        console.log('\n🎉 E2E TEST COMPLETED SUCCESSFULLY!');

    } catch (e: any) {
        if (e.response) {
            console.error('\n❌ E2E TEST FAILED (Response Error):', e.response.status, JSON.stringify(e.response.data, null, 2));
        } else {
            console.error('\n❌ E2E TEST FAILED (Network/Other):', e.message);
        }
        process.exit(1);
    }
}

runE2E();

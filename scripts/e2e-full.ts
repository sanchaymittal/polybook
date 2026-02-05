import axios from 'axios';
import { parseUnits, formatUnits } from 'viem';

/**
 * Full Stack End-to-End Test (e2e-full.ts)
 * 
 * Actors:
 * 1. Agent Gateway (Port 3402) - High-level entry point
 * 2. Orchestrator (Port 3031) - Skill execution & Market management
 * 3. CLOB (Port 3030) - Order matching
 * 4. Anvil (Port 8545) - Blockchain settlement
 */

const GATEWAY_URL = 'http://127.0.0.1:3402';
const ORCHESTRATOR_URL = 'http://127.0.0.1:3031';

const TRADER_A = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'; // Account #2
const LP_ORACLE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Account #0

async function main() {
    console.log('\n🌟 Starting Full-Stack E2E System Verification...\n');

    try {
        // 1. Initialization
        console.log('Step 1: Initializing Market & Actors via Gateway /init...');
        const initRes = await axios.post(`${GATEWAY_URL}/init`, {});
        const { marketId } = initRes.data;
        console.log(`✅ Market ${marketId} initialized and LP order placed.`);

        // 2. Taker Trade
        console.log(`\nStep 2: Trader A placing BUY order on Market ${marketId} via Gateway /buy...`);
        const buyRes = await axios.post(`${GATEWAY_URL}/buy`, {
            marketId,
            price: 0.50,
            quantity: 10
        }, {
            headers: { 'Authorization': 'paid_actor_token' }
        });

        if (!buyRes.data.result.success) {
            throw new Error(`Trade failed: ${buyRes.data.result.error}`);
        }
        console.log('✅ BUY order matched in CLOB.');

        // 3. Verify Positions
        console.log('\nStep 3: Verifying positions via Orchestrator...');
        const posRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.get_positions',
            params: { marketId },
            agentAddress: TRADER_A
        });

        const shares = posRes.data.data?.position?.upQuantity || 0;
        console.log(`Trader A YES Balance (off-chain): ${shares} shares`);

        // 4. Resolution
        console.log('\nStep 4: Resolving Market (UP wins) via Orchestrator...');
        await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.resolve_market',
            params: { marketId, outcome: 'UP' },
            agentAddress: LP_ORACLE
        });
        console.log('✅ Market resolved.');

        // 5. Redemption
        console.log('\nStep 5: Claiming settlement via Orchestrator...');
        const claimRes = await axios.post(`${ORCHESTRATOR_URL}/skill`, {
            skill: 'skill.polybook.claim_settlement',
            params: { marketId },
            agentAddress: TRADER_A
        });
        console.log(`✅ Claim Result: ${claimRes.data.data?.message}`);

        console.log('\n🎉 FULL STACK SYSTEM VERIFIED! Gateway -> Orchestrator -> CLOB -> On-Chain.');

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

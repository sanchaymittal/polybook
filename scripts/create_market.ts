import axios from 'axios';
import { parseUnits, formatUnits } from 'viem';

const CLOB_URL = 'http://127.0.0.1:3030';

async function main() {
    console.log('🚀 Creating Market via CLOB Registry...');

    const slug = `BTC_UP_DOWN_${Date.now()}`;
    const question = "Will BTC go up?";

    try {
        console.log(`POST ${CLOB_URL}/admin/create-market`);
        const res = await axios.post(`${CLOB_URL}/admin/create-market`, {
            slug,
            question
        });

        if (res.data.success) {
            console.log('✅ Market Created Successfully!');
            console.log(JSON.stringify(res.data, null, 2));

            const m = res.data.market;
            console.log('\n--- Export Variables ---');
            console.log(`export MARKET_ID=${m.market_id}`);
            console.log(`export SLUG=${m.slug}`);
            console.log(`export YES_TOKEN_ID=${m.yes_token_id}`);
            console.log(`export NO_TOKEN_ID=${m.no_token_id}`);
            console.log(`export CONDITION_ID=${m.condition_id}`);
            console.log(`export QUESTION_ID=${m.question_id}`);
        } else {
            console.error('❌ Failed:', res.data.error);
            process.exit(1);
        }

    } catch (e: any) {
        console.error('❌ Request Failed:', e.response?.data || e.message);
        process.exit(1);
    }
}

main();

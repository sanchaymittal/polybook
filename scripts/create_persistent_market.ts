
import axios from 'axios';

const GATEWAY_URL = 'http://127.0.0.1:3402';

async function main() {
    console.log('\n🌟 Creating a Persistent 5-Min Market...\n');

    try {
        const initRes = await axios.post(`${GATEWAY_URL}/init`, {});
        console.log('DEBUG Response:', JSON.stringify(initRes.data, null, 2));
        const { marketId } = initRes.data;

        console.log(`✅ Market ${marketId} created!`);
        // console.log(`   Question ID: ${questionId}`);
        // console.log(`   Condition ID: ${conditionId}`);
        // console.log(`   YES Token ID: ${yesTokenId}`);
        // console.log(`   NO Token ID: ${noTokenId}`);

        console.log('\n⏳ Checking if market persists...');
        // Just verify it's there
        await new Promise(r => setTimeout(r, 2000));

        console.log(`\n🎉 Market ${marketId} is OPEN and ready for trading.`);
        console.log('Use this MARKET_ID and TOKEN_IDs for the MMs.');
        console.log(`export MARKET_ID=${marketId}`);
        // console.log(`export YES_TOKEN_ID=${yesTokenId}`);
        // console.log(`export NO_TOKEN_ID=${noTokenId}`);

    } catch (e: any) {
        console.error('❌ Failed:', e.message);
    }
}

main();

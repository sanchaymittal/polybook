
import axios from 'axios';

const CLOB_URL = 'http://127.0.0.1:3030';
const MARKET_ID = process.env.MARKET_ID || '1';
const YES_TOKEN_ID = process.env.YES_TOKEN_ID || '41069470821908003820423618366673725376269941223722400569053573765861956451072';

async function monitor() {
    console.log(`\n👀 Monitoring Orderbook for Token: ${YES_TOKEN_ID} (Market ${MARKET_ID})`);

    setInterval(async () => {
        try {
            const res = await axios.get(`${CLOB_URL}/orderbook/${YES_TOKEN_ID}`);
            const book = res.data;

            const bids = book.bids;
            const asks = book.asks;

            // Calculate bests
            const bestBid = bids.length > 0 ? Math.max(...bids.map((o: any) => parseFloat(o.price))) : 0;
            const bestAsk = asks.length > 0 ? Math.min(...asks.map((o: any) => parseFloat(o.price))) : 0;
            const spread = bestAsk > 0 ? bestAsk - bestBid : 0;

            console.clear();
            console.log(`\n--- Orderbook Monitor [${new Date().toLocaleTimeString()}] ---`);
            console.log(`Token ID: ${YES_TOKEN_ID.substring(0, 10)}...`);
            console.log(`Bids: ${bids.length} | Asks: ${asks.length}`);
            console.log(`Best Bid: ${bestBid.toFixed(6)} | Best Ask: ${bestAsk.toFixed(6)}`);
            console.log(`Spread:   ${spread.toFixed(6)}`);
            console.log('------------------------------------------------');

            // Show top 3 levels
            console.log('ASKS (Sell):');
            asks.sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 5).reverse().forEach((o: any) => {
                console.log(`  ${o.price}  x  ${o.quantity}`);
            });
            console.log('--------------------');
            console.log('BIDS (Buy):');
            bids.sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price)).slice(0, 5).forEach((o: any) => {
                console.log(`  ${o.price}  x  ${o.quantity}`);
            });

        } catch (e: any) {
            console.error('Error fetching book:', e.message);
        }
    }, 1000);
}

monitor();

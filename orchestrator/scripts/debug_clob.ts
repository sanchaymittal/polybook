
const CLOB_URL = 'http://127.0.0.1:3030';

async function main() {
    console.log('Fetching trades...');
    const tradesRes = await fetch(`${CLOB_URL}/trades?limit=10`);
    const trades = await tradesRes.json();
    console.log('Trades:', JSON.stringify(trades, null, 2));

    if (trades.trades.length > 0) {
        const trade = trades.trades[0];
        console.log(`\nChecking orders for Trade ${trade.trade_id}...`);

        console.log(`Fetching Taker Order: ${trade.taker_order_hash}`);
        const takerRes = await fetch(`${CLOB_URL}/order/${trade.taker_order_hash}`);
        if (takerRes.ok) {
            console.log('Taker Order Found:', await takerRes.json());
        } else {
            console.log('Taker Order 404!');
        }

        const makerHash = trade.maker_order_hashes[0];
        console.log(`Fetching Maker Order: ${makerHash}`);
        const makerRes = await fetch(`${CLOB_URL}/order/${makerHash}`);
        if (makerRes.ok) {
            console.log('Maker Order Found:', await makerRes.json());
        } else {
            console.log('Maker Order 404!');
        }
    }
}

main().catch(console.error);

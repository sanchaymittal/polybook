import WebSocket from 'ws';
import 'dotenv/config';

const CLOB_WS_URL = process.env.CLOB_WS_URL || 'ws://127.0.0.1:3030/ws/orderbook';

async function main() {
    const tokenId = process.argv[2];
    if (!tokenId) {
        console.error("Usage: npx ts-node scripts/orderbook_ws_client.ts <token_id>");
        process.exit(1);
    }

    const url = `${CLOB_WS_URL}/${tokenId}`;
    console.log(`Connecting to ${url}...`);

    const ws = new WebSocket(url);

    ws.on('open', () => {
        console.log(`Connected to orderbook for token: ${tokenId}`);
    });

    ws.on('message', (data) => {
        try {
            const snapshot = JSON.parse(data.toString());
            console.log(`\n[${new Date().toLocaleTimeString()}] RECEIVED UPDATE:`);
            console.log(`Token: ${snapshot.token_id}`);

            console.log("ASKS:");
            if (snapshot.asks.length === 0) console.log("  (Empty)");
            snapshot.asks.forEach((a: any) => console.log(`  Price: ${a.price}, Qty: ${a.quantity}, Count: ${a.order_count}`));

            console.log("BIDS:");
            if (snapshot.bids.length === 0) console.log("  (Empty)");
            snapshot.bids.forEach((b: any) => console.log(`  Price: ${b.price}, Qty: ${b.quantity}, Count: ${b.order_count}`));
        } catch (e) {
            console.log(`Raw Message: ${data}`);
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    ws.on('close', () => {
        console.log('Connection closed');
        process.exit(0);
    });

    // Keep the process alive
    setInterval(() => { }, 1000);
}

main().catch(console.error);

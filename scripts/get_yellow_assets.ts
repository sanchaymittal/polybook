import { config } from 'dotenv';
import WebSocket from 'ws';
config();

const YELLOW_WS_URL = 'wss://clearnet-sandbox.yellow.com/ws';

async function main() {
    const ws = new WebSocket(YELLOW_WS_URL);
    ws.on('open', () => {
        const msg = {
            req: [Date.now(), 'get_assets', {}, Date.now(), 'NitroRPC/0.4']
        };
        ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data) => {
        const res = JSON.parse(data.toString());
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
    });

    setTimeout(() => {
        console.error("Timeout");
        process.exit(1);
    }, 10000);
}

main();

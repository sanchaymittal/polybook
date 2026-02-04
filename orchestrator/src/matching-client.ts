import axios, { AxiosInstance } from 'axios';
import { Order, OrderType, Outcome, Side, Trade, Position } from './types.js';

export interface OrderResponse {
    success: boolean;
    order_id?: string;
    trades: TradeResult[];
    error?: string;
}

export interface TradeResult {
    trade_id: string;
    buyer: string;
    seller: string;
    token_id: string;
    price: string;
    quantity: string;
    taker_order_hash: string;
    maker_order_hashes: string[];
    maker_fill_amounts: string[];
}

export interface OrderBookState {
    token_id: string;
    bids: PriceLevel[];
    asks: PriceLevel[];
}

export interface PriceLevel {
    price: string;
    quantity: string;
    order_count: number;
}

export class MatchingEngineClient {
    private client: AxiosInstance;
    private baseUrl: string;

    constructor(baseUrl: string = 'http://127.0.0.1:3030') {
        this.baseUrl = baseUrl;
        this.client = axios.create({
            baseURL: baseUrl,
            headers: {
                'Content-Type': 'application/json',
            },
        });
    }

    async health(): Promise<boolean> {
        try {
            const res = await this.client.get('/health');
            return res.status === 200 && res.data.status === 'healthy';
        } catch (e) {
            console.error('Matching engine health check failed:', e);
            return false;
        }
    }

    async placeOrder(order: Order, orderHash: string): Promise<OrderResponse> {
        // Calculate price and quantity for Rust Matching Engine tracking (scaled by 1e6)
        let matchingPrice: string;
        let matchingQuantity: string;

        if (order.side === Side.BUY) {
            // For BUY: Buying takerAmount (Outcome) for makerAmount (Collat)
            // matchingPrice = (makerAmount / takerAmount) * 1e6
            matchingPrice = (Number(order.makerAmount) / Number(order.takerAmount) * 1_000_000).toFixed(0);
            matchingQuantity = order.takerAmount.toString();
        } else {
            // For SELL: Selling makerAmount (Outcome) for takerAmount (Collat)
            // matchingPrice = (takerAmount / makerAmount) * 1e6
            matchingPrice = (Number(order.takerAmount) / Number(order.makerAmount) * 1_000_000).toFixed(0);
            matchingQuantity = order.makerAmount.toString();
        }

        const payload = {
            maker: order.maker,
            token_id: order.tokenId.toString(),
            side: order.side === Side.BUY ? 'BUY' : 'SELL',
            price: matchingPrice,
            quantity: matchingQuantity,
            order_hash: orderHash,
            // Full signed order fields
            salt: order.salt.toString(),
            signer: order.signer,
            taker: order.taker,
            maker_amount: order.makerAmount.toString(),
            taker_amount: order.takerAmount.toString(),
            expiration: order.expiration.toString(),
            nonce: order.nonce.toString(),
            fee_rate_bps: order.feeRateBps.toString(),
            signature_type: order.signatureType,
            signature: order.signature,
        };

        try {
            const res = await this.client.post<OrderResponse>('/order', payload);
            return res.data;
        } catch (e: any) {
            if (e.response && e.response.data) {
                return e.response.data;
            }
            throw e;
        }
    }

    async getOrderBook(tokenId: string): Promise<OrderBookState> {
        const res = await this.client.get<OrderBookState>(`/orderbook/${tokenId}`);
        return res.data;
    }
}

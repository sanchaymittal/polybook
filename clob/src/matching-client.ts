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

    async placeOrder(
        maker: string,
        tokenId: string,
        side: Side,
        price: number,
        quantity: number,
        orderHash: string
    ): Promise<OrderResponse> {
        const payload = {
            maker,
            token_id: tokenId,
            side: side === Side.BUY ? 'BUY' : 'SELL',
            price: price.toString(),
            quantity: quantity.toString(),
            order_hash: orderHash,
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


import axios from 'axios';
import { createWalletClient, http, parseEther, parseUnits, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';

// EIP-712 Types
const TYPES = {
    Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
    ],
} as const;

export class ClobClient {
    private static getEnv() {
        return {
            CLOB_URL: process.env.CLOB_URL || 'http://127.0.0.1:3030',
            EXCHANGE_ADDR: (process.env.EXCHANGE_ADDR || '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') as `0x${string}`
        };
    }

    private static getDomain() {
        const { EXCHANGE_ADDR } = this.getEnv();
        return {
            name: "Polymarket CTF Exchange",
            version: "1",
            chainId: 31337,
            verifyingContract: EXCHANGE_ADDR,
        } as const;
    }

    static async createMarket(slug: string, question: string) {
        const { CLOB_URL } = this.getEnv();
        console.log(`[CLOB] Creating market: ${slug}`);
        const res = await axios.post(`${CLOB_URL}/admin/create-market`, {
            slug,
            question
        });
        if (!res.data.success) throw new Error(res.data.error || 'Create failed');
        return res.data;
    }

    static async mintCapital(address: string, amount: string = "1000000000000") {
        const { CLOB_URL } = this.getEnv();
        console.log(`[CLOB] Minting capital for ${address}`);
        const res = await axios.post(`${CLOB_URL}/mint-dummy`, {
            address,
            amount
        });
        return res.data;
    }

    static async placeOrder(
        privateKey: `0x${string}`,
        market: any,
        side: 'BUY' | 'SELL',
        price: number,
        quantity: number
    ) {
        const { CLOB_URL } = this.getEnv();
        const account = privateKeyToAccount(privateKey);
        const maker = account.address;

        const priceBn = parseUnits(price.toString(), 6);
        const qtyBn = parseUnits(quantity.toString(), 6);

        // Determine Maker/Taker amounts based on side
        // BUY: Maker (USDC) -> Taker (Token) :: Price * Qty -> Qty
        // SELL: Maker (Token) -> Taker (USDC) :: Qty -> Price * Qty
        let makerAmount = 0n;
        let takerAmount = 0n;
        let tokenId = "0";

        if (side === 'BUY') {
            makerAmount = (qtyBn * priceBn) / 1000000n; // USDC
            takerAmount = qtyBn; // Tokens
            tokenId = market.yes_token_id;
        } else {
            makerAmount = qtyBn; // Tokens
            takerAmount = (qtyBn * priceBn) / 1000000n; // USDC
            tokenId = market.yes_token_id;
        }

        const salt = BigInt(Math.floor(Math.random() * 1000000));

        const order = {
            salt,
            maker,
            signer: maker,
            taker: '0x0000000000000000000000000000000000000000' as `0x${string}`,
            tokenId: BigInt(tokenId),
            makerAmount,
            takerAmount,
            expiration: 0n,
            nonce: 0n,
            feeRateBps: 0n,
            side: side === 'BUY' ? 0 : 1,
            signatureType: 0, // EOA
        };

        const DOMAIN = this.getDomain();

        const signature = await account.signTypedData({
            domain: DOMAIN,
            types: TYPES,
            primaryType: 'Order',
            message: order,
        });

        // Construct API Payload
        const payload = {
            maker,
            token_id: tokenId,
            side,
            price: priceBn.toString(),
            quantity: qtyBn.toString(),
            order_hash: "0x0",
            salt: order.salt.toString(),
            signer: order.signer,
            taker: order.taker,
            maker_amount: order.makerAmount.toString(),
            taker_amount: order.takerAmount.toString(),
            expiration: order.expiration.toString(),
            nonce: order.nonce.toString(),
            fee_rate_bps: order.feeRateBps.toString(),
            signature_type: order.signatureType,
            signature,
        };

        const { hashTypedData } = await import('viem');
        const orderHash = await hashTypedData({
            domain: DOMAIN,
            types: TYPES,
            primaryType: 'Order',
            message: order
        });

        (payload as any).order_hash = orderHash;

        console.log(`[CLOB] Placing Order for ${maker}: ${side} ${quantity} @ ${price}`);
        const res = await axios.post(`${CLOB_URL}/order`, payload);
        return res.data;
    }
}

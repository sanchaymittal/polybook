/**
 * PolyBook v1 - Phase 6: Trade Executor
 *
 * Executes matched trades on-chain via CTFExchange.matchOrders()
 */
import {
    createPublicClient,
    createWalletClient,
    http,
    parseAbi,
    type Address,
    type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { CONTRACTS, RPC_URL } from './contracts.js';
import { Order as SignedOrder, Side, SignatureType } from './signing.js';
import { Trade } from './types.js';
import { MARKET_STATE } from './market-state.js';

// CTFExchange ABI (trading functions)
const EXCHANGE_ABI = parseAbi([
    'function matchOrders((uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature) takerOrder, (uint256 salt, address maker, address signer, address taker, uint256 tokenId, uint256 makerAmount, uint256 takerAmount, uint256 expiration, uint256 nonce, uint256 feeRateBps, uint8 side, uint8 signatureType, bytes signature)[] makerOrders, uint256 takerFillAmount, uint256[] makerFillAmounts) external',
    'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
    'event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled)',
]);

// ERC20 ABI for approvals
const ERC20_ABI = parseAbi([
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function allowance(address owner, address spender) external view returns (uint256)',
]);

// ERC1155 ABI for approvals
const ERC1155_ABI = parseAbi([
    'function setApprovalForAll(address operator, bool approved) external',
    'function isApprovedForAll(address account, address operator) external view returns (bool)',
]);

/**
 * Order struct for on-chain execution
 */
interface OnChainOrder {
    salt: bigint;
    maker: Address;
    signer: Address;
    taker: Address;
    tokenId: bigint;
    makerAmount: bigint;
    takerAmount: bigint;
    expiration: bigint;
    nonce: bigint;
    feeRateBps: bigint;
    side: number;
    signatureType: number;
    signature: Hex;
}

/**
 * Trade Executor - executes matched trades on-chain
 */
export class TradeExecutor {
    private publicClient;
    private operatorClient;
    private operatorAddress: Address;

    constructor(operatorPrivateKey: Hex) {
        const account = privateKeyToAccount(operatorPrivateKey);
        this.operatorAddress = account.address;

        this.publicClient = createPublicClient({
            chain: anvil,
            transport: http(RPC_URL),
        });

        this.operatorClient = createWalletClient({
            account,
            chain: anvil,
            transport: http(RPC_URL),
        });
    }

    /**
     * Ensure USDC approval for buyer
     */
    async ensureUSDCApproval(
        owner: Address,
        ownerPrivateKey: Hex,
        amount: bigint
    ): Promise<void> {
        const allowance = await this.publicClient.readContract({
            address: CONTRACTS.USDC,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [owner, CONTRACTS.EXCHANGE],
        });

        if (allowance < amount) {
            const ownerAccount = privateKeyToAccount(ownerPrivateKey);
            const ownerClient = createWalletClient({
                account: ownerAccount,
                chain: anvil,
                transport: http(RPC_URL),
            });

            const hash = await ownerClient.writeContract({
                address: CONTRACTS.USDC,
                abi: ERC20_ABI,
                functionName: 'approve',
                args: [CONTRACTS.EXCHANGE, amount * 10n], // Approve extra
            });
            await this.publicClient.waitForTransactionReceipt({ hash });
            console.log(`[Executor] USDC approval set for ${owner}`);
        }
    }

    /**
     * Ensure ERC1155 approval for seller
     */
    async ensureERC1155Approval(
        owner: Address,
        ownerPrivateKey: Hex
    ): Promise<void> {
        const isApproved = await this.publicClient.readContract({
            address: CONTRACTS.CTF,
            abi: ERC1155_ABI,
            functionName: 'isApprovedForAll',
            args: [owner, CONTRACTS.EXCHANGE],
        });

        if (!isApproved) {
            const ownerAccount = privateKeyToAccount(ownerPrivateKey);
            const ownerClient = createWalletClient({
                account: ownerAccount,
                chain: anvil,
                transport: http(RPC_URL),
            });

            const hash = await ownerClient.writeContract({
                address: CONTRACTS.CTF,
                abi: ERC1155_ABI,
                functionName: 'setApprovalForAll',
                args: [CONTRACTS.EXCHANGE, true],
            });
            await this.publicClient.waitForTransactionReceipt({ hash });
            console.log(`[Executor] ERC1155 approval set for ${owner}`);
        }
    }

    /**
     * Convert SignedOrder to OnChainOrder format
     */
    private toOnChainOrder(order: SignedOrder): OnChainOrder {
        return {
            salt: order.salt,
            maker: order.maker,
            signer: order.signer,
            taker: order.taker,
            tokenId: order.tokenId,
            makerAmount: order.makerAmount,
            takerAmount: order.takerAmount,
            expiration: order.expiration,
            nonce: order.nonce,
            feeRateBps: order.feeRateBps,
            side: order.side,
            signatureType: order.signatureType,
            signature: order.signature,
        };
    }

    /**
     * Execute a matched trade on-chain
     *
     * @param takerOrder - The taker's signed order
     * @param makerOrders - Array of maker signed orders
     * @param takerFillAmount - Amount to fill from taker (in maker terms)
     * @param makerFillAmounts - Amounts to fill from each maker
     */
    async executeMatch(
        takerOrder: SignedOrder,
        makerOrders: SignedOrder[],
        takerFillAmount: bigint,
        makerFillAmounts: bigint[]
    ): Promise<Hex> {
        console.log('\n[Executor] Executing on-chain match...');
        console.log(`  Taker: ${takerOrder.maker}`);
        console.log(`  Makers: ${makerOrders.map((o) => o.maker).join(', ')}`);
        console.log(`  Taker fill: ${takerFillAmount}`);
        console.log(`  Maker fills: ${makerFillAmounts.join(', ')}`);

        // Convert to on-chain format
        const onChainTaker = this.toOnChainOrder(takerOrder);
        const onChainMakers = makerOrders.map((o) => this.toOnChainOrder(o));

        // Execute matchOrders
        const hash = await this.operatorClient.writeContract({
            address: CONTRACTS.EXCHANGE,
            abi: EXCHANGE_ABI,
            functionName: 'matchOrders',
            args: [onChainTaker, onChainMakers, takerFillAmount, makerFillAmounts],
        });

        console.log(`  Tx hash: ${hash}`);

        // Wait for confirmation
        const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
        console.log(`  Status: ${receipt.status === 'success' ? '✓ Success' : '✗ Failed'}`);

        // Parse events
        if (receipt.status === 'success') {
            console.log(`  Block: ${receipt.blockNumber}`);
            console.log(`  Gas used: ${receipt.gasUsed}`);
        }

        return hash;
    }

    /**
     * Get the operator address
     */
    getOperatorAddress(): Address {
        return this.operatorAddress;
    }
}

/**
 * Create a trade executor instance
 */
export function createExecutor(operatorPrivateKey: Hex): TradeExecutor {
    return new TradeExecutor(operatorPrivateKey);
}

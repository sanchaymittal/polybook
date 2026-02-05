//! # MM-Gateway EIP-712 Order Signing
//!
//! Implements EIP-712 signing for Polymarket CTF Exchange orders.
//! Matches the exact signing logic used by the CLOB for verification.

use alloy::primitives::{keccak256, Address, B256, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use alloy::sol;
use alloy_sol_types::{eip712_domain, SolStruct};

use crate::config::MMConfig;
use crate::types::{OrderRequest, Side, SignatureType};

// Define the Order struct for EIP-712 hashing
// Must match the TypeScript and Rust CLOB implementations exactly
sol! {
    #[derive(Debug)]
    struct Order {
        uint256 salt;
        address maker;
        address signer;
        address taker;
        uint256 tokenId;
        uint256 makerAmount;
        uint256 takerAmount;
        uint256 expiration;
        uint256 nonce;
        uint256 feeRateBps;
        uint8 side;
        uint8 signatureType;
    }
}

/// Order signer for EIP-712 compliant signatures
pub struct OrderSigner {
    signer: PrivateKeySigner,
    chain_id: u64,
    exchange_address: Address,
}

impl OrderSigner {
    /// Create a new order signer from configuration
    pub fn new(config: &MMConfig) -> Result<Self, String> {
        let signer: PrivateKeySigner = config
            .agent_private_key
            .parse()
            .map_err(|e| format!("Invalid private key: {}", e))?;

        let exchange_address: Address = config
            .exchange_address
            .parse()
            .map_err(|e| format!("Invalid exchange address: {}", e))?;

        Ok(Self {
            signer,
            chain_id: config.chain_id,
            exchange_address,
        })
    }

    /// Get the signer's address
    pub fn address(&self) -> Address {
        self.signer.address()
    }

    /// Get the EIP-712 domain separator
    fn domain_separator(&self) -> B256 {
        let domain = eip712_domain! {
            name: "Polymarket CTF Exchange",
            version: "1",
            chain_id: self.chain_id,
            verifying_contract: self.exchange_address,
        };
        domain.hash_struct()
    }

    /// Create and sign an order
    pub async fn sign_order(
        &self,
        token_id: &str,
        side: Side,
        price: u64,    // Scaled 1e6
        quantity: u64, // Scaled 1e6
    ) -> Result<OrderRequest, String> {
        // Generate random salt
        let salt = U256::from(rand::random::<u128>());

        let maker = self.signer.address();
        let taker = Address::ZERO;

        // Parse token ID
        let token_id_u256 = U256::from_str_radix(token_id, 10)
            .map_err(|e| format!("Invalid token ID: {}", e))?;

        // Calculate maker/taker amounts based on side
        // Price is scaled 1e6, quantity is scaled 1e6
        // For BUY: makerAmount = USDC to pay, takerAmount = tokens to receive
        // For SELL: makerAmount = tokens to sell, takerAmount = USDC to receive
        let (maker_amount, taker_amount) = match side {
            Side::BUY => {
                // Buying: pay (price * quantity) USDC, receive quantity tokens
                let usdc_amount = (price as u128 * quantity as u128) / 1_000_000;
                (U256::from(usdc_amount), U256::from(quantity))
            }
            Side::SELL => {
                // Selling: pay quantity tokens, receive (price * quantity) USDC
                let usdc_amount = (price as u128 * quantity as u128) / 1_000_000;
                (U256::from(quantity), U256::from(usdc_amount))
            }
        };

        // Expiration: 1 hour from now
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let expiration = U256::from(now + 3600);

        // Build the order struct for hashing
        let order = Order {
            salt,
            maker,
            signer: maker,
            taker,
            tokenId: token_id_u256,
            makerAmount: maker_amount,
            takerAmount: taker_amount,
            expiration,
            nonce: U256::ZERO,
            feeRateBps: U256::ZERO,
            side: side as u8,
            signatureType: SignatureType::EOA as u8,
        };

        // Compute struct hash
        let struct_hash = order.eip712_hash_struct();

        // Compute typed data hash
        let domain_separator = self.domain_separator();
        let mut encoded = Vec::new();
        encoded.extend_from_slice(b"\x19\x01");
        encoded.extend_from_slice(domain_separator.as_slice());
        encoded.extend_from_slice(struct_hash.as_slice());
        let typed_data_hash = B256::from(keccak256(&encoded));

        // Sign the hash
        let signature = self
            .signer
            .sign_hash(&typed_data_hash)
            .await
            .map_err(|e| format!("Signing failed: {}", e))?;

        // Format signature as hex
        let sig_bytes = signature.as_bytes();
        let sig_hex = format!("0x{}", hex::encode(sig_bytes));

        // Compute order hash for tracking
        let order_hash = format!("0x{}", hex::encode(typed_data_hash.as_slice()));

        Ok(OrderRequest {
            maker: format!("{:?}", maker),
            token_id: token_id.to_string(),
            side: side.as_str().to_string(),
            price: price.to_string(),
            quantity: quantity.to_string(),
            order_hash,
            salt: salt.to_string(),
            signer: format!("{:?}", maker),
            taker: format!("{:?}", taker),
            maker_amount: maker_amount.to_string(),
            taker_amount: taker_amount.to_string(),
            expiration: expiration.to_string(),
            nonce: "0".to_string(),
            fee_rate_bps: "0".to_string(),
            signature_type: SignatureType::EOA as u8,
            signature: sig_hex,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sign_order() {
        let config = MMConfig::from_env().unwrap();
        let signer = OrderSigner::new(&config).unwrap();

        let order = signer
            .sign_order(
                &config.yes_token_id,
                Side::BUY,
                500_000, // 0.50 price
                10_000_000, // 10 tokens
            )
            .await
            .unwrap();

        assert!(order.signature.starts_with("0x"));
        assert_eq!(order.signature.len(), 132); // 65 bytes = 130 hex + 0x
    }
}

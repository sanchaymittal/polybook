//! # MM-Gateway Configuration
//!
//! Configuration loading from environment variables or .env file.

use std::env;

/// Market Maker Configuration
#[derive(Debug, Clone)]
pub struct MMConfig {
    // Agent identity
    pub agent_private_key: String,
    pub agent_address: String,

    // Market identifiers
    pub market_id: u64,
    pub yes_token_id: String,
    pub no_token_id: String,

    // Contract addresses
    pub usdc_address: String,
    pub ctf_address: String,
    pub exchange_address: String,

    // Service URLs
    pub clob_url: String,
    pub rpc_url: String,
    pub chain_id: u64,

    // Strategy parameters
    pub spread_bps: u64,        // Spread in basis points (e.g., 200 = 2%)
    pub order_size: u64,        // Order size in tokens (scaled 1e6)
    pub max_inventory: u64,     // Max position per side (scaled 1e6)
    pub quote_interval_ms: u64, // Quote refresh interval
    pub fair_price: f64,        // Initial fair price (0.0 - 1.0)
}

impl MMConfig {
    /// Load configuration from environment variables
    pub fn from_env() -> Result<Self, String> {
        dotenv::dotenv().ok();

        Ok(Self {
            // Agent identity (required)
            agent_private_key: env::var("MM_PRIVATE_KEY")
                .or_else(|_| env::var("DEPLOYER_PRIVATE_KEY"))
                .unwrap_or_else(|_| {
                    // Anvil account #4 as default MM
                    "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a".to_string()
                }),
            agent_address: env::var("MM_ADDRESS").unwrap_or_else(|_| {
                "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65".to_string() // Anvil #4
            }),

            // Market identifiers
            market_id: env::var("MARKET_ID")
                .unwrap_or_else(|_| "1".to_string())
                .parse()
                .unwrap_or(1),
            yes_token_id: env::var("YES_TOKEN_ID").unwrap_or_else(|_| {
                "41069470821908003820423618366673725376269941223722400569053573765861956451072"
                    .to_string()
            }),
            no_token_id: env::var("NO_TOKEN_ID").unwrap_or_else(|_| {
                "56313735484794408456925599043858882156820008852269395108189660012550632661236"
                    .to_string()
            }),

            // Contract addresses (from local deployment)
            usdc_address: env::var("USDC_ADDR")
                .unwrap_or_else(|_| "0x5fbdb2315678afecb367f032d93f642f64180aa3".to_string()),
            ctf_address: env::var("CTF_ADDR")
                .unwrap_or_else(|_| "0xe7f1725e7734ce288f8367e1bb143e90bb3f0512".to_string()),
            exchange_address: env::var("EXCHANGE_ADDR")
                .unwrap_or_else(|_| "0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0".to_string()),

            // Service URLs
            clob_url: env::var("CLOB_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3030".to_string()),
            rpc_url: env::var("RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8545".to_string()),
            chain_id: env::var("CHAIN_ID")
                .unwrap_or_else(|_| "31337".to_string())
                .parse()
                .unwrap_or(31337),

            // Strategy parameters
            spread_bps: env::var("SPREAD_BPS")
                .unwrap_or_else(|_| "200".to_string()) // 2% default
                .parse()
                .unwrap_or(200),
            order_size: env::var("ORDER_SIZE")
                .unwrap_or_else(|_| "50000000".to_string()) // 50 tokens (1e6 scaled)
                .parse()
                .unwrap_or(50_000_000),
            max_inventory: env::var("MAX_INVENTORY")
                .unwrap_or_else(|_| "500000000".to_string()) // 500 tokens
                .parse()
                .unwrap_or(500_000_000),
            quote_interval_ms: env::var("QUOTE_INTERVAL_MS")
                .unwrap_or_else(|_| "5000".to_string())
                .parse()
                .unwrap_or(5000),
            fair_price: env::var("FAIR_PRICE")
                .unwrap_or_else(|_| "0.5".to_string())
                .parse()
                .unwrap_or(0.5),
        })
    }

    /// Validate configuration
    pub fn validate(&self) -> Result<(), String> {
        if self.agent_private_key.len() < 64 {
            return Err("Invalid private key length".to_string());
        }
        if self.spread_bps == 0 || self.spread_bps > 10000 {
            return Err("Spread must be between 1 and 10000 bps".to_string());
        }
        if self.fair_price <= 0.0 || self.fair_price >= 1.0 {
            return Err("Fair price must be between 0 and 1".to_string());
        }
        if self.order_size == 0 {
            return Err("Order size must be positive".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = MMConfig::from_env().expect("Should load defaults");
        assert_eq!(config.chain_id, 31337);
        assert_eq!(config.spread_bps, 200);
        assert!((config.fair_price - 0.5).abs() < 0.001);
    }
}

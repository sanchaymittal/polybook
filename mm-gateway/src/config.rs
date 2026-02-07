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

    // Market identifiers (Optional - will discover if missing)
    pub market_id: Option<String>,
    pub yes_token_id: Option<String>,
    pub no_token_id: Option<String>,

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
        // Try local .env first, then parent directory
        if dotenv::dotenv().is_err() {
            let mut path = env::current_dir().unwrap();
            path.pop();
            path.push(".env");
            dotenv::from_path(path).ok();
        }

        Ok(Self {
            // Agent identity (required)
            agent_private_key: env::var("MM_PRIVATE_KEY")
                .or_else(|_| env::var("DEPLOYER_PRIVATE_KEY"))
                .expect("MM_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set"),
            agent_address: env::var("MM_ADDRESS").expect("MM_ADDRESS not set"),

            // Market identifiers
            market_id: env::var("MARKET_ID").ok(),
            yes_token_id: env::var("YES_TOKEN_ID").ok(),
            no_token_id: env::var("NO_TOKEN_ID").ok(),

            // Contract addresses (from environment)
            usdc_address: env::var("USDC_ADDRESS").expect("USDC_ADDRESS not set"),
            ctf_address: env::var("CTF_ADDRESS").expect("CTF_ADDRESS not set"),
            exchange_address: env::var("EXCHANGE_ADDRESS").expect("EXCHANGE_ADDRESS not set"),

            // Service URLs
            clob_url: env::var("CLOB_API_URL").expect("CLOB_API_URL not set"),
            rpc_url: env::var("RPC_URL").expect("RPC_URL not set"),
            chain_id: env::var("CHAIN_ID")
                .expect("CHAIN_ID not set")
                .parse()
                .expect("CHAIN_ID must be a number"),

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

//! # MM-Gateway Inventory Tracking
//!
//! Queries on-chain balances for USDC and ERC-1155 conditional tokens.
//! Tracks reserved amounts for open orders.

use alloy::primitives::{Address, U256};
use alloy::providers::ProviderBuilder;
use alloy::sol;

use crate::config::MMConfig;
use crate::types::Inventory;

// ERC-20 interface for USDC
sol! {
    #[sol(rpc)]
    contract IERC20 {
        function balanceOf(address account) external view returns (uint256);
    }
}

// ERC-1155 interface for Conditional Tokens
sol! {
    #[sol(rpc)]
    contract IERC1155 {
        function balanceOf(address account, uint256 id) external view returns (uint256);
    }
}

use std::collections::HashMap;

/// Inventory manager for on-chain balance queries
pub struct InventoryManager {
    rpc_url: String,
    agent_address: Address,
    usdc_address: Address,
    ctf_address: Address,

    // Local tracking of reserved amounts
    usdc_reserved: u64,
    token_reserved: HashMap<String, u64>,
}

impl InventoryManager {
    /// Create a new inventory manager from configuration
    pub fn new(config: &MMConfig) -> Result<Self, String> {
        let agent_address: Address = config
            .agent_address
            .parse()
            .map_err(|e| format!("Invalid agent address: {}", e))?;

        let usdc_address: Address = config
            .usdc_address
            .parse()
            .map_err(|e| format!("Invalid USDC address: {}", e))?;

        let ctf_address: Address = config
            .ctf_address
            .parse()
            .map_err(|e| format!("Invalid CTF address: {}", e))?;

        Ok(Self {
            rpc_url: config.rpc_url.clone(),
            agent_address,
            usdc_address,
            ctf_address,
            usdc_reserved: 0,
            token_reserved: HashMap::new(),
        })
    }

    /// Sync inventory from on-chain balances for a list of tokens
    pub async fn sync(&self, token_ids: &[String]) -> Result<Inventory, String> {
        let provider = ProviderBuilder::new()
            .on_http(self.rpc_url.parse().map_err(|e| format!("Invalid RPC URL: {}", e))?);

        // Query USDC balance
        let usdc = IERC20::new(self.usdc_address, provider.clone());
        let usdc_balance: U256 = usdc
            .balanceOf(self.agent_address)
            .call()
            .await
            .map_err(|e| format!("USDC balance query failed: {}", e))?
            ._0;

        let usdc_u64 = usdc_balance.try_into().unwrap_or(u64::MAX);

        // Query ERC-1155 token balances
        let ctf = IERC1155::new(self.ctf_address, provider.clone());
        let mut token_balances = HashMap::new();

        for tid_str in token_ids {
            let tid_u256 = U256::from_str_radix(tid_str, 10).map_err(|e| format!("Invalid token ID {}: {}", tid_str, e))?;
            let balance: U256 = ctf
                .balanceOf(self.agent_address, tid_u256)
                .call()
                .await
                .map_err(|e| format!("Balance query failed for {}: {}", tid_str, e))?
                ._0;

            token_balances.insert(tid_str.clone(), balance.try_into().unwrap_or(u64::MAX));
        }

        Ok(Inventory {
            usdc_balance: usdc_u64,
            token_balances,
            usdc_reserved: self.usdc_reserved,
            token_reserved: self.token_reserved.clone(),
        })
    }

    /// Reserve USDC for a buy order
    pub fn reserve_usdc(&mut self, amount: u64) {
        self.usdc_reserved = self.usdc_reserved.saturating_add(amount);
    }

    /// Release USDC reservation
    pub fn release_usdc(&mut self, amount: u64) {
        self.usdc_reserved = self.usdc_reserved.saturating_sub(amount);
    }

    /// Reserve tokens for a sell order
    pub fn reserve_token(&mut self, token_id: &str, amount: u64) {
        let entry = self.token_reserved.entry(token_id.to_string()).or_insert(0);
        *entry = entry.saturating_add(amount);
    }

    /// Release token reservation
    pub fn release_token(&mut self, token_id: &str, amount: u64) {
        if let Some(reserved) = self.token_reserved.get_mut(token_id) {
            *reserved = reserved.saturating_sub(amount);
        }
    }

    /// Clear all reservations (e.g., on restart)
    pub fn clear_reservations(&mut self) {
        self.usdc_reserved = 0;
        self.token_reserved.clear();
    }
}

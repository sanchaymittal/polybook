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

/// Inventory manager for on-chain balance queries
pub struct InventoryManager {
    rpc_url: String,
    agent_address: Address,
    usdc_address: Address,
    ctf_address: Address,
    yes_token_id: U256,
    no_token_id: U256,

    // Local tracking of reserved amounts
    usdc_reserved: u64,
    yes_reserved: u64,
    no_reserved: u64,
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

        let yes_token_id = U256::from_str_radix(&config.yes_token_id, 10)
            .map_err(|e| format!("Invalid YES token ID: {}", e))?;

        let no_token_id = U256::from_str_radix(&config.no_token_id, 10)
            .map_err(|e| format!("Invalid NO token ID: {}", e))?;

        Ok(Self {
            rpc_url: config.rpc_url.clone(),
            agent_address,
            usdc_address,
            ctf_address,
            yes_token_id,
            no_token_id,
            usdc_reserved: 0,
            yes_reserved: 0,
            no_reserved: 0,
        })
    }

    /// Sync inventory from on-chain balances
    pub async fn sync(&self) -> Result<Inventory, String> {
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

        // Query YES token balance
        let ctf = IERC1155::new(self.ctf_address, provider.clone());
        let yes_balance: U256 = ctf
            .balanceOf(self.agent_address, self.yes_token_id)
            .call()
            .await
            .map_err(|e| format!("YES balance query failed: {}", e))?
            ._0;

        // Query NO token balance
        let no_balance: U256 = ctf
            .balanceOf(self.agent_address, self.no_token_id)
            .call()
            .await
            .map_err(|e| format!("NO balance query failed: {}", e))?
            ._0;

        // Convert to u64 (safe for typical token amounts)
        let usdc_u64 = usdc_balance
            .try_into()
            .unwrap_or(u64::MAX);
        let yes_u64 = yes_balance
            .try_into()
            .unwrap_or(u64::MAX);
        let no_u64 = no_balance
            .try_into()
            .unwrap_or(u64::MAX);

        Ok(Inventory {
            usdc_balance: usdc_u64,
            yes_balance: yes_u64,
            no_balance: no_u64,
            usdc_reserved: self.usdc_reserved,
            yes_reserved: self.yes_reserved,
            no_reserved: self.no_reserved,
        })
    }

    /// Reserve USDC for a buy order
    pub fn reserve_usdc(&mut self, amount: u64) {
        self.usdc_reserved = self.usdc_reserved.saturating_add(amount);
    }

    /// Release USDC reservation (order cancelled or filled)
    pub fn release_usdc(&mut self, amount: u64) {
        self.usdc_reserved = self.usdc_reserved.saturating_sub(amount);
    }

    /// Reserve YES tokens for a sell order
    pub fn reserve_yes(&mut self, amount: u64) {
        self.yes_reserved = self.yes_reserved.saturating_add(amount);
    }

    /// Release YES token reservation
    pub fn release_yes(&mut self, amount: u64) {
        self.yes_reserved = self.yes_reserved.saturating_sub(amount);
    }

    /// Reserve NO tokens for a sell order
    pub fn reserve_no(&mut self, amount: u64) {
        self.no_reserved = self.no_reserved.saturating_add(amount);
    }

    /// Release NO token reservation
    pub fn release_no(&mut self, amount: u64) {
        self.no_reserved = self.no_reserved.saturating_sub(amount);
    }

    /// Clear all reservations (e.g., on restart)
    pub fn clear_reservations(&mut self) {
        self.usdc_reserved = 0;
        self.yes_reserved = 0;
        self.no_reserved = 0;
    }
}

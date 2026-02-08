//! # MM-Gateway Inventory Tracking
//!
//! Queries on-chain balances for USDC and ERC-1155 conditional tokens.
//! Tracks reserved amounts for open orders.
//! Handles market seeding (splitting positions).

use alloy::network::EthereumWallet;
use alloy::primitives::{Address, FixedBytes, U256};
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use std::collections::HashMap;
use std::str::FromStr;

use tracing::{info, warn};
use rand::seq::SliceRandom; // For random RPC selection

use crate::config::MMConfig;
use crate::types::Inventory;

// ERC-20 interface for USDC
sol! {
    #[sol(rpc)]
    contract IERC20 {
        function balanceOf(address account) external view returns (uint256);
        function approve(address spender, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
    }
}

// ERC-1155 interface for Conditional Tokens
sol! {
    #[sol(rpc)]
    contract IERC1155 {
        function balanceOf(address account, uint256 id) external view returns (uint256);
        function setApprovalForAll(address operator, bool approved) external;
        function isApprovedForAll(address account, address operator) external view returns (bool approved);
    }
}

// CTF interface for splitting
sol! {
    #[sol(rpc)]
    contract ICTF {
        function splitPosition(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata partition,
            uint256 amount
        ) external;

        function redeemPositions(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata indexSets
        ) external;

        function payoutNumerators(
            bytes32 conditionId,
            uint256 index
        ) external view returns (uint256);
    }
    }


// CTF Yellow Valve interface
sol! {
    #[sol(rpc)]
    contract ICTFYellowValve {
        function onboardAndSplit(
            address collateralToken,
            bytes32 conditionId,
            uint256 collateralAmount,
            uint256[] calldata partition
        ) external;
    }
}

/// Inventory manager for on-chain balance queries and seeding
pub struct InventoryManager {
    rpc_urls: Vec<String>,
    signer: PrivateKeySigner,
    agent_address: Address,
    usdc_address: Address,           // Standard USDC for CLOB
    yellow_usdc_address: Address,    // Yellow Network USDC (if different)
    ctf_address: Address,
    exchange_address: Address,

    // Local tracking of reserved amounts
    usdc_reserved: u64,
    token_reserved: HashMap<String, u64>,
    pending_buy_tokens: HashMap<String, u64>,

    // Yellow
    use_yellow: bool,
    ctf_yellow_valve_address: Address,
}

impl InventoryManager {
    /// Create a new inventory manager from configuration
    pub fn new(config: &MMConfig) -> Result<Self, String> {
        let signer: PrivateKeySigner = config
            .agent_private_key
            .parse()
            .map_err(|e| format!("Invalid private key: {}", e))?;
        
        // Ensure signer address matches config address (sanity check)
        let derived_address = signer.address();
        let config_address: Address = config.agent_address.parse().unwrap();
        if derived_address != config_address {
             warn!("Derived address {} does not match config address {}", derived_address, config_address);
        }

        let usdc_address: Address = config
            .usdc_address
            .parse()
            .map_err(|e| format!("Invalid USDC address: {}", e))?;

        let ctf_address: Address = config
            .ctf_address
            .parse()
            .map_err(|e| format!("Invalid CTF address: {}", e))?;

        let exchange_address: Address = config
            .exchange_address
            .parse()
            .map_err(|e| format!("Invalid Exchange address: {}", e))?;

        let yellow_usdc_address: Address = if config.use_yellow {
            config.yellow_usdc_address.parse()
                .map_err(|e| format!("Invalid Yellow USDC address: {}", e))?
        } else {
            usdc_address  // Use same as standard if Yellow not enabled
        };

        Ok(Self {
            rpc_urls: config.rpc_urls.clone(),
            signer,
            agent_address: config_address,
            usdc_address,
            yellow_usdc_address,
            ctf_address,
            exchange_address,
            usdc_reserved: 0,
            token_reserved: HashMap::new(),
            pending_buy_tokens: HashMap::new(),
            use_yellow: config.use_yellow,
            ctf_yellow_valve_address: config.ctf_yellow_valve_address.parse().unwrap_or(Address::ZERO),
        })
    }

    /// Sync inventory from on-chain balances for a list of tokens
    pub async fn sync(&self, token_ids: &[String]) -> Result<Inventory, String> {
        let rpc_url = self.rpc_urls.choose(&mut rand::thread_rng())
            .ok_or("No RPC URLs available")?;

        tracing::info!("[Inventory] Syncing using RPC: {}", rpc_url);

        let provider = ProviderBuilder::new()
            .on_http(rpc_url.parse().map_err(|e| format!("Invalid RPC URL {}: {}", rpc_url, e))?);

        // Query USDC balance - use Yellow USDC address if Yellow Network is enabled
        let usdc_addr_to_query = if self.use_yellow {
            self.yellow_usdc_address
        } else {
            self.usdc_address
        };
        
        tracing::info!("[Inventory] Querying USDC balance for {} at token {} (Yellow: {})", 
            self.agent_address, usdc_addr_to_query, self.use_yellow);
        
        let usdc = IERC20::new(usdc_addr_to_query, provider.clone());
        let usdc_balance: U256 = match usdc.balanceOf(self.agent_address).call().await {
            Ok(b) => b._0,
            Err(e) => {
                let error_msg = e.to_string();
                if error_msg.contains("buffer overrun") || error_msg.contains("empty") {
                    warn!("[Inventory] Critical: USDC balance query returned empty or malformed data. Verify {} address ({}) is correct for this network.", 
                        if self.use_yellow { "YELLOW_USDC_ADDRESS" } else { "USDC_ADDRESS" },
                        usdc_addr_to_query);
                }
                warn!("[Inventory] USDC balance query failed for address {} on RPC {}: {}", usdc_addr_to_query, rpc_url, e);
                return Err(format!("USDC balance query failed: {}", e));
            }
        };

        let usdc_u64 = usdc_balance.try_into().unwrap_or(u64::MAX);

        // Query ERC-1155 token balances
        let ctf = IERC1155::new(self.ctf_address, provider.clone());
        let mut token_balances = HashMap::new();

        for tid_str in token_ids {
            let tid_u256 = match U256::from_str_radix(tid_str, 10) {
                Ok(v) => v,
                Err(e) => {
                    warn!("[Inventory] Invalid token ID string '{}': {}", tid_str, e);
                    continue;
                }
            };
            
            let balance: U256 = match ctf.balanceOf(self.agent_address, tid_u256).call().await {
                Ok(b) => b._0,
                Err(e) => {
                    warn!("[Inventory] Balance query failed for token {} (parsed: {}): {}", tid_str, tid_u256, e);
                    U256::ZERO // Don't block whole sync for one token
                }
            };

            token_balances.insert(tid_str.clone(), balance.try_into().unwrap_or(u64::MAX));
        }

        Ok(Inventory {
            usdc_balance: usdc_u64,
            token_balances,
            usdc_reserved: self.usdc_reserved,
            token_reserved: self.token_reserved.clone(),
            pending_buy_tokens: self.pending_buy_tokens.clone(),
        })
    }

    /// Ensure the agent has approved the necessary contracts
    pub async fn ensure_approvals(&self) -> Result<(), String> {
        let rpc_url = self.rpc_urls.choose(&mut rand::thread_rng())
            .ok_or("No RPC URLs available")?;

        // Setup provider with signer wallet
        let wallet = EthereumWallet::from(self.signer.clone());
        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url.parse().unwrap());

        // 1. Approve USDC for CTF/YellowValve
        let usdc = IERC20::new(self.usdc_address, provider.clone());
        let spender = if self.use_yellow { self.ctf_yellow_valve_address } else { self.ctf_address };
        
        let large_amount = U256::from(u64::MAX);

        let current_allowance = usdc.allowance(self.agent_address, spender).call().await
            .map_err(|e| format!("Failed to fetch USDC allowance: {}", e))?;

        if current_allowance._0 < U256::from(1_000_000_000_000u64) { // 1M USDC threshold
            info!("Ensuring USDC approval for {}...", if self.use_yellow { "YellowValve" } else { "CTF" });
            match usdc.approve(spender, large_amount)
                .gas_price(10_000_000_000) // 10 Gwei
                .send().await {
                Ok(builder) => { let _ = builder.watch().await; },
                Err(e) => return Err(format!("Failed to approve USDC for CTF: {}", e)),
            }
        }

        // 1b. Approve USDC for Exchange
        let exchange_allowance = usdc.allowance(self.agent_address, self.exchange_address).call().await
            .map_err(|e| format!("Failed to fetch Exchange USDC allowance: {}", e))?;

        if exchange_allowance._0 < U256::from(1_000_000_000_000u64) {
            info!("Ensuring USDC approval for Exchange ({})...", self.exchange_address);
            match usdc.approve(self.exchange_address, large_amount)
                .gas_price(10_000_000_000) // 10 Gwei
                .send().await {
                Ok(builder) => { let _ = builder.watch().await; },
                Err(e) => return Err(format!("Failed to approve USDC for Exchange: {}", e)),
            }
        }

        // 1c. Set Approval For All on CTF for Exchange
        let ctf_tokens = IERC1155::new(self.ctf_address, provider.clone());
        let is_approved = ctf_tokens.isApprovedForAll(self.agent_address, self.exchange_address).call().await
            .map_err(|e| format!("Failed to check CTF approval: {}", e))?;

        if !is_approved.approved {
            info!("Ensuring CTF setApprovalForAll for Exchange ({})...", self.exchange_address);
            match ctf_tokens.setApprovalForAll(self.exchange_address, true)
                .gas_price(10_000_000_000) // 10 Gwei
                .send().await {
                Ok(builder) => { let _ = builder.watch().await; },
                Err(e) => return Err(format!("Failed to approve CTF for Exchange: {}", e)),
            }
        }

        Ok(())
    }

    /// Ensure the agent has inventory by splitting position if needed
    pub async fn ensure_inventory(&self, condition_id_hex: &str, amount: u64) -> Result<(), String> {
        let rpc_url = self.rpc_urls.choose(&mut rand::thread_rng())
            .ok_or("No RPC URLs available")?;

        // Setup provider with signer wallet
        let wallet = EthereumWallet::from(self.signer.clone());
        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url.parse().unwrap());

        let condition_id = FixedBytes::<32>::from_str(condition_id_hex)
            .map_err(|e| format!("Invalid condition ID: {}", e))?;
        
        let amount_u256 = U256::from(amount);

        // 2. Split Position
        if self.use_yellow {
             let valve = ICTFYellowValve::new(self.ctf_yellow_valve_address, provider.clone());
             let partition = vec![U256::from(1), U256::from(2)];
             
             info!("Onboarding & Splitting via YellowValve for {} USDC...", amount);
             match valve.onboardAndSplit(
                 self.usdc_address,
                 condition_id,
                 amount_u256,
                 partition
             )
             .gas_price(10_000_000_000) // 10 Gwei
             .send().await {
                 Ok(builder) => {
                     let hash = builder.watch().await.map_err(|e| format!("Tx watch failed: {}", e))?;
                     info!("Yellow onboarding successful! Tx: {}", hash);
                     Ok(())
                 },
                 Err(e) => Err(format!("Failed to onboard via Yellow: {}", e)),
             }
        } else {
            let ctf = ICTF::new(self.ctf_address, provider.clone());
            let partition = vec![U256::from(1), U256::from(2)]; // Outcome 0 (NO) and 1 (YES)
            
            info!("Splitting position for {} USDC...", amount);
            match ctf.splitPosition(
                self.usdc_address, 
                FixedBytes::ZERO, 
                condition_id, 
                partition, 
                amount_u256
            )
            .gas_price(10_000_000_000) // 10 Gwei
            .send().await {
                Ok(builder) => { 
                    let hash = builder.watch().await.map_err(|e| format!("Tx watch failed: {}", e))?;
                    info!("Split position successful! Tx: {}", hash);
                    Ok(())
                },
                Err(e) => Err(format!("Failed to split position: {}", e)),
            }
        }
    }

    /// Check if an outcome is a winning one (payout > 0)
    pub async fn get_payout_numerator(&self, condition_id_hex: &str, index: u64) -> Result<u64, String> {
        let rpc_url = self.rpc_urls.choose(&mut rand::thread_rng())
            .ok_or("No RPC URLs available")?;

        // Setup provider
        let wallet = EthereumWallet::from(self.signer.clone());
        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url.parse().unwrap());

        let condition_id = FixedBytes::<32>::from_str(condition_id_hex)
            .map_err(|e| format!("Invalid condition ID: {}", e))?;
        
        let ctf = ICTF::new(self.ctf_address, provider.clone());
        
        // Note: index for binary is 0 or 1.
        // But indexSets are 1 (1<<0) and 2 (1<<1). 
        // payoutNumerators takes the outcome INDEX (0 or 1), NOT the index set.
        // So passed 'index' here should be 0 for NO, 1 for YES.
        match ctf.payoutNumerators(condition_id, U256::from(index)).call().await {
            Ok(result) => {
                let payout = result._0; // Returns uint256
                Ok(payout.to::<u64>())
            },
            Err(e) => Err(format!("Failed to fetch payout: {}", e)),
        }
    }

    /// Redeem winning positions for collateral
    pub async fn redeem_positions(&self, condition_id_hex: &str, index_set: u64) -> Result<(), String> {
        let rpc_url = self.rpc_urls.choose(&mut rand::thread_rng())
            .ok_or("No RPC URLs available")?;

        // Setup provider with signer wallet
        let wallet = EthereumWallet::from(self.signer.clone());
        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_http(rpc_url.parse().unwrap());

        let condition_id = FixedBytes::<32>::from_str(condition_id_hex)
            .map_err(|e| format!("Invalid condition ID: {}", e))?;
        

        let ctf = ICTF::new(self.ctf_address, provider.clone());
        let index_sets = vec![U256::from(index_set)];

        info!("Redeeming payouts for condition {} (IndexSet: {}, Amount: ALL)...", condition_id_hex, index_set);
        match ctf.redeemPositions(
            self.usdc_address, 
            FixedBytes::ZERO, 
            condition_id, 
            index_sets
        )
        .gas_price(10_000_000_000) // 10 Gwei
        .send().await {
            Ok(builder) => { 
                let hash = builder.watch().await.map_err(|e| format!("Tx watch failed: {}", e))?;
                info!("Redemption successful! Tx: {}", hash);
                Ok(())
            },
            Err(e) => Err(format!("Failed to redeem positions: {}", e)),
        }
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

    /// Reserve pending buy tokens (for exposure limits)
    pub fn reserve_pending_buy(&mut self, token_id: &str, amount: u64) {
        let entry = self.pending_buy_tokens.entry(token_id.to_string()).or_insert(0);
        *entry = entry.saturating_add(amount);
    }

    /// Release pending buy tokens
    pub fn release_pending_buy(&mut self, token_id: &str, amount: u64) {
        if let Some(pending) = self.pending_buy_tokens.get_mut(token_id) {
            *pending = pending.saturating_sub(amount);
        }
    }

    /// Clear all reservations (e.g., on restart)
    pub fn clear_reservations(&mut self) {
        self.usdc_reserved = 0;
        self.token_reserved.clear();
        self.pending_buy_tokens.clear();
    }

    /// Sync inventory from Yellow Network off-chain balances
    /// This queries the Yellow ClearNode for ledger balances
    pub async fn sync_yellow(&self, yellow_ws_url: &str, yellow_app_name: &str, yellow_scope: &str) -> Result<Inventory, String> {
        use crate::yellow_client::YellowClient;
        
        // Create Yellow client
        let mut yellow_client = YellowClient::new(
            &crate::config::MMConfig {
                agent_private_key: hex::encode(self.signer.to_bytes()),
                agent_address: format!("{:?}", self.agent_address),
                market_id: None,
                yes_token_id: None,
                no_token_id: None,
                usdc_address: format!("{:?}", self.usdc_address),
                ctf_address: format!("{:?}", self.ctf_address),
                exchange_address: String::new(),
                clob_url: String::new(),
                rpc_url: String::new(),
                rpc_urls: vec![],
                chain_id: 0,
                use_yellow: true,
                yellow_ws_url: yellow_ws_url.to_string(),
                yellow_usdc_address: format!("{:?}", self.yellow_usdc_address),  // Added missing field
                ctf_yellow_valve_address: format!("{:?}", self.ctf_yellow_valve_address),
                custody_address: String::new(),
                yellow_app_name: yellow_app_name.to_string(),
                yellow_scope: yellow_scope.to_string(),
                spread_bps: 0,
                order_size: 0,
                max_inventory: 0,
                quote_interval_ms: 0,
                fair_price: 0.5,
                seed_market: false,
                seed_amount: 0,
            },
            self.signer.clone()
        );

        // Connect and authenticate
        yellow_client.connect().await?;
        yellow_client.authenticate().await?;

        // Query balances
        let balances = yellow_client.get_ledger_balances().await?;

        // Parse balances into Inventory format
        let mut usdc_balance = 0u64;
        let mut token_balances = HashMap::new();

        for balance in balances {
            let asset = balance.get("asset").and_then(|v| v.as_str()).unwrap_or("");
            let amount_str = balance.get("amount").and_then(|v| v.as_str()).unwrap_or("0");
            
            // Parse amount (might be string representation of number)
            let amount: u64 = amount_str.parse().unwrap_or(0);

            // Determine if this is USDC or a token
            // Yellow uses asset addresses or symbols
            // For now, simple heuristic: if asset contains "usd" or matches usdc_address, it's USDC
            let asset_lower = asset.to_lowercase();
            if asset_lower.contains("usd") || asset_lower.contains("usdc") {
                usdc_balance = amount;
            } else {
                // Assume it's a token ID
                token_balances.insert(asset.to_string(), amount);
            }
        }

        Ok(Inventory {
            usdc_balance,
            token_balances,
            usdc_reserved: self.usdc_reserved,
            token_reserved: self.token_reserved.clone(),
            pending_buy_tokens: self.pending_buy_tokens.clone(),
        })
    }
}

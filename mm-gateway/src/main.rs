//! # MM-Gateway - Market Maker for PolyBook
//!
//! A standalone Rust service that acts as a real market maker,
//! participating in Polybook markets with EIP-712 signed orders.
//!
//! ## Features
//! - On-chain inventory tracking (USDC + ERC-1155)
//! - EIP-712 order signing compatible with CLOB
//! - Spread-based quote generation
//! - Automatic re-quoting on fills
//! - Yellow Network integration (optional)
//!
//! ## Usage
//! ```bash
//! # Yellow Network mode
//! export USE_YELLOW=true
//! cargo run
//!
//! # Traditional market-making mode
//! export USE_YELLOW=false
//! cargo run
//! ```

use std::time::Duration;
use tokio::time::sleep;
use tracing::{debug, error, info, warn, Level};
use tracing_subscriber::FmtSubscriber;

use mm_gateway::config::MMConfig;
use mm_gateway::event_listener::EventListener;
use mm_gateway::inventory::InventoryManager;
use mm_gateway::orderbook_adapter::OrderbookAdapter;
use mm_gateway::quote_engine::QuoteEngine;
use mm_gateway::signer::OrderSigner;
use mm_gateway::types::{OpenOrder, Side};
use mm_gateway::utils::now_secs;

use serde::Deserialize;


#[derive(Deserialize, Debug)]
struct MarketMetadata {
    market_id: String,
    slug: String,
    yes_token_id: String,
    no_token_id: String,
    condition_id: String,
    status: String,
}

#[derive(Deserialize)]
struct GetMarketsResponse {
    markets: Vec<MarketMetadata>,
}

async fn fetch_markets(config: &MMConfig, status: &str) -> Result<Vec<MarketMetadata>, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let url = format!("{}/markets?status={}", config.clob_url, status);
    let resp = client.get(&url).send().await?.json::<GetMarketsResponse>().await?;
    Ok(resp.markets)
}

/// Main entry point for the Market Maker Gateway
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber)?;

    // Load configuration
    let config = MMConfig::from_env()?;
    config.validate()?;

    // Split execution based on USE_YELLOW flag
    if config.use_yellow {
        // Yellow-only mode: Run dedicated Yellow service
        info!("Running in Yellow Network mode (Market-making disabled)");
        let signer: alloy::signers::local::PrivateKeySigner = config.agent_private_key.parse()
            .map_err(|e| format!("Invalid private key: {}", e))?;
        mm_gateway::yellow_service::run_yellow_service(config, signer).await
    } else {
        // Traditional market-making mode
        run_market_making_service(config).await
    }
}

/// Run traditional market-making service (no Yellow Network)
async fn run_market_making_service(config: MMConfig) -> Result<(), Box<dyn std::error::Error>> {
    info!("╔══════════════════════════════════════════════════════╗");
    info!("║           MM-Gateway Multi-Market Starting...        ║");
    info!("╚══════════════════════════════════════════════════════╝");

    info!("Configuration loaded:");
    info!("  Agent: {}", config.agent_address);
    info!("  CLOB: {}", config.clob_url);
    info!("  RPC: {}", config.rpc_url);
    
    // Initialize components
    let order_signer = OrderSigner::new(&config)?;
    let mut inventory_manager = InventoryManager::new(&config)?;
    let quote_engine = QuoteEngine::new(&config);
    let orderbook_adapter = OrderbookAdapter::new(&config);
    let mut event_listener = EventListener::new(OrderbookAdapter::new(&config));

    // Verify CLOB is available
    if !orderbook_adapter.health().await {
        error!("CLOB is not available at {}. Exiting.", config.clob_url);
        return Err("CLOB unavailable".into());
    }
    
    info!("CLOB connection verified");

    // Ensure on-chain approvals are in place
    if let Err(e) = inventory_manager.ensure_approvals().await {
        warn!("Initial approval check failed: {}. Continuing anyway...", e);
    }

    info!("Starting multi-market quoting loop...");

    // let mut last_redemption_check = 0;

    loop {
        // 0. Discovery: Fetch active markets
        let active_markets = match fetch_markets(&config, "ACTIVE").await {
            Ok(m) => m,
            Err(e) => {
                warn!("Failed to fetch active markets: {}", e);
                sleep(Duration::from_millis(config.quote_interval_ms)).await;
                continue;
            }
        };

        // 0b. Discovery: Fetch RESOLVED markets for redemption
        /* 
        // 0b. Discovery: Fetch RESOLVED markets for redemption (Disabled per user request)
        // ... (redemption logic removed)
        */

        if active_markets.is_empty() {
            info!("No active markets found. Waiting...");
            sleep(Duration::from_millis(config.quote_interval_ms)).await;
            continue;
        }

        // 1. Sync inventory for all active tokens
        let mut all_tokens = Vec::new();
        for m in &active_markets {
            all_tokens.push(m.yes_token_id.clone());
            all_tokens.push(m.no_token_id.clone());
        }

        let inventory = match inventory_manager.sync(&all_tokens).await {
             Ok(inv) => {
                 info!(
                     "Inventory: USDC={} | Tracking {} tokens across {} active markets",
                     inv.usdc_balance, inv.token_balances.len(), active_markets.len()
                 );
                 inv
             }
             Err(e) => {
                 warn!("Failed to sync inventory: {}. Retrying...", e);
                 sleep(Duration::from_millis(config.quote_interval_ms)).await;
                 continue;
             }
        };

        // 1.2. Auto-Refill (Hackathon Mode)
        if inventory.usdc_balance < 5_000_000 { // Less than 5 USDC
             info!("Low USDC balance ({}), triggering Auto-Refill...", inventory.usdc_balance);
             if let Err(e) = orderbook_adapter.mint_dummy(&config.agent_address).await {
                 error!("Auto-Refill failed: {}", e);
             } else {
                 // Wait a bit for mint to process
                 sleep(Duration::from_secs(2)).await;
                 continue; // Restart loop to re-sync
             }
        }

        // 1.5 Auto-Seed (Split Position) if enabled
        if config.seed_market {
            for market in &active_markets {
                let yes_bal = inventory.token_balances.get(&market.yes_token_id).unwrap_or(&0);
                let no_bal = inventory.token_balances.get(&market.no_token_id).unwrap_or(&0);

                if *yes_bal == 0 && *no_bal == 0 {
                    if inventory.usdc_balance >= config.seed_amount {
                        info!("Seeding market {} with {} USDC...", market.slug, config.seed_amount);
                        match inventory_manager.ensure_inventory(&market.condition_id, config.seed_amount).await {
                            Ok(_) => info!("Seeding successful for {}", market.slug),
                            Err(e) => error!("Seeding failed for {}: {}", market.slug, e),
                        }
                    } else {
                        warn!("Insufficient USDC to seed market {} (Need {}, Have {})", market.slug, config.seed_amount, inventory.usdc_balance);
                    }
                }
            }
        }

        // 2. Check for fills on existing orders
        match event_listener.poll_fills().await {
            Ok(fills) => {
                if !fills.is_empty() {
                    info!("Detected {} fills on our orders", fills.len());
                    for fill in &fills {
                        let qty: u64 = fill.quantity.parse().unwrap_or(0);
                        inventory_manager.release_token(&fill.token_id, qty);
                    }
                }
            }
            Err(e) => warn!("Failed to poll fills: {}", e),
        }

        // 3. Cancel stale orders
        let stale_orders = event_listener.check_stale_orders(now_secs(), 120);
        for order_hash in stale_orders {
            info!("Cancelling stale order: {}", order_hash);
            let order_data = event_listener
                .open_orders()
                .iter()
                .find(|o| o.order_hash == order_hash)
                .map(|o| (o.token_id.clone(), o.side, o.price, o.quantity));

            if let Some((token_id, side, price, quantity)) = order_data {
                let _ = orderbook_adapter.cancel_order(&order_hash, &token_id).await;
                event_listener.untrack_order(&order_hash);

                match side {
                    Side::BUY => {
                        let cost = (price as u128 * quantity as u128 / 1_000_000) as u64;
                        inventory_manager.release_usdc(cost);
                        inventory_manager.release_pending_buy(&token_id, quantity);
                    }
                    Side::SELL => {
                        inventory_manager.release_token(&token_id, quantity);
                    }
                }
            }
        }

        // 4. Generate and place new quotes for each market
        for market in &active_markets {
            let _yes_bal = inventory.token_balances.get(&market.yes_token_id).unwrap_or(&0);
            let _no_bal = inventory.token_balances.get(&market.no_token_id).unwrap_or(&0);

            let quotes = quote_engine.generate_market_quotes(
                &inventory,
                &market.yes_token_id,
                &market.no_token_id,
            );

            for quote in quotes {
                let has_open = event_listener
                    .open_orders()
                    .iter()
                    .any(|o| o.token_id == quote.token_id && o.side == quote.side);

                if has_open {
                    debug!("Skipping quote for {} (already have open order)", quote.token_id);
                    continue;
                }

                // Check if we have enough inventory
                let can_reserve = match quote.side {
                    Side::BUY => {
                        let cost = (quote.price as u128 * quote.quantity as u128 / 1_000_000) as u64;
                        inventory.available_usdc() >= cost
                    }
                    Side::SELL => {
                        inventory.available_token(&quote.token_id) >= quote.quantity
                    }
                };

                if !can_reserve {
                    debug!("Insufficient inventory for quote: {:?}", quote);
                    continue;
                }

                // Reserve inventory
                match quote.side {
                    Side::BUY => {
                        let cost = (quote.price as u128 * quote.quantity as u128 / 1_000_000) as u64;
                        inventory_manager.reserve_usdc(cost);
                        inventory_manager.reserve_pending_buy(&quote.token_id, quote.quantity);
                    }
                    Side::SELL => {
                        inventory_manager.reserve_token(&quote.token_id, quote.quantity);
                    }
                };

                let signed_order = match order_signer.sign_order(
                    &quote.token_id,
                    quote.side,
                    quote.price,
                    quote.quantity,
                ).await {
                    Ok(order) => order,
                    Err(e) => {
                        warn!("Failed to sign order: {}", e);
                        continue;
                    }
                };

                match orderbook_adapter.submit_order(&signed_order).await {
                    Ok(response) => {
                        if response.success {
                            let order_hash = signed_order.order_hash.clone();
                            info!(
                                "Placed {} order: {} @ {} (hash: {})",
                                if quote.side == Side::BUY { "BUY" } else { "SELL" },
                                quote.quantity,
                                quote.price,
                                order_hash
                            );
                            event_listener.track_order(OpenOrder {
                                order_hash,
                                token_id: quote.token_id.clone(),
                                side: quote.side,
                                price: quote.price,
                                quantity: quote.quantity,
                                filled: 0,
                                timestamp: now_secs(),
                            });
                        } else {
                            warn!("Order rejected: {:?}", response.error);
                            // Release reserved inventory on rejection
                            match quote.side {
                                Side::BUY => {
                                    let cost = (quote.price as u128 * quote.quantity as u128 / 1_000_000) as u64;
                                    inventory_manager.release_usdc(cost);
                                    inventory_manager.release_pending_buy(&quote.token_id, quote.quantity);
                                }
                                Side::SELL => {
                                    inventory_manager.release_token(&quote.token_id, quote.quantity);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        warn!("Failed to place order: {}", e);
                        match quote.side {
                            Side::BUY => {
                                let cost = (quote.price as u128 * quote.quantity as u128 / 1_000_000) as u64;
                                inventory_manager.release_usdc(cost);
                                inventory_manager.release_pending_buy(&quote.token_id, quote.quantity);
                            }
                            Side::SELL => {
                                inventory_manager.release_token(&quote.token_id, quote.quantity);
                            }
                        }
                    }
                }
            }
        }

        // 5. Wait before next iteration
        sleep(Duration::from_millis(config.quote_interval_ms)).await;
    }
}

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
//!
//! ## Usage
//! ```bash
//! # Set environment variables or use .env file
//! export CLOB_URL=http://127.0.0.1:3030
//! export RPC_URL=http://127.0.0.1:8545
//! cargo run
//! ```

use std::time::Duration;
use tokio::time::sleep;
use tracing::{error, info, warn, Level};
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

    info!("╔══════════════════════════════════════════════════════╗");
    info!("║           MM-Gateway Multi-Market Starting...        ║");
    info!("╚══════════════════════════════════════════════════════╝");

    // Load configuration
    let config = MMConfig::from_env()?;
    config.validate()?;

    info!("Configuration loaded:");
    info!("  Agent: {}", config.agent_address);
    info!("  CLOB: {}", config.clob_url);
    info!("  RPC: {}", config.rpc_url);
    info!("  Spread: {} bps", config.spread_bps);
    info!("  Order Size: {}", config.order_size);
    info!("  Quote Interval: {}ms", config.quote_interval_ms);
    if config.seed_market {
        info!("  SEEDING ENABLED: {} USDC", config.seed_amount);
    }

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

    // Main runtime loop
    info!("Starting multi-market quoting loop...");

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
        let resolved_markets = match fetch_markets(&config, "RESOLVED").await {
            Ok(m) => m,
            Err(e) => {
                 warn!("Failed to fetch resolved markets: {}", e);
                 vec![] // Don't block main loop if this fails
            }
        };

        // --- REDEMPTION LOGIC ---
        if !resolved_markets.is_empty() {
             let mut resolved_tokens = Vec::new();
             for m in &resolved_markets {
                 resolved_tokens.push(m.yes_token_id.clone());
                 resolved_tokens.push(m.no_token_id.clone());
             }
             
             if let Ok(inv) = inventory_manager.sync(&resolved_tokens).await {
                 for market in &resolved_markets {
                     // Check if outcomes won
                     // Outcome 0 = NO (Index Set 1)
                     // Outcome 1 = YES (Index Set 2)

                     let no_payout = match inventory_manager.get_payout_numerator(&market.condition_id, 0).await {
                         Ok(p) => p,
                         Err(e) => {
                             warn!("Failed to fetch NO payout for {}: {}", market.slug, e);
                             0
                         }
                     };
                     
                     let yes_payout = match inventory_manager.get_payout_numerator(&market.condition_id, 1).await {
                         Ok(p) => p,
                         Err(e) => {
                             warn!("Failed to fetch YES payout for {}: {}", market.slug, e);
                             0
                         }
                     };

                     info!("Market {} Payouts: NO={}, YES={}", market.slug, no_payout, yes_payout);

                     // Check YES Tokens (Index Set 2, Outcome Index 1)
                     if yes_payout > 0 {
                        let yes_bal = inv.token_balances.get(&market.yes_token_id).unwrap_or(&0);
                        if *yes_bal > 0 {
                            info!("YES WON for {}. Found {} tokens. Redeeming...", market.slug, yes_bal);
                            if let Err(e) = inventory_manager.redeem_positions(&market.condition_id, 2, *yes_bal).await {
                                warn!("Failed to redeem YES tokens for {}: {}", market.slug, e);
                            }
                        }
                     }

                     // Check NO Tokens (Index Set 1, Outcome Index 0)
                     if no_payout > 0 {
                        let no_bal = inv.token_balances.get(&market.no_token_id).unwrap_or(&0);
                        if *no_bal > 0 {
                            info!("NO WON for {}. Found {} tokens. Redeeming...", market.slug, no_bal);
                            if let Err(e) = inventory_manager.redeem_positions(&market.condition_id, 1, *no_bal).await {
                                warn!("Failed to redeem NO tokens for {}: {}", market.slug, e);
                            }
                        }
                     }
                 }
             }
        }

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

        // 1.5 Auto-Seed (Split Position) if enabled and inventory is empty for a market
        if config.seed_market {
            for market in &active_markets {
                let yes_bal = inventory.token_balances.get(&market.yes_token_id).unwrap_or(&0);
                let no_bal = inventory.token_balances.get(&market.no_token_id).unwrap_or(&0);

                // If we have negligible tokens (less than order size), we might need to seed
                if *yes_bal < config.order_size || *no_bal < config.order_size {
                    // Check if we have enough USDC
                    if inventory.usdc_balance >= config.seed_amount {
                        info!("Seeding market {} with {} USDC...", market.slug, config.seed_amount);
                        match inventory_manager.ensure_inventory(&market.condition_id, config.seed_amount).await {
                            Ok(_) => info!("Seeding successful for {}", market.slug),
                            Err(e) => warn!("Seeding failed for {}: {}", market.slug, e),
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

        // 3. Cancel stale orders (older than 2 minutes for faster rotation)
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
                    }
                    Side::SELL => {
                        inventory_manager.release_token(&token_id, quantity);
                    }
                }
            }
        }

        // 4. Loop through each market and quote
        for market in &active_markets {
            let quotes = quote_engine.generate_market_quotes(&inventory, &market.yes_token_id, &market.no_token_id);

            for quote in quotes {
                // Skip if we already have an order at this price/side
                let existing = event_listener
                    .orders_for_token(&quote.token_id)
                    .iter()
                    .any(|o| o.side == quote.side && o.price == quote.price);

                if existing {
                    continue;
                }

                match order_signer.sign_order(&quote.token_id, quote.side, quote.price, quote.quantity).await {
                    Ok(order_request) => {
                        let order_hash = order_request.order_hash.clone();
                        match orderbook_adapter.submit_order(&order_request).await {
                            Ok(response) => {
                                if response.success {
                                    info!(
                                        "Order submitted: {} {} @ {} for market {}",
                                        quote.side.as_str(), quote.token_id, quote.price, market.slug
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

                                    match quote.side {
                                        Side::BUY => {
                                            let cost = (quote.price as u128 * quote.quantity as u128 / 1_000_000) as u64;
                                            inventory_manager.reserve_usdc(cost);
                                        }
                                        Side::SELL => {
                                            inventory_manager.reserve_token(&quote.token_id, quote.quantity);
                                        }
                                    }
                                } else {
                                    warn!("Order rejected: {}", response.error.unwrap_or_default());
                                }
                            }
                            Err(e) => warn!("Failed to submit order: {}", e),
                        }
                    }
                    Err(e) => error!("Failed to sign order: {}", e),
                }
            }
        }

        // 6. Sleep until next quote interval
        sleep(Duration::from_millis(config.quote_interval_ms)).await;
    }
}

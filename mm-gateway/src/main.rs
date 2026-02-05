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

#[derive(Deserialize)]
struct MarketMetadata {
    market_id: String,
    yes_token_id: String,
    no_token_id: String,
}

#[derive(Deserialize)]
struct GetMarketsResponse {
    markets: Vec<MarketMetadata>,
}

async fn fetch_market_from_clob(config: &MMConfig) -> Result<MarketMetadata, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let url = format!("{}/markets", config.clob_url);
    let resp = client.get(&url).send().await?.json::<GetMarketsResponse>().await?;
    
    let target_id = config.market_id.to_string();
    resp.markets.into_iter()
        .find(|m| m.market_id == target_id)
        .ok_or_else(|| format!("Market ID {} not found in registry", target_id).into())
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
    info!("║           MM-Gateway Starting...                     ║");
    info!("╚══════════════════════════════════════════════════════╝");

    // Load configuration
    let mut config = MMConfig::from_env()?;
    config.validate()?;

    // Dynamic Discovery
    if config.yes_token_id.is_empty() || config.no_token_id.is_empty() {
        info!("Token IDs not set. Fetching from CLOB registry for Market ID {}...", config.market_id);
        match fetch_market_from_clob(&config).await {
            Ok(market) => {
                config.yes_token_id = market.yes_token_id;
                config.no_token_id = market.no_token_id;
                info!("Resolved Token IDs:");
                info!("  YES: {}", config.yes_token_id);
                info!("  NO:  {}", config.no_token_id);
            }
            Err(e) => {
                error!("Failed to fetch market config: {}", e);
                return Err(e);
            }
        }
    }

    info!("Configuration loaded:");
    info!("  Agent: {}", config.agent_address);
    info!("  CLOB: {}", config.clob_url);
    info!("  RPC: {}", config.rpc_url);
    info!("  Spread: {} bps", config.spread_bps);
    info!("  Order Size: {}", config.order_size);
    info!("  Quote Interval: {}ms", config.quote_interval_ms);

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
    info!("Starting main quoting loop...");

    loop {
        // 1. Sync inventory from chain
        let inventory = match inventory_manager.sync().await {
            Ok(inv) => {
                info!(
                    "Inventory: USDC={} YES={} NO={}",
                    inv.usdc_balance, inv.yes_balance, inv.no_balance
                );
                inv
            }
            Err(e) => {
                warn!("Failed to sync inventory: {}. Using cached.", e);
                continue;
            }
        };

        // 2. Check for fills on existing orders
        match event_listener.poll_fills().await {
            Ok(fills) => {
                if !fills.is_empty() {
                    info!("Detected {} fills on our orders", fills.len());
                    // Release reservations for filled orders
                    for fill in &fills {
                        let qty: u64 = fill.quantity.parse().unwrap_or(0);
                        // Simplified: assume YES sells for now
                        inventory_manager.release_yes(qty);
                    }
                }
            }
            Err(e) => {
                warn!("Failed to poll fills: {}", e);
            }
        }

        // 3. Cancel stale orders (older than 5 minutes)
        let stale_orders = event_listener.check_stale_orders(now_secs(), 300);
        for order_hash in stale_orders {
            info!("Cancelling stale order: {}", order_hash);
            // Find the order data before mutating
            let order_data = event_listener
                .open_orders()
                .iter()
                .find(|o| o.order_hash == order_hash)
                .map(|o| (o.token_id.clone(), o.side, o.price, o.quantity));

            if let Some((token_id, side, price, quantity)) = order_data {
                let _ = orderbook_adapter
                    .cancel_order(&order_hash, &token_id)
                    .await;
                event_listener.untrack_order(&order_hash);

                // Release reservations
                match side {
                    Side::BUY => {
                        let cost = (price as u128 * quantity as u128 / 1_000_000) as u64;
                        inventory_manager.release_usdc(cost);
                    }
                    Side::SELL => {
                        inventory_manager.release_yes(quantity);
                    }
                }
            }
        }

        // 4. Generate new quotes
        let quotes = quote_engine.generate_all_quotes(&inventory);

        if quotes.is_empty() {
            info!("No quotes generated (insufficient inventory or limits reached)");
        } else {
            info!("Generated {} quotes", quotes.len());
        }

        // 5. Submit quotes as signed orders
        for quote in quotes {
            // Skip if we already have an order at this price/side
            let existing = event_listener
                .orders_for_token(&quote.token_id)
                .iter()
                .any(|o| o.side == quote.side && o.price == quote.price);

            if existing {
                continue; // Don't double-post at same price
            }

            match order_signer
                .sign_order(&quote.token_id, quote.side, quote.price, quote.quantity)
                .await
            {
                Ok(order_request) => {
                    let order_hash = order_request.order_hash.clone();

                    match orderbook_adapter.submit_order(&order_request).await {
                        Ok(response) => {
                            if response.success {
                                info!(
                                    "Order submitted: {} {} @ {} qty {}",
                                    quote.side.as_str(),
                                    quote.token_id,
                                    quote.price,
                                    quote.quantity
                                );

                                // Track the order
                                event_listener.track_order(OpenOrder {
                                    order_hash,
                                    token_id: quote.token_id.clone(),
                                    side: quote.side,
                                    price: quote.price,
                                    quantity: quote.quantity,
                                    filled: 0,
                                    timestamp: now_secs(),
                                });

                                // Reserve inventory
                                match quote.side {
                                    Side::BUY => {
                                        let cost = (quote.price as u128 * quote.quantity as u128
                                            / 1_000_000)
                                            as u64;
                                        inventory_manager.reserve_usdc(cost);
                                    }
                                    Side::SELL => {
                                        if quote.token_id == config.yes_token_id {
                                            inventory_manager.reserve_yes(quote.quantity);
                                        } else {
                                            inventory_manager.reserve_no(quote.quantity);
                                        }
                                    }
                                }

                                // Check if there were immediate fills
                                if !response.trades.is_empty() {
                                    info!("Immediate fills: {}", response.trades.len());
                                }
                            } else {
                                warn!(
                                    "Order rejected: {}",
                                    response.error.unwrap_or_default()
                                );
                            }
                        }
                        Err(e) => {
                            warn!("Failed to submit order: {}", e);
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to sign order: {}", e);
                }
            }
        }

        // 6. Sleep until next quote interval
        sleep(Duration::from_millis(config.quote_interval_ms)).await;
    }
}

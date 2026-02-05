//! # MM-Gateway Event Listener
//!
//! Monitors trade execution events from the CLOB to update inventory and trigger re-quoting.

use std::collections::HashSet;
use tracing::info;

use crate::orderbook_adapter::OrderbookAdapter;
use crate::types::{OpenOrder, TradeResult};

/// Event listener for trade execution feedback
pub struct EventListener {
    adapter: OrderbookAdapter,
    /// Last trade ID seen (for incremental polling)
    last_trade_id: Option<String>,
    /// Open orders tracked by the MM
    open_orders: Vec<OpenOrder>,
}

impl EventListener {
    /// Create a new event listener
    pub fn new(adapter: OrderbookAdapter) -> Self {
        Self {
            adapter,
            last_trade_id: None,
            open_orders: Vec::new(),
        }
    }

    /// Add an open order to track
    pub fn track_order(&mut self, order: OpenOrder) {
        info!("Tracking order: {} {} @ {}", order.order_hash, order.side.as_str(), order.price);
        self.open_orders.push(order);
    }

    /// Remove a cancelled order from tracking
    pub fn untrack_order(&mut self, order_hash: &str) {
        self.open_orders.retain(|o| o.order_hash != order_hash);
    }

    /// Get all tracked open orders
    pub fn open_orders(&self) -> &[OpenOrder] {
        &self.open_orders
    }

    /// Clear all tracked orders
    pub fn clear_orders(&mut self) {
        self.open_orders.clear();
    }

    /// Get order hashes for a specific token
    pub fn orders_for_token(&self, token_id: &str) -> Vec<&OpenOrder> {
        self.open_orders
            .iter()
            .filter(|o| o.token_id == token_id)
            .collect()
    }

    /// Poll for new trades and return fills on our orders
    pub async fn poll_fills(&mut self) -> Result<Vec<TradeResult>, String> {
        let trades_response = self.adapter.get_trades(100).await?;
        let trades = trades_response.trades;

        if trades.is_empty() {
            return Ok(Vec::new());
        }

        // Build set of our order hashes for quick lookup
        let our_hashes: HashSet<String> = self
            .open_orders
            .iter()
            .map(|o| o.order_hash.clone())
            .collect();

        let mut fills = Vec::new();
        let mut fill_updates: Vec<(String, u64)> = Vec::new();

        for trade in trades.iter() {
            // Skip if we've already processed this trade
            if let Some(ref last_id) = self.last_trade_id {
                if &trade.trade_id == last_id {
                    break; // Stop at last seen trade
                }
            }

            // Check if this trade involves our orders (as maker)
            for maker_hash in &trade.maker_order_hashes {
                if our_hashes.contains(maker_hash) {
                    info!("Found fill on our order: {} qty {}", maker_hash, trade.quantity);
                    fills.push(trade.clone());

                    // Record the fill for later update
                    let fill_qty: u64 = trade.quantity.parse().unwrap_or(0);
                    fill_updates.push((maker_hash.clone(), fill_qty));
                    break; // Each trade only matches once per order
                }
            }
        }

        // Apply fill updates after iteration
        for (hash, qty) in fill_updates {
            if let Some(order) = self.open_orders.iter_mut().find(|o| o.order_hash == hash) {
                order.filled = order.filled.saturating_add(qty);
                if order.filled >= order.quantity {
                    info!("Order {} fully filled", hash);
                }
            }
        }

        // Update last seen trade ID
        if let Some(first_trade) = trades.first() {
            self.last_trade_id = Some(first_trade.trade_id.clone());
        }

        // Remove fully filled orders
        self.open_orders.retain(|o| o.filled < o.quantity);

        Ok(fills)
    }

    /// Check if any orders need re-quoting (expired or stale)
    pub fn check_stale_orders(&self, current_time: u64, max_age_secs: u64) -> Vec<String> {
        self.open_orders
            .iter()
            .filter(|o| current_time.saturating_sub(o.timestamp) > max_age_secs)
            .map(|o| o.order_hash.clone())
            .collect()
    }
}

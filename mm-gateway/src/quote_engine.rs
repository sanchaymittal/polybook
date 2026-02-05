//! # MM-Gateway Quote Engine
//!
//! Computes bid/ask quotes for market making.
//! Uses a simple spread-based strategy initially, with hooks for market-maker-rs integration.

use tracing::info;

use crate::config::MMConfig;
use crate::types::{Inventory, Quote, Side};

/// Quote engine for computing market maker quotes
pub struct QuoteEngine {
    yes_token_id: String,
    no_token_id: String,
    spread_bps: u64,
    order_size: u64,
    max_inventory: u64,
    fair_price: f64,
}

impl QuoteEngine {
    /// Create a new quote engine from configuration
    pub fn new(config: &MMConfig) -> Self {
        Self {
            yes_token_id: config.yes_token_id.clone(),
            no_token_id: config.no_token_id.clone(),
            spread_bps: config.spread_bps,
            order_size: config.order_size,
            max_inventory: config.max_inventory,
            fair_price: config.fair_price,
        }
    }

    /// Generate quotes for YES token based on current inventory
    pub fn generate_yes_quotes(&self, inventory: &Inventory) -> Vec<Quote> {
        let mut quotes = Vec::new();

        // Calculate bid and ask prices
        // spread_bps is total spread, so half on each side
        let half_spread = self.spread_bps as f64 / 20000.0; // Convert bps to fraction / 2
        let bid_price = ((self.fair_price - half_spread) * 1_000_000.0) as u64;
        let ask_price = ((self.fair_price + half_spread) * 1_000_000.0) as u64;

        // BUY quote (bid) - if we have USDC available
        let available_usdc = inventory.available_usdc();
        let bid_cost = (bid_price as u128 * self.order_size as u128 / 1_000_000) as u64;
        if available_usdc >= bid_cost {
            // Check inventory limit
            let current_yes = inventory.yes_balance;
            if current_yes < self.max_inventory {
                quotes.push(Quote {
                    side: Side::BUY,
                    token_id: self.yes_token_id.clone(),
                    price: bid_price,
                    quantity: self.order_size,
                });
                info!(
                    "Generated YES BID: price={} qty={} (avail USDC={})",
                    bid_price, self.order_size, available_usdc
                );
            }
        }

        // SELL quote (ask) - if we have YES tokens available
        let available_yes = inventory.available_yes();
        if available_yes >= self.order_size {
            // Check inventory limit (inverse - don't short too much)
            let current_usdc = inventory.usdc_balance;
            if current_usdc < self.max_inventory * 2 {
                // Allow selling if not already max long USDC
                quotes.push(Quote {
                    side: Side::SELL,
                    token_id: self.yes_token_id.clone(),
                    price: ask_price,
                    quantity: self.order_size.min(available_yes),
                });
                info!(
                    "Generated YES ASK: price={} qty={} (avail YES={})",
                    ask_price, self.order_size.min(available_yes), available_yes
                );
            }
        }

        quotes
    }

    /// Generate quotes for NO token based on current inventory
    pub fn generate_no_quotes(&self, inventory: &Inventory) -> Vec<Quote> {
        let mut quotes = Vec::new();

        // For NO token, fair price is 1 - yes_fair_price
        let no_fair_price = 1.0 - self.fair_price;
        let half_spread = self.spread_bps as f64 / 20000.0;
        let bid_price = ((no_fair_price - half_spread) * 1_000_000.0) as u64;
        let ask_price = ((no_fair_price + half_spread) * 1_000_000.0) as u64;

        // BUY quote (bid) for NO
        let available_usdc = inventory.available_usdc();
        let bid_cost = (bid_price as u128 * self.order_size as u128 / 1_000_000) as u64;
        if available_usdc >= bid_cost {
            let current_no = inventory.no_balance;
            if current_no < self.max_inventory {
                quotes.push(Quote {
                    side: Side::BUY,
                    token_id: self.no_token_id.clone(),
                    price: bid_price,
                    quantity: self.order_size,
                });
                info!(
                    "Generated NO BID: price={} qty={} (avail USDC={})",
                    bid_price, self.order_size, available_usdc
                );
            }
        }

        // SELL quote (ask) for NO
        let available_no = inventory.available_no();
        if available_no >= self.order_size {
            quotes.push(Quote {
                side: Side::SELL,
                token_id: self.no_token_id.clone(),
                price: ask_price,
                quantity: self.order_size.min(available_no),
            });
            info!(
                "Generated NO ASK: price={} qty={} (avail NO={})",
                ask_price, self.order_size.min(available_no), available_no
            );
        }

        quotes
    }

    /// Generate all quotes (YES and NO)
    pub fn generate_all_quotes(&self, inventory: &Inventory) -> Vec<Quote> {
        let mut quotes = self.generate_yes_quotes(inventory);
        quotes.extend(self.generate_no_quotes(inventory));
        quotes
    }

    /// Update fair price (for future dynamic pricing)
    pub fn set_fair_price(&mut self, price: f64) {
        if price > 0.0 && price < 1.0 {
            self.fair_price = price;
            info!("Updated fair price to {}", price);
        }
    }

    /// Get current fair price
    pub fn fair_price(&self) -> f64 {
        self.fair_price
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_inventory() -> Inventory {
        Inventory {
            usdc_balance: 100_000_000, // 100 USDC
            yes_balance: 50_000_000,   // 50 YES
            no_balance: 50_000_000,    // 50 NO
            usdc_reserved: 0,
            yes_reserved: 0,
            no_reserved: 0,
        }
    }

    #[test]
    fn test_generate_yes_quotes() {
        let config = MMConfig::from_env().unwrap();
        let engine = QuoteEngine::new(&config);
        let inventory = test_inventory();

        let quotes = engine.generate_yes_quotes(&inventory);
        assert!(!quotes.is_empty());

        // Should have both bid and ask
        let has_bid = quotes.iter().any(|q| matches!(q.side, Side::BUY));
        let has_ask = quotes.iter().any(|q| matches!(q.side, Side::SELL));
        assert!(has_bid, "Should generate bid");
        assert!(has_ask, "Should generate ask");
    }

    #[test]
    fn test_spread_calculation() {
        let config = MMConfig::from_env().unwrap();
        let engine = QuoteEngine::new(&config);
        let inventory = test_inventory();

        let quotes = engine.generate_yes_quotes(&inventory);

        let bid = quotes.iter().find(|q| matches!(q.side, Side::BUY)).unwrap();
        let ask = quotes.iter().find(|q| matches!(q.side, Side::SELL)).unwrap();

        // With 200 bps spread (2%), bid should be ~0.49, ask ~0.51
        let spread = ask.price - bid.price;
        let expected_spread = (config.spread_bps as f64 / 100.0) * 10000.0; // 2% of 1e6
        assert!(
            (spread as f64 - expected_spread).abs() < 1000.0,
            "Spread should be ~{}, got {}",
            expected_spread,
            spread
        );
    }
}

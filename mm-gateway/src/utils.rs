//! # MM-Gateway Utilities
//!
//! Helper functions for price scaling, timing, and general utilities.

use std::time::{SystemTime, UNIX_EPOCH};

/// Scale factor for 6 decimal places (USDC)
pub const SCALE: u64 = 1_000_000;

/// Convert decimal price (0.0-1.0) to scaled integer
pub fn price_to_scaled(price: f64) -> u64 {
    (price * SCALE as f64) as u64
}

/// Convert scaled integer to decimal price
pub fn scaled_to_price(scaled: u64) -> f64 {
    scaled as f64 / SCALE as f64
}

/// Convert token quantity to scaled integer
pub fn quantity_to_scaled(quantity: f64) -> u64 {
    (quantity * SCALE as f64) as u64
}

/// Convert scaled integer to token quantity
pub fn scaled_to_quantity(scaled: u64) -> f64 {
    scaled as f64 / SCALE as f64
}

/// Get current Unix timestamp in seconds
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// Get current Unix timestamp in milliseconds
pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

/// Format price for display
pub fn format_price(scaled: u64) -> String {
    format!("{:.6}", scaled_to_price(scaled))
}

/// Format quantity for display
pub fn format_quantity(scaled: u64) -> String {
    format!("{:.2}", scaled_to_quantity(scaled))
}

/// Generate a random salt for order uniqueness
pub fn generate_salt() -> u128 {
    rand::random::<u128>()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_scaling() {
        let price = 0.5;
        let scaled = price_to_scaled(price);
        assert_eq!(scaled, 500_000);

        let back = scaled_to_price(scaled);
        assert!((back - price).abs() < 0.000001);
    }

    #[test]
    fn test_quantity_scaling() {
        let qty = 100.0;
        let scaled = quantity_to_scaled(qty);
        assert_eq!(scaled, 100_000_000);

        let back = scaled_to_quantity(scaled);
        assert!((back - qty).abs() < 0.000001);
    }

    #[test]
    fn test_timestamp() {
        let ts = now_secs();
        assert!(ts > 1700000000); // After 2023
    }
}

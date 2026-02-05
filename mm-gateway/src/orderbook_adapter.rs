//! # MM-Gateway Orderbook Adapter
//!
//! HTTP client for interacting with the CLOB matching engine.
//! Handles order submission, cancellation, and book queries.

use reqwest::Client;
use tracing::{info, warn};

use crate::config::MMConfig;
use crate::types::{
    CancelRequest, CancelResponse, OrderBookState, OrderRequest, OrderResponse, TradesResponse,
};

/// HTTP client for CLOB interaction
pub struct OrderbookAdapter {
    client: Client,
    base_url: String,
}

impl OrderbookAdapter {
    /// Create a new orderbook adapter
    pub fn new(config: &MMConfig) -> Self {
        Self {
            client: Client::new(),
            base_url: config.clob_url.clone(),
        }
    }

    /// Check CLOB health
    pub async fn health(&self) -> bool {
        match self.client.get(format!("{}/health", self.base_url)).send().await {
            Ok(res) => res.status().is_success(),
            Err(e) => {
                warn!("CLOB health check failed: {}", e);
                false
            }
        }
    }

    /// Submit a signed order to the CLOB
    pub async fn submit_order(&self, order: &OrderRequest) -> Result<OrderResponse, String> {
        info!(
            "Submitting order: {} {} @ {} qty {}",
            order.side, order.token_id, order.price, order.quantity
        );

        let response = self
            .client
            .post(format!("{}/order", self.base_url))
            .json(order)
            .send()
            .await
            .map_err(|e| format!("Order submission failed: {}", e))?;

        if response.status().is_success() {
            response
                .json::<OrderResponse>()
                .await
                .map_err(|e| format!("Failed to parse order response: {}", e))
        } else {
            // Try to parse error response
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(format!("Order rejected ({}): {}", status, body))
        }
    }

    /// Cancel an order by hash
    pub async fn cancel_order(
        &self,
        order_hash: &str,
        token_id: &str,
    ) -> Result<CancelResponse, String> {
        info!("Cancelling order: {}", order_hash);

        let request = CancelRequest {
            order_hash: order_hash.to_string(),
            token_id: token_id.to_string(),
        };

        let response = self
            .client
            .post(format!("{}/order/cancel", self.base_url))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Cancel request failed: {}", e))?;

        if response.status().is_success() {
            response
                .json::<CancelResponse>()
                .await
                .map_err(|e| format!("Failed to parse cancel response: {}", e))
        } else {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(format!("Cancel failed ({}): {}", status, body))
        }
    }

    /// Get orderbook state for a token
    pub async fn get_orderbook(&self, token_id: &str) -> Result<OrderBookState, String> {
        let response = self
            .client
            .get(format!("{}/orderbook/{}", self.base_url, token_id))
            .send()
            .await
            .map_err(|e| format!("Orderbook query failed: {}", e))?;

        if response.status().is_success() {
            response
                .json::<OrderBookState>()
                .await
                .map_err(|e| format!("Failed to parse orderbook: {}", e))
        } else {
            Err(format!("Orderbook query failed: {}", response.status()))
        }
    }

    /// Get recent trades
    pub async fn get_trades(&self, limit: usize) -> Result<TradesResponse, String> {
        let response = self
            .client
            .get(format!("{}/trades?limit={}", self.base_url, limit))
            .send()
            .await
            .map_err(|e| format!("Trades query failed: {}", e))?;

        if response.status().is_success() {
            response
                .json::<TradesResponse>()
                .await
                .map_err(|e| format!("Failed to parse trades: {}", e))
        } else {
            Err(format!("Trades query failed: {}", response.status()))
        }
    }

    /// Get order details by hash
    pub async fn get_order(&self, order_hash: &str) -> Result<OrderRequest, String> {
        let response = self
            .client
            .get(format!("{}/order/{}", self.base_url, order_hash))
            .send()
            .await
            .map_err(|e| format!("Order query failed: {}", e))?;

        if response.status().is_success() {
            response
                .json::<OrderRequest>()
                .await
                .map_err(|e| format!("Failed to parse order: {}", e))
        } else if response.status() == 404 {
            Err("Order not found".to_string())
        } else {
            Err(format!("Order query failed: {}", response.status()))
        }
    }
}

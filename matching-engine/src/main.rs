//! # PolyBook Matching Engine
//!
//! Rust-based matching engine using orderbook-rs for the PolyBook prediction market.
//! Exposes a simple HTTP API for the TypeScript CLOB to call.

use actix_web::{web, App, HttpResponse, HttpServer};
use dashmap::DashMap;
use orderbook_rs::{OrderBook, OrderId, Side as OBSide, TimeInForce, TradeResult as OBTradeResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

/// Order side for our API
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Side {
    Buy,
    Sell,
}

impl From<Side> for OBSide {
    fn from(side: Side) -> Self {
        match side {
            Side::Buy => OBSide::Buy,
            Side::Sell => OBSide::Sell,
        }
    }
}

/// Order request from TypeScript CLOB
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderRequest {
    /// Maker address
    pub maker: String,
    /// Token ID (as string to handle large numbers)
    pub token_id: String,
    /// Order side: BUY or SELL
    pub side: Side,
    /// Price per token (6 decimal places, as string)
    pub price: String,
    /// Quantity (6 decimal places, as string)
    pub quantity: String,
    /// Order hash from EIP-712 signature
    pub order_hash: String,
}

/// Trade result
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeResult {
    pub trade_id: String,
    pub buyer: String,
    pub seller: String,
    pub token_id: String,
    pub price: String,
    pub quantity: String,
    pub taker_order_hash: String,
    pub maker_order_hashes: Vec<String>,
    pub maker_fill_amounts: Vec<String>,
}

/// Order book state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderBookState {
    pub token_id: String,
    pub bids: Vec<PriceLevel>,
    pub asks: Vec<PriceLevel>,
}

/// Price level in the order book
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceLevel {
    pub price: String,
    pub quantity: String,
    pub order_count: u32,
}

/// Response for order submission
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    pub success: bool,
    pub order_id: Option<String>,
    pub trades: Vec<TradeResult>,
    pub error: Option<String>,
}

/// Application state shared across handlers
pub struct AppState {
    // Map of token_id -> OrderBook
    order_books: RwLock<HashMap<String, OrderBook>>,
    // Map of order_hash -> order details
    orders: RwLock<HashMap<String, OrderRequest>>,
    // Map of order_id (from orderbook-rs) -> maker_address
    order_makers: DashMap<String, String>,
    // Store captured trades for a request (Key: taker_order_id, Value: List of trades)
    // We use a shared map because listeners are async/callback based
    captured_trades: DashMap<String, Vec<TradeResult>>,
    // Helpers
    trade_counter: RwLock<u64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            order_books: RwLock::new(HashMap::new()),
            orders: RwLock::new(HashMap::new()),
            order_makers: DashMap::new(),
            captured_trades: DashMap::new(),
            trade_counter: RwLock::new(0),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// Health check endpoint
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "engine": "polybook-matcher",
        "version": "0.1.0"
    }))
}

/// Submit an order to the matching engine
async fn submit_order(
    data: web::Data<Arc<AppState>>,
    order: web::Json<OrderRequest>,
) -> HttpResponse {
    let req = order.into_inner();
    info!("Received order: {:?}", req);

    let token_id = req.token_id.clone();
    let order_hash = req.order_hash.clone();

    // Store the order request details (by hash)
    {
        let mut orders = data.orders.write().unwrap();
        orders.insert(order_hash.clone(), req.clone());
    }

    // Create the listener closure
    // We clone the state reference for the listener
    let state_for_listener = data.clone();
    let token_id_for_listener = token_id.clone();
    
    let trade_listener = Arc::new(move |trade_result: &OBTradeResult| {
        let match_result = &trade_result.match_result;
        let taker_order_id = match_result.order_id.to_string();
        
        info!("Trade Listener triggered for taker order: {}", taker_order_id);

        // Process transactions
        for tx in match_result.transactions.as_vec() {
            let maker_order_id = tx.maker_order_id.to_string();
            
            // Resolve maker address requires storing UUID->Maker mapping.
            // Assuming we stored it in submit_order before adding.
            
            // Note: We can't access order_makers with `await` since we are in sync closure. 
            // DashMap is sync, so it's fine.
            
            // Generate trade ID
            let counter_val = {
                let mut c = state_for_listener.trade_counter.write().unwrap();
                *c += 1;
                *c
            };
            let trade_id = format!("trade-{}", counter_val);
            
            let trade = TradeResult {
                trade_id,
                buyer: "pending".to_string(), // Placeholder, resolved in post-processing
                seller: "pending".to_string(),
                token_id: token_id_for_listener.clone(),
                price: tx.price.to_string(),
                quantity: tx.quantity.to_string(),
                taker_order_hash: taker_order_id.clone(), 
                maker_order_hashes: vec![maker_order_id],
                maker_fill_amounts: vec![tx.quantity.to_string()],
            };
            
            // Insert into captured trades
            state_for_listener.captured_trades.entry(taker_order_id.clone())
                .or_insert_with(Vec::new)
                .push(trade);
        }
    });

    // Get or create order book for this token
    let mut order_books = data.order_books.write().unwrap();
    let book = order_books
        .entry(token_id.clone())
        .or_insert_with(|| OrderBook::with_trade_listener(&token_id, trade_listener));

    // Parse price and quantity
    let price: u128 = req.price.parse().unwrap_or(0);
    let quantity: u64 = req.quantity.parse().unwrap_or(0);

    // Create order ID
    // We use new_uuid() as seen in examples/src/bin/basic_orderbook.rs
    let order_id = OrderId::new_uuid();
    let order_id_str = order_id.to_string();

    // Register maker for this order ID (before adding!)
    data.order_makers.insert(order_id_str.clone(), req.maker.clone());

    // Add limit order
    match book.add_limit_order(
        order_id,
        price,
        quantity,
        req.side.into(),
        TimeInForce::Gtc,
        None,
    ) {
        Ok(ob_order) => {
            info!(
                "Order {} added: {} {} @ {} for token {}",
                ob_order.id(),
                if req.side == Side::Buy { "BUY" } else { "SELL" },
                quantity,
                price,
                token_id
            );

            // Retrieve captured trades
            let captured = data.captured_trades.remove(&order_id_str).map(|(_, v)| v).unwrap_or_default();
            
            // Post-process trades to set Buyer/Seller and OrderHash
            let processed_trades: Vec<TradeResult> = captured.into_iter().map(|mut t| {
                // Taker is this order.
                t.taker_order_hash = order_hash.clone();
                let is_taker_buy = req.side == Side::Buy;
                
                // Maker ID is in maker_order_hashes[0]
                let maker_id_uuid = t.maker_order_hashes[0].clone();
                let maker_addr = data.order_makers.get(&maker_id_uuid)
                    .map(|v| v.value().clone())
                    .unwrap_or_else(|| "unknown".to_string());
                
                if is_taker_buy {
                    t.buyer = req.maker.clone();
                    t.seller = maker_addr;
                } else {
                    t.buyer = maker_addr;
                    t.seller = req.maker.clone();
                }
                t
            }).collect();

            HttpResponse::Ok().json(OrderResponse {
                success: true,
                order_id: Some(order_id_str),
                trades: processed_trades,
                error: None,
            })
        }
        Err(e) => {
            HttpResponse::BadRequest().json(OrderResponse {
                success: false,
                order_id: None,
                trades: vec![],
                error: Some(format!("Failed to add order: {:?}", e)),
            })
        }
    }
}

/// Get order book state for a token
async fn get_orderbook(
    data: web::Data<Arc<AppState>>,
    path: web::Path<String>,
) -> HttpResponse {
    let token_id = path.into_inner();

    let order_books = data.order_books.read().unwrap();

    if let Some(book) = order_books.get(&token_id) {
        // Create snapshot (top 20 levels)
        let snapshot = book.create_snapshot(20);

        let bids: Vec<PriceLevel> = snapshot
            .bids
            .iter()
            .map(|level| PriceLevel {
                price: level.price.to_string(),
                quantity: level.visible_quantity.to_string(),
                order_count: level.order_count as u32,
            })
            .collect();

        let asks: Vec<PriceLevel> = snapshot
            .asks
            .iter()
            .map(|level| PriceLevel {
                price: level.price.to_string(),
                quantity: level.visible_quantity.to_string(),
                order_count: level.order_count as u32,
            })
            .collect();

        HttpResponse::Ok().json(OrderBookState {
            token_id,
            bids,
            asks,
        })
    } else {
        HttpResponse::Ok().json(OrderBookState {
            token_id,
            bids: vec![],
            asks: vec![],
        })
    }
}

/// Main entry point
#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .finish();
    tracing::subscriber::set_global_default(subscriber).expect("Failed to set subscriber");

    info!("Starting PolyBook Matching Engine on port 3030...");

    let state = Arc::new(AppState::new());

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .route("/health", web::get().to(health))
            .route("/order", web::post().to(submit_order))
            .route("/orderbook/{token_id}", web::get().to(get_orderbook))
    })
    .bind("127.0.0.1:3030")?
    .run()
    .await
}

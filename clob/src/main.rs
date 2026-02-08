//! # PolyBook Matching Engine
//!
//! Rust-based matching engine using orderbook-rs for the PolyBook prediction market.
//! Exposes a simple HTTP API for the TypeScript CLOB to call.

use actix_web::{web, App, HttpRequest, HttpResponse, HttpServer};
use actix_web_actors::ws;
use actix::prelude::*;
use dashmap::DashMap;
use orderbook_rs::{OrderBook, OrderId, Side as OBSide, TimeInForce, TradeResult as OBTradeResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;
use rand::seq::SliceRandom;
use tokio::sync::broadcast;


use alloy::sol;
use alloy_sol_types::{SolStruct};
use alloy::primitives::{Address, B256, U256};
use alloy::signers::local::PrivateKeySigner;
use alloy::network::EthereumWallet;
use alloy::providers::ProviderBuilder;
use alloy::signers::Signature;

// Critical constants that MUST be provided via environment


mod exchange {
    use alloy::sol;
    use serde::{Deserialize, Serialize};
    sol! {
        #[derive(Debug, Serialize, Deserialize)]
        enum Side { BUY, SELL }

        #[derive(Debug, Serialize, Deserialize)]
        enum SignatureType { EOA, POLY_PROXY, POLY_GNOSIS_SAFE, POLY_1271 }

        #[derive(Debug, Serialize, Deserialize)]
        struct Order {
            uint256 salt;
            address maker;
            address signer;
            address taker;
            uint256 tokenId;
            uint256 makerAmount;
            uint256 takerAmount;
            uint256 expiration;
            uint256 nonce;
            uint256 feeRateBps;
            uint8 side;
            uint8 signatureType;
            bytes signature;
        }

        #[sol(rpc)]
        contract ICTFExchange {
            function matchOrders(
                Order memory takerOrder,
                Order[] memory makerOrders,
                uint256 takerFillAmount,
                uint256[] memory makerFillAmounts
            ) external;
        }
    }
}

mod api_token; // Register the new module
mod api_market; // Register Market Registry

use exchange::{ICTFExchange, Order};
use api_market::{MarketMetadata, MarketOrderBookState, publish_market_orderbooks_for_token};

/// Order request from Client
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderRequest {
    /// Maker address
    pub maker: String,
    /// Token ID (as string to handle large numbers)
    pub token_id: String,
    /// Order side: BUY or SELL
    pub side: String,
    /// Price per token (6 decimal places, as string)
    pub price: String,
    /// Quantity (6 decimal places, as string)
    pub quantity: String,
    /// Order hash from EIP-712 signature (optional, we can recompute)
    pub order_hash: String,
    
    // Polymerket Signed Order Fields (required for on-chain execution)
    pub salt: String,
    pub signer: String,
    pub taker: String,
    pub maker_amount: String,
    pub taker_amount: String,
    pub expiration: String,
    pub nonce: String,
    pub fee_rate_bps: String,
    pub signature_type: u8,
    pub signature: String,
}

impl OrderRequest {
    pub fn to_sol_order(&self) -> Order {
        Order {
            salt: U256::from_str_radix(&self.salt, 10).unwrap_or_default(),
            maker: self.maker.parse().unwrap_or(Address::ZERO),
            signer: self.signer.parse().unwrap_or(Address::ZERO),
            taker: self.taker.parse().unwrap_or(Address::ZERO),
            tokenId: U256::from_str_radix(&self.token_id, 10).unwrap_or_default(),
            makerAmount: U256::from_str_radix(&self.maker_amount, 10).unwrap_or_default(),
            takerAmount: U256::from_str_radix(&self.taker_amount, 10).unwrap_or_default(),
            expiration: U256::from_str_radix(&self.expiration, 10).unwrap_or_default(),
            nonce: U256::from_str_radix(&self.nonce, 10).unwrap_or_default(),
            feeRateBps: U256::from_str_radix(&self.fee_rate_bps, 10).unwrap_or_default(),
            side: if self.side == "BUY" { 0 } else { 1 },
            signatureType: self.signature_type,
            signature: hex::decode(self.signature.trim_start_matches("0x")).unwrap_or_default().into(),
        }
    }
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
    pub(crate) order_books: RwLock<HashMap<String, OrderBook>>,
    // Map of order_hash -> order details
    orders: RwLock<HashMap<String, OrderRequest>>,
    // Map of order_id (from orderbook-rs) -> maker_address
    order_makers: DashMap<String, String>,
    // Map of order_id -> order_hash (for cancel lookup)
    order_id_to_hash: DashMap<String, String>,
    // Map of order_hash -> order_id (for cancel by hash)
    order_hash_to_id: DashMap<String, String>,
    // Store captured trades for a request (Key: taker_order_id, Value: List of trades)
    captured_trades: DashMap<String, Vec<TradeResult>>,
    // Trade history (all completed trades)
    trade_history: RwLock<Vec<TradeResult>>,
    // Relay channel
    relay_tx: tokio::sync::mpsc::Sender<RelayCommand>,
    // Helpers
    trade_counter: RwLock<u64>,
    // Market Registry
    pub(crate) markets: DashMap<String, MarketMetadata>,
    // Orderbook broadcast channels per token
    orderbook_txs: DashMap<String, broadcast::Sender<OrderBookState>>,
    // Orderbook broadcast channels per market
    pub(crate) market_orderbook_txs: DashMap<String, broadcast::Sender<MarketOrderBookState>>,
}

impl AppState {
    pub fn new(relay_tx: tokio::sync::mpsc::Sender<RelayCommand>) -> Self {
        Self {
            order_books: RwLock::new(HashMap::new()),
            orders: RwLock::new(HashMap::new()),
            order_makers: DashMap::new(),
            order_id_to_hash: DashMap::new(),
            order_hash_to_id: DashMap::new(),
            captured_trades: DashMap::new(),
            trade_history: RwLock::new(Vec::new()),
            relay_tx,
            trade_counter: RwLock::new(0),
            markets: DashMap::new(),
            orderbook_txs: DashMap::new(),
            market_orderbook_txs: DashMap::new(),
        }
    }
}

#[derive(Debug)]
pub enum RelayCommand {
    ExecuteMatch {
        taker_order: OrderRequest,
        maker_orders: Vec<OrderRequest>,
        taker_fill_amount: U256,
        maker_fill_amounts: Vec<U256>,
    },
}

pub fn build_orderbook_snapshot(order_books: &HashMap<String, OrderBook>, token_id: &str) -> OrderBookState {
    if let Some(book) = order_books.get(token_id) {
        let snapshot = book.create_snapshot(20);
        let bids = snapshot.bids.iter().map(|l| PriceLevel {
            price: l.price.to_string(),
            quantity: l.visible_quantity.to_string(),
            order_count: l.order_count as u32,
        }).collect();
        let asks = snapshot.asks.iter().map(|l| PriceLevel {
            price: l.price.to_string(),
            quantity: l.visible_quantity.to_string(),
            order_count: l.order_count as u32,
        }).collect();
        OrderBookState { token_id: token_id.to_string(), bids, asks }
    } else {
        OrderBookState { token_id: token_id.to_string(), bids: vec![], asks: vec![] }
    }
}

fn get_or_create_orderbook_tx(state: &AppState, token_id: &str) -> broadcast::Sender<OrderBookState> {
    if let Some(tx) = state.orderbook_txs.get(token_id) {
        return tx.value().clone();
    }
    let (tx, _rx) = broadcast::channel(64);
    state.orderbook_txs.insert(token_id.to_string(), tx.clone());
    tx
}

fn publish_orderbook(state: &AppState, token_id: &str) {
    let snapshot = {
        let order_books = state.order_books.read().unwrap();
        build_orderbook_snapshot(&order_books, token_id)
    };
    let tx = get_or_create_orderbook_tx(state, token_id);
    let _ = tx.send(snapshot);
}

#[derive(Message)]
#[rtype(result = "()")]
struct OrderbookText(String);

struct OrderbookWs {
    token_id: String,
    state: Arc<AppState>,
    tx: broadcast::Sender<OrderBookState>,
}

impl Actor for OrderbookWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let snapshot = {
            let order_books = self.state.order_books.read().unwrap();
            build_orderbook_snapshot(&order_books, &self.token_id)
        };
        if let Ok(text) = serde_json::to_string(&snapshot) {
            ctx.text(text);
        }

        let mut rx = self.tx.subscribe();
        let addr = ctx.address();
        actix_rt::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(snapshot) => {
                        if let Ok(text) = serde_json::to_string(&snapshot) {
                            addr.do_send(OrderbookText(text));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

impl Handler<OrderbookText> for OrderbookWs {
    type Result = ();
    fn handle(&mut self, msg: OrderbookText, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for OrderbookWs {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => ctx.pong(&msg),
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            Ok(ws::Message::Text(_)) => {}
            Ok(ws::Message::Binary(_)) => {}
            _ => {}
        }
    }
}

async fn orderbook_ws(
    data: web::Data<Arc<AppState>>,
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
) -> Result<HttpResponse, actix_web::Error> {
    let token_id = path.into_inner();
    let tx = get_or_create_orderbook_tx(&data, &token_id);
    let ws = OrderbookWs { token_id, state: data.get_ref().clone(), tx };
    ws::start(ws, &req, stream)
}



/// EIP-712 hashing and verification
use alloy_sol_types::Eip712Domain;

pub fn get_domain_separator(chain_id: u64, verifying_contract: Address) -> B256 {
    let domain = Eip712Domain {
        name: Some("Polymarket CTF Exchange".to_string().into()),
        version: Some("1".to_string().into()),
        chain_id: Some(U256::from(chain_id)),
        verifying_contract: Some(verifying_contract),
        salt: None,
    };
    domain.separator() 
}

pub fn verify_order_signature(order_req: &OrderRequest, domain_separator: B256) -> bool {
    // We define a local struct named 'Order' to match the EIP-712 type name used by the TS client.
    sol! {
        struct Order {
            uint256 salt;
            address maker;
            address signer;
            address taker;
            uint256 tokenId;
            uint256 makerAmount;
            uint256 takerAmount;
            uint256 expiration;
            uint256 nonce;
            uint256 feeRateBps;
            uint8 side;
            uint8 signatureType;
        }
    }

    let order = order_req.to_sol_order();
    
    let h_order = Order {
        salt: order.salt,
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        expiration: order.expiration,
        nonce: order.nonce,
        feeRateBps: order.feeRateBps,
        side: order.side,
        signatureType: order.signatureType,
    };

    let struct_hash = h_order.eip712_hash_struct();
    
    let mut encoded = Vec::new();
    encoded.extend_from_slice(b"\x19\x01");
    encoded.extend_from_slice(domain_separator.as_slice());
    encoded.extend_from_slice(struct_hash.as_slice());
    let typed_data_hash = B256::from(alloy::primitives::keccak256(&encoded));

    if let Ok(sig) = Signature::try_from(order.signature.as_ref()) {
        if let Ok(recovered) = sig.recover_address_from_prehash(&typed_data_hash) {
            return recovered == order.signer;
        }
    }
    false
}

/// Relay Worker: Background thread that executes trades on-chain
async fn relay_worker(mut rx: tokio::sync::mpsc::Receiver<RelayCommand>) {
    info!("Relay Worker started");
    
    // Load config from environment or defaults
    let rpc_env = std::env::var("RPC_URL").expect("RPC_URL not set");
    let rpc_urls: Vec<&str> = rpc_env.split(',').collect();
    // Simple random selection at startup
    let rpc_url = *rpc_urls.choose(&mut rand::thread_rng()).expect("RPC_URL must not be empty");

    let private_key = std::env::var("OPERATOR_PRIVATE_KEY")
        .or_else(|_| std::env::var("DEPLOYER_PRIVATE_KEY"))
        .expect("OPERATOR_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY not set"); 
    let exchange_addr: Address = std::env::var("EXCHANGE_ADDRESS")
        .or_else(|_| std::env::var("EXCHANGE_ADDR"))
        .expect("EXCHANGE_ADDRESS not set")
        .parse().expect("Invalid Exchange Address");

    let signer: PrivateKeySigner = private_key.parse().expect("Invalid private key");
    let wallet = EthereumWallet::from(signer);
    
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url.parse().unwrap());

    while let Some(cmd) = rx.recv().await {
        match cmd {
            RelayCommand::ExecuteMatch { taker_order, maker_orders, taker_fill_amount, maker_fill_amounts } => {
                info!("[Relay] Executing match on-chain...");
                
                let sol_taker = taker_order.to_sol_order();
                let sol_makers: Vec<Order> = maker_orders.iter().map(|m| m.to_sol_order()).collect();
                
                let contract = ICTFExchange::new(exchange_addr, provider.clone());
                
                match contract.matchOrders(sol_taker, sol_makers, taker_fill_amount, maker_fill_amounts)
                    .gas_price(10_000_000_000) // 10 Gwei
                    .send().await {
                        Ok(_) => {
                            info!("[Relay] Match submitted successfully (Gas: 10 Gwei)");
                        },
                        Err(e) => {
                            info!("[Relay] Match execution failed: {:?}", e);
                        }
                    }
            }
        }
    }
}

/// Health check endpoint
async fn health() -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({
        "status": "healthy",
        "engine": "polybook-matcher-rust",
        "version": "0.2.0"
    }))
}

/// Get order details by hash
async fn get_order(
    data: web::Data<Arc<AppState>>,
    path: web::Path<String>,
) -> HttpResponse {
    let order_hash = path.into_inner();
    let orders = data.orders.read().unwrap();
    
    if let Some(order) = orders.get(&order_hash) {
        HttpResponse::Ok().json(order)
    } else {
        HttpResponse::NotFound().json(serde_json::json!({ "error": "Order not found" }))
    }
}

/// Submit an order to the matching engine
async fn submit_order(
    data: web::Data<Arc<AppState>>,
    order: web::Json<OrderRequest>,
) -> HttpResponse {
    let req = order.into_inner();
    info!("Received order: {:?}", req);

    // 1. Verify Signature
    let chain_id = std::env::var("CHAIN_ID").expect("CHAIN_ID not set").parse::<u64>().expect("CHAIN_ID must be a number");
    let exchange_addr_str = std::env::var("EXCHANGE_ADDRESS")
        .or_else(|_| std::env::var("EXCHANGE_ADDR"))
        .expect("EXCHANGE_ADDRESS not set");
    let exchange_addr: Address = exchange_addr_str.parse().expect("Invalid Exchange Address");
    let domain_sep = get_domain_separator(chain_id, exchange_addr);
    
    info!("Verifying signature against Exchange: {:?}", exchange_addr);
    if !verify_order_signature(&req, domain_sep) {
        return HttpResponse::BadRequest().json(OrderResponse {
            success: false,
            order_id: None,
            trades: vec![],
            error: Some("Invalid EIP-712 signature".to_string()),
        });
    }
    info!("Signature verified successfully");

    let token_id = req.token_id.clone();
    let order_hash = req.order_hash.clone();

    // Store the order request details (by hash)
    {
        let mut orders = data.orders.write().unwrap();
        orders.insert(order_hash.clone(), req.clone());
    }

    let state_for_listener = data.clone();
    let token_id_for_listener = token_id.clone();
    
    let trade_listener = Arc::new(move |trade_result: &OBTradeResult| {
        let match_result = &trade_result.match_result;
        let taker_order_id = match_result.order_id.to_string();
        
        for tx in match_result.transactions.as_vec() {
            let maker_order_id = tx.maker_order_id.to_string();
            let counter_val = {
                let mut c = state_for_listener.trade_counter.write().unwrap();
                *c += 1;
                *c
            };
            let trade_id = format!("trade-{}", counter_val);
            
            let trade = TradeResult {
                trade_id,
                buyer: "pending".to_string(),
                seller: "pending".to_string(),
                token_id: token_id_for_listener.clone(),
                price: tx.price.to_string(),
                quantity: tx.quantity.to_string(),
                taker_order_hash: taker_order_id.clone(), 
                maker_order_hashes: vec![maker_order_id],
                maker_fill_amounts: vec![tx.quantity.to_string()],
            };
            
            state_for_listener.captured_trades.entry(taker_order_id.clone())
                .or_insert_with(Vec::new)
                .push(trade);
        }
    });

    let result = {
        let mut order_books = data.order_books.write().unwrap();
        let book = order_books
            .entry(token_id.clone())
            .or_insert_with(|| OrderBook::with_trade_listener(&token_id, trade_listener));

        let price: u128 = req.price.parse().unwrap_or(0);
        let quantity: u64 = req.quantity.parse().unwrap_or(0);

        let order_id = OrderId::new_uuid();
        let order_id_str = order_id.to_string();

        data.order_makers.insert(order_id_str.clone(), req.maker.clone());
        data.order_id_to_hash.insert(order_id_str.clone(), order_hash.clone());
        data.order_hash_to_id.insert(order_hash.clone(), order_id_str.clone());

        let side = if req.side == "BUY" { OBSide::Buy } else { OBSide::Sell };

        match book.add_limit_order(order_id, price, quantity, side, TimeInForce::Gtc, None) {
            Ok(ob_order) => {
                info!("Order {} added", ob_order.id());

                let captured = data.captured_trades.remove(&order_id_str).map(|(_, v)| v).unwrap_or_default();
                
                let mut processed_trades = Vec::new();
                for mut t in captured {
                    t.taker_order_hash = order_hash.clone();
                    let is_taker_buy = req.side == "BUY";
                    
                    let maker_uuid = t.maker_order_hashes[0].clone();
                    let maker_addr = data.order_makers.get(&maker_uuid)
                        .map(|v| v.value().clone())
                        .unwrap_or_else(|| "unknown".to_string());
                    
                    if is_taker_buy {
                        t.buyer = req.maker.clone();
                        t.seller = maker_addr;
                    } else {
                        t.buyer = maker_addr;
                        t.seller = req.maker.clone();
                    }

                    let maker_req = if let Some(h) = data.order_id_to_hash.get(&maker_uuid) {
                        data.orders.read().unwrap().get(h.value()).cloned()
                    } else {
                        None
                    };

                    if let Some(m_req) = maker_req {
                        t.maker_order_hashes[0] = m_req.order_hash.clone();
                        processed_trades.push(t);

                        // Send to Relay
                        let last_trade = processed_trades.last().unwrap();
                        let quantity_bi = U256::from_str_radix(&last_trade.quantity, 10).unwrap_or_default();
                        let price_bi = U256::from_str_radix(&last_trade.price, 10).unwrap_or_default();
                        
                        let taker_fill: U256;
                        let maker_fill: U256;
                        
                        if is_taker_buy {
                            taker_fill = (quantity_bi * price_bi) / U256::from(1_000_000);
                            maker_fill = quantity_bi;
                        } else {
                            taker_fill = quantity_bi;
                            maker_fill = (quantity_bi * price_bi) / U256::from(1_000_000);
                        }

                        let _ = data.relay_tx.try_send(RelayCommand::ExecuteMatch {
                            taker_order: req.clone(),
                            maker_orders: vec![m_req],
                            taker_fill_amount: taker_fill,
                            maker_fill_amounts: vec![maker_fill],
                        });
                    }
                }

                {
                    let mut history = data.trade_history.write().unwrap();
                    history.extend(processed_trades.clone());
                }

                Ok((order_id_str, processed_trades))
            }
            Err(e) => Err(e),
        }
    };

    match result {
        Ok((order_id_str, processed_trades)) => {
            publish_orderbook(&data, &token_id);
            publish_market_orderbooks_for_token(&data, &token_id);
            HttpResponse::Ok().json(OrderResponse {
                success: true,
                order_id: Some(order_id_str),
                trades: processed_trades,
                error: None,
            })
        }
        Err(e) => {
            HttpResponse::BadRequest().json(OrderResponse {
                success: false, order_id: None, trades: vec![], error: Some(format!("{:?}", e))
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
    let snapshot = build_orderbook_snapshot(&order_books, &token_id);
    HttpResponse::Ok().json(snapshot)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelRequest { pub order_hash: String, pub token_id: String }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CancelResponse { pub success: bool, pub message: String }

async fn cancel_order(
    data: web::Data<Arc<AppState>>,
    req: web::Json<CancelRequest>,
) -> HttpResponse {
    let order_hash = req.order_hash.clone();
    let token_id = req.token_id.clone();
    
    let order_id_str = match data.order_hash_to_id.get(&order_hash) {
        Some(id) => id.value().clone(),
        None => return HttpResponse::NotFound().json(CancelResponse { success: false, message: "Not found".into() }),
    };

    let order_id = order_id_str.parse::<OrderId>().unwrap();
    let result = {
        let mut order_books = data.order_books.write().unwrap();
        if let Some(book) = order_books.get_mut(&token_id) {
            match book.cancel_order(order_id) {
                Ok(_) => {
                    data.order_hash_to_id.remove(&order_hash);
                    data.order_id_to_hash.remove(&order_id_str);
                    data.order_makers.remove(&order_id_str);
                    data.orders.write().unwrap().remove(&order_hash);
                    Ok(())
                }
                Err(e) => Err(format!("{:?}", e)),
            }
        } else {
            Err("No book".into())
        }
    };

    match result {
        Ok(_) => {
            publish_orderbook(&data, &token_id);
            publish_market_orderbooks_for_token(&data, &token_id);
            HttpResponse::Ok().json(CancelResponse { success: true, message: "Cancelled".into() })
        }
        Err(e) => HttpResponse::BadRequest().json(CancelResponse { success: false, message: e }),
    }
}

async fn get_trades(
    data: web::Data<Arc<AppState>>,
    query: web::Query<TradesQuery>,
) -> HttpResponse {
    let limit = query.limit.unwrap_or(100).min(1000);
    let history = data.trade_history.read().unwrap();
    let trades: Vec<TradeResult> = history.iter().rev().take(limit).cloned().collect();
    HttpResponse::Ok().json(serde_json::json!({ "trades": trades, "count": trades.len() }))
}

#[derive(Debug, Deserialize)]
pub struct TradesQuery { pub limit: Option<usize> }

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    if dotenv::dotenv().is_err() {
        let mut path = std::env::current_dir().unwrap();
        path.pop();
        path.push(".env");
        dotenv::from_path(path).ok();
    }
    let subscriber = FmtSubscriber::builder().with_max_level(Level::INFO).finish();
    tracing::subscriber::set_global_default(subscriber).ok();

    info!("Starting PolyBook Rust CLOB on port 3030...");
    info!("Websockets enabled at /ws/orderbook/{{token_id}}");
    info!("Websockets enabled at /ws/orderbook/market/{{market_id}}");

    let (tx, rx) = tokio::sync::mpsc::channel(100);
    let state = Arc::new(AppState::new(tx));

    // Start Relay Worker
    tokio::spawn(relay_worker(rx));

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(state.clone()))
            .route("/health", web::get().to(health))
            .route("/order", web::post().to(submit_order))
            .route("/order/cancel", web::post().to(cancel_order))
            .route("/order/{order_hash}", web::get().to(get_order))
            .route("/orderbook/{token_id}", web::get().to(get_orderbook))
            .route("/orderbook/market/{market_id}", web::get().to(api_market::get_market_orderbook))
            .route("/ws/orderbook/{token_id}", web::get().to(orderbook_ws))
            .route("/ws/orderbook/market/{market_id}", web::get().to(api_market::market_orderbook_ws))
            .route("/trades", web::get().to(get_trades))
            // Token Operations
            .route("/mint-dummy", web::post().to(api_token::mint_dummy))
            // Market Registry
            // Market Registry
            .route("/markets", web::get().to(api_market::get_markets))
            .route("/admin/create-market", web::post().to(api_market::create_market))
            .route("/admin/import-market", web::post().to(api_market::import_market))
            .route("/admin/update-status", web::post().to(api_market::update_market_status))
    })
    .bind("0.0.0.0:3030")?
    .run()
    .await
}

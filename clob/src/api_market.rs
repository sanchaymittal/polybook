use actix_web::{web, HttpRequest, HttpResponse};
use actix_web_actors::ws;
use actix::prelude::*;
use serde::{Deserialize, Serialize};
use alloy::sol;
use alloy::primitives::{Address, U256, FixedBytes, Keccak256};
use alloy::network::EthereumWallet;
use alloy::providers::ProviderBuilder;
use alloy::signers::local::PrivateKeySigner;
use tracing::{info, error};
use std::sync::Arc;
use crate::{AppState, OrderBookState};
use tokio::sync::broadcast;

// --- Data Structures ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketMetadata {
    pub market_id: String,
    pub slug: String,
    pub question: String,
    pub question_id: String,
    pub condition_id: String,
    pub yes_token_id: String,
    pub no_token_id: String,
    pub status: String, // ACTIVE, RESOLVED, PAUSED
    pub active: bool, // keeping for backward compat
    pub payout_result: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketOrderBookState {
    pub market_id: String,
    pub yes: OrderBookState,
    pub no: OrderBookState,
}

#[derive(Debug, Deserialize)]
pub struct CreateMarketRequest {
    pub slug: String,
    pub question: String,
    pub starting_price: Option<f64>,
}

#[derive(Debug, Deserialize)]
pub struct ImportMarketRequest {
    pub slug: String,
    pub question: String,
    pub question_id: String,
    pub condition_id: String,
    pub yes_token_id: String,
    pub no_token_id: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateStatusRequest {
    pub market_id: String,
    pub status: String, // ACTIVE, RESOLVED
    pub result: Option<bool>,
}

#[derive(Serialize)]
pub struct CreateMarketResponse {
    pub success: bool,
    pub market_id: Option<String>,
    pub market: Option<MarketMetadata>,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct GetMarketsResponse {
    pub markets: Vec<MarketMetadata>,
}

#[derive(Deserialize)]
pub struct GetMarketsQuery {
    pub status: Option<String>,
}

// --- Contracts ---
sol! {
    #[sol(rpc)]
    contract ICTF {
        function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external;
        function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
        function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32);
        function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256);
    }
}

// --- Handlers ---

/// POST /admin/create-market
pub async fn create_market(
    data: web::Data<Arc<AppState>>,
    req: web::Json<CreateMarketRequest>,
) -> HttpResponse {
    let slug = req.slug.clone();
    
    // Check if exists
    if let Some(m) = data.markets.iter().find(|m| m.slug == slug) {
         return HttpResponse::Ok().json(CreateMarketResponse {
            success: true,
            market_id: Some(m.market_id.clone()),
            market: Some(m.clone()),
            error: None,
        });
    }

    // 1. Setup Provider
    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
    let pk = match std::env::var("DEPLOYER_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => return HttpResponse::InternalServerError().json(CreateMarketResponse { success: false, market_id: None, market: None, error: Some("Missing DEPLOYER_PRIVATE_KEY".into()) }),
    };

    let signer: PrivateKeySigner = pk.parse().unwrap();
    let wallet = EthereumWallet::from(signer);
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url.parse().unwrap());

    // 2. Compute IDs
    use alloy::primitives::keccak256;
    let question_id = keccak256(slug.as_bytes());
    
    let oracle_addr: Address = std::env::var("ADAPTER_ADDRESS").expect("ADAPTER_ADDRESS set").parse().unwrap();
    let ctf_addr: Address = std::env::var("CTF_ADDRESS").expect("CTF set").parse().unwrap();
    let usdc_addr: Address = std::env::var("USDC_ADDRESS").expect("USDC_ADDRESS set").parse().unwrap();

    let ctf = ICTF::new(ctf_addr, provider.clone());

    // Prepare Condition
    match ctf.prepareCondition(oracle_addr, question_id, U256::from(2)).send().await {
        Ok(p) => { 
            let _ = p.watch().await; 
        },
        Err(e) => info!("Prepare failed (may be already prep): {:?}", e),
    }

    // Calc Condition ID off-chain
    let mut hasher = Keccak256::new();
    hasher.update(oracle_addr.as_slice());
    hasher.update(question_id.as_slice());
    hasher.update(U256::from(2).to_be_bytes::<32>());
    let condition_id: FixedBytes<32> = hasher.finalize();

    // 3. Compute Token IDs (YES/NO)
    let parent_collection_id = FixedBytes::<32>::ZERO;
    
    // Explicit type checks/waits
    let c1 = ctf.getCollectionId(parent_collection_id, condition_id, U256::from(1))
        .call().await
        .map_err(|e| {
            error!("Failed to get collection ID 1: {:?}", e);
            HttpResponse::InternalServerError().json(CreateMarketResponse { success: false, market_id: None, market: None, error: Some(format!("Contract Call Failed: {:?}", e)) })
        });

    let c1 = match c1 {
        Ok(v) => v._0,
        Err(r) => return r,
    };
        
    let c2 = ctf.getCollectionId(parent_collection_id, condition_id, U256::from(2))
        .call().await
        .map_err(|e| {
            error!("Failed to get collection ID 2: {:?}", e);
            HttpResponse::InternalServerError().json(CreateMarketResponse { success: false, market_id: None, market: None, error: Some(format!("Contract Call Failed: {:?}", e)) })
        });

    let c2 = match c2 {
        Ok(v) => v._0,
        Err(r) => return r,
    };
    
    let yes_token_id_u256 = ctf.getPositionId(usdc_addr, c1).call().await
        .map_err(|e| {
             error!("Failed to get YES token ID: {:?}", e);
             HttpResponse::InternalServerError().json(CreateMarketResponse { success: false, market_id: None, market: None, error: Some(format!("Contract Call Failed: {:?}", e)) })
        });
    let yes_token_id_u256 = match yes_token_id_u256 {
        Ok(v) => v._0,
        Err(r) => return r,
    };


    let no_token_id_u256 = ctf.getPositionId(usdc_addr, c2).call().await
        .map_err(|e| {
             error!("Failed to get NO token ID: {:?}", e);
             HttpResponse::InternalServerError().json(CreateMarketResponse { success: false, market_id: None, market: None, error: Some(format!("Contract Call Failed: {:?}", e)) })
        });
    let no_token_id_u256 = match no_token_id_u256 {
        Ok(v) => v._0,
        Err(r) => return r,
    };

    // 4. Register Market
    let market_id = format!("0x{:x}", condition_id);
    
    let metadata = MarketMetadata {
        market_id: market_id.clone(),
        slug: slug.clone(),
        question: req.question.clone(),
        question_id: format!("0x{:x}", question_id),
        condition_id: format!("0x{:x}", condition_id),
        yes_token_id: yes_token_id_u256.to_string(),
        no_token_id: no_token_id_u256.to_string(),
        status: "ACTIVE".to_string(),
        active: true,
        payout_result: None,
    };

    data.markets.insert(market_id.clone(), metadata.clone());

    HttpResponse::Ok().json(CreateMarketResponse {
        success: true,
        market_id: Some(market_id),
        market: Some(metadata),
        error: None,
    })
}

/// POST /admin/import-market
pub async fn import_market(
    data: web::Data<Arc<AppState>>,
    req: web::Json<ImportMarketRequest>,
) -> HttpResponse {
    let slug = req.slug.clone();
    
    // Check if exists
    if let Some(m) = data.markets.iter().find(|m| m.slug == slug) {
         return HttpResponse::Ok().json(CreateMarketResponse {
            success: true,
            market_id: Some(m.market_id.clone()),
            market: Some(m.clone()),
            error: None,
        });
    }

    let market_id = req.condition_id.clone();
    
    let metadata = MarketMetadata {
        market_id: market_id.clone(),
        slug: slug.clone(),
        question: req.question.clone(),
        question_id: req.question_id.clone(),
        condition_id: req.condition_id.clone(),
        yes_token_id: req.yes_token_id.clone(),
        no_token_id: req.no_token_id.clone(),
        status: "ACTIVE".to_string(),
        active: true,
        payout_result: None,
    };

    data.markets.insert(market_id.clone(), metadata.clone());
    info!("Imported external market: {} ({})", slug, market_id);

    HttpResponse::Ok().json(CreateMarketResponse {
        success: true,
        market_id: Some(market_id),
        market: Some(metadata),
        error: None,
    })
}

/// POST /admin/update-status
pub async fn update_market_status(
    data: web::Data<Arc<AppState>>,
    req: web::Json<UpdateStatusRequest>,
) -> HttpResponse {
    if let Some(mut m) = data.markets.get_mut(&req.market_id) {
        m.status = req.status.clone();
        m.active = req.status == "ACTIVE";
        m.payout_result = req.result;
        info!("Updated market {} status to {} (result: {:?})", req.market_id, req.status, req.result);
        HttpResponse::Ok().json(serde_json::json!({ "success": true }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({ "success": false, "error": "Market not found" }))
    }
}

/// GET /markets
/// Optional query param: ?status=ACTIVE|RESOLVED
pub async fn get_markets(
    data: web::Data<Arc<AppState>>,
    query: web::Query<GetMarketsQuery>,
) -> HttpResponse {
    let markets: Vec<MarketMetadata> = data.markets.iter()
        .filter(|m| {
            if let Some(s) = &query.status {
                m.status.to_uppercase() == s.to_uppercase()
            } else {
                true 
            }
        })
        .map(|kv| kv.value().clone())
        .collect();
    HttpResponse::Ok().json(GetMarketsResponse { markets })
}

/// GET /orderbook/market/{market_id}
pub async fn get_market_orderbook(
    data: web::Data<Arc<AppState>>,
    path: web::Path<String>,
) -> HttpResponse {
    let market_id = path.into_inner();
    
    if let Some(market) = data.markets.get(&market_id) {
        let order_books = data.order_books.read().unwrap();
        let yes_snapshot = crate::build_orderbook_snapshot(&order_books, &market.yes_token_id);
        let no_snapshot = crate::build_orderbook_snapshot(&order_books, &market.no_token_id);
        
        HttpResponse::Ok().json(serde_json::json!({
            "market_id": market_id,
            "yes": yes_snapshot,
            "no": no_snapshot,
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({ "error": "Market not found" }))
    }
}

fn build_market_orderbook_snapshot(state: &AppState, market_id: &str) -> Option<MarketOrderBookState> {
    let market = state.markets.get(market_id)?;
    let order_books = state.order_books.read().unwrap();
    let yes = crate::build_orderbook_snapshot(&order_books, &market.yes_token_id);
    let no = crate::build_orderbook_snapshot(&order_books, &market.no_token_id);
    Some(MarketOrderBookState { market_id: market_id.to_string(), yes, no })
}

fn get_or_create_market_orderbook_tx(state: &AppState, market_id: &str) -> broadcast::Sender<MarketOrderBookState> {
    if let Some(tx) = state.market_orderbook_txs.get(market_id) {
        return tx.value().clone();
    }
    let (tx, _rx) = broadcast::channel(64);
    state.market_orderbook_txs.insert(market_id.to_string(), tx.clone());
    tx
}

fn publish_market_orderbook(state: &AppState, market_id: &str) {
    if let Some(snapshot) = build_market_orderbook_snapshot(state, market_id) {
        let tx = get_or_create_market_orderbook_tx(state, market_id);
        let _ = tx.send(snapshot);
    }
}

pub fn publish_market_orderbooks_for_token(state: &AppState, token_id: &str) {
    for m in state.markets.iter() {
        if m.yes_token_id == token_id || m.no_token_id == token_id {
            publish_market_orderbook(state, &m.market_id);
        }
    }
}

#[derive(Message)]
#[rtype(result = "()")]
struct MarketOrderbookText(String);

struct MarketOrderbookWs {
    market_id: String,
    state: Arc<AppState>,
    tx: broadcast::Sender<MarketOrderBookState>,
}

impl Actor for MarketOrderbookWs {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        if let Some(snapshot) = build_market_orderbook_snapshot(&self.state, &self.market_id) {
            if let Ok(text) = serde_json::to_string(&snapshot) {
                ctx.text(text);
            }
        }

        let mut rx = self.tx.subscribe();
        let addr = ctx.address();
        actix_rt::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(snapshot) => {
                        if let Ok(text) = serde_json::to_string(&snapshot) {
                            addr.do_send(MarketOrderbookText(text));
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }
}

impl Handler<MarketOrderbookText> for MarketOrderbookWs {
    type Result = ();
    fn handle(&mut self, msg: MarketOrderbookText, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for MarketOrderbookWs {
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

pub async fn market_orderbook_ws(
    data: web::Data<Arc<AppState>>,
    req: HttpRequest,
    stream: web::Payload,
    path: web::Path<String>,
) -> Result<HttpResponse, actix_web::Error> {
    let market_id = path.into_inner();
    let tx = get_or_create_market_orderbook_tx(&data, &market_id);
    let ws = MarketOrderbookWs { market_id, state: data.get_ref().clone(), tx };
    ws::start(ws, &req, stream)
}

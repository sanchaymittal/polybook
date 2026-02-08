use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use alloy::sol;
use alloy::primitives::{Address, U256};
use alloy::network::EthereumWallet;
use alloy::providers::{ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;

// --- Contracts ---
sol! {
    #[sol(rpc)]
    contract IERC20 {
        function mint(address to, uint256 amount) external;
        function transfer(address to, uint256 amount) external returns (bool);
        function transferFrom(address from, address to, uint256 amount) external returns (bool);
        function approve(address spender, uint256 amount) external returns (bool);
    }

    #[sol(rpc)]
    contract ICTF {
        function splitPosition(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata partition,
            uint256 amount
        ) external;

        function mergePositions(
            address collateralToken,
            bytes32 parentCollectionId,
            bytes32 conditionId,
            uint256[] calldata partition,
            uint256 amount
        ) external;

        function safeBatchTransferFrom(
            address from,
            address to,
            uint256[] calldata ids,
            uint256[] calldata values,
            bytes calldata data
        ) external;
        
        function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32);
        function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256);
        function prepareCondition(address oracle, bytes32 questionId, uint256 outcomeSlotCount) external;
        function getOutcomeSlotCount(bytes32 conditionId) external view returns (uint256);
    }
}

// --- Requests ---

#[derive(Debug, Deserialize)]
pub struct MintRequest {
    pub address: String,
    pub amount: String,
}

#[derive(Serialize)]
pub struct TxResponse {
    pub success: bool,
    pub tx_hash: Option<String>,
    pub error: Option<String>,
}

// --- Handlers ---

/// POST /mint-dummy
pub async fn mint_dummy(req: web::Json<MintRequest>) -> HttpResponse {
    let rpc_env = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
    let rpc_urls: Vec<&str> = rpc_env.split(',').collect();
    use rand::seq::SliceRandom;
    let rpc_url = *rpc_urls.choose(&mut rand::thread_rng()).expect("RPC_URL must not be empty");

    let pk = match std::env::var("DEPLOYER_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some("Missing DEPLOYER_PRIVATE_KEY".into()) }),
    };

    let signer: PrivateKeySigner = pk.parse().unwrap();
    let wallet = EthereumWallet::from(signer);
    
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url.parse().unwrap());

    let usdc_addr: Address = std::env::var("USDC_ADDRESS")
        .unwrap_or_else(|_| "0x5fbdb2315678afecb367f032d93f642f64180aa3".to_string())
        .parse()
        .unwrap();

    let contract = IERC20::new(usdc_addr, provider);
    let to_addr: Address = req.address.parse().unwrap();
    let amount = U256::from_str_radix(&req.amount, 10).unwrap_or_default();

    match contract.mint(to_addr, amount).send().await {
        Ok(builder) => {
            // Return immediately with tx hash, don't wait for confirmation
            let tx_hash = *builder.tx_hash();
            HttpResponse::Ok().json(TxResponse { 
                success: true, 
                tx_hash: Some(format!("{:?}", tx_hash)), 
                error: None 
            })
        }
        Err(e) => HttpResponse::InternalServerError().json(TxResponse { 
            success: false, 
            tx_hash: None, 
            error: Some(format!("{:?}", e)) 
        })
    }
}

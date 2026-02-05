use actix_web::{web, HttpResponse};
use serde::{Deserialize, Serialize};
use alloy::sol;
use alloy::primitives::{Address, U256, FixedBytes};
use alloy::network::EthereumWallet;
use alloy::providers::{Provider, ProviderBuilder};
use alloy::signers::local::PrivateKeySigner;
use tracing::{info, error};
use std::str::FromStr;

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

#[derive(Debug, Deserialize)]
pub struct PositionRequest {
    pub owner: String,
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
    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
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
            let hash = builder.watch().await.unwrap();
            HttpResponse::Ok().json(TxResponse { success: true, tx_hash: Some(hash.to_string()), error: None })
        }
        Err(e) => HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("{:?}", e)) })
    }
}

/// POST /split-position
pub async fn split_position(req: web::Json<PositionRequest>) -> HttpResponse {
    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
    let pk = match std::env::var("RELAYER_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some("Missing RELAYER_PRIVATE_KEY".into()) }),
    };

    let signer: PrivateKeySigner = pk.parse().unwrap();
    let relayer_addr = signer.address();
    let wallet = EthereumWallet::from(signer);
    
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url.parse().unwrap());

    let owner_addr: Address = req.owner.parse().unwrap();
    let amount = U256::from_str_radix(&req.amount, 10).unwrap_or_default();
    
    let usdc_addr: Address = std::env::var("USDC_ADDRESS").unwrap().parse().unwrap();
    let ctf_addr: Address = std::env::var("CTF_ADDRESS").unwrap().parse().unwrap();
    let condition_id: FixedBytes<32> = std::env::var("CONDITION_ID").unwrap().parse().unwrap();
    
    let usdc = IERC20::new(usdc_addr, provider.clone());
    let ctf = ICTF::new(ctf_addr, provider.clone());

    // 0. Ensure Condition Prepared
    let question_id: FixedBytes<32> = std::env::var("QUESTION_ID").expect("QUESTION_ID set").parse().unwrap();
    let oracle_addr: Address = std::env::var("ORACLE_ADDRESS").expect("ORACLE set").parse().unwrap();
    
    // Check if prepared
    let slots = ctf.getOutcomeSlotCount(condition_id).call().await.unwrap()._0;
    if slots == U256::ZERO {
        info!("Condition not prepared. Preparing...");
        match ctf.prepareCondition(oracle_addr, question_id, U256::from(2)).send().await {
            Ok(p) => { let _ = p.watch().await; },
            Err(e) => info!("Prepare failed (might be race): {:?}", e), // Continue to try split
        }
    }

    // 1. TransferFrom Owner -> Relayer
    match usdc.transferFrom(owner_addr, relayer_addr, amount).send().await {
        Ok(p) => { let _ = p.watch().await; },
        Err(e) => return HttpResponse::BadRequest().json(TxResponse { success: false, tx_hash: None, error: Some(format!("TransferFrom: {:?}", e)) }),
    };

    // 2. Approve CTF
    match usdc.approve(ctf_addr, amount).send().await {
        Ok(p) => { let _ = p.watch().await; },
        Err(e) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("Approve: {:?}", e)) }),
    };

    // 3. Split
    let partition = vec![U256::from(1), U256::from(2)];
    match ctf.splitPosition(usdc_addr, FixedBytes::ZERO, condition_id, partition.clone(), amount).send().await {
         Ok(p) => { let _ = p.watch().await; },
         Err(e) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("Split: {:?}", e)) }),
    };

    // 4. Send Tokens Back
    let ids = vec![
        ctf.getPositionId(usdc_addr, ctf.getCollectionId(FixedBytes::ZERO, condition_id, U256::from(1)).call().await.unwrap()._0).call().await.unwrap()._0,
        ctf.getPositionId(usdc_addr, ctf.getCollectionId(FixedBytes::ZERO, condition_id, U256::from(2)).call().await.unwrap()._0).call().await.unwrap()._0,
    ];
    let amounts = vec![amount, amount];

    match ctf.safeBatchTransferFrom(relayer_addr, owner_addr, ids, amounts, alloy::primitives::Bytes::default()).send().await {
        Ok(p) => {
            let hash = p.watch().await.unwrap();
            HttpResponse::Ok().json(TxResponse { success: true, tx_hash: Some(hash.to_string()), error: None })
        },
        Err(e) => HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("BatchTransfer: {:?}", e)) }),
    }
}

/// POST /merge-position
pub async fn merge_position(req: web::Json<PositionRequest>) -> HttpResponse {
    let rpc_url = std::env::var("RPC_URL").unwrap_or_else(|_| "http://127.0.0.1:8545".to_string());
    let pk = match std::env::var("RELAYER_PRIVATE_KEY") {
        Ok(k) => k,
        Err(_) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some("Missing RELAYER_PRIVATE_KEY".into()) }),
    };

    let signer: PrivateKeySigner = pk.parse().unwrap();
    let relayer_addr = signer.address();
    let wallet = EthereumWallet::from(signer);
    
    let provider = ProviderBuilder::new()
        .with_recommended_fillers()
        .wallet(wallet)
        .on_http(rpc_url.parse().unwrap());

    let owner_addr: Address = req.owner.parse().unwrap();
    let amount = U256::from_str_radix(&req.amount, 10).unwrap_or_default();
    
    let usdc_addr: Address = std::env::var("USDC_ADDRESS").unwrap().parse().unwrap();
    let ctf_addr: Address = std::env::var("CTF_ADDRESS").unwrap().parse().unwrap();
    let condition_id: FixedBytes<32> = std::env::var("CONDITION_ID").unwrap().parse().unwrap();
    
    let usdc = IERC20::new(usdc_addr, provider.clone());
    let ctf = ICTF::new(ctf_addr, provider.clone());

    // 1. Calculate IDs
    let c1 = ctf.getCollectionId(FixedBytes::ZERO, condition_id, U256::from(1)).call().await.unwrap()._0;
    let c2 = ctf.getCollectionId(FixedBytes::ZERO, condition_id, U256::from(2)).call().await.unwrap()._0;
    let id1 = ctf.getPositionId(usdc_addr, c1).call().await.unwrap()._0;
    let id2 = ctf.getPositionId(usdc_addr, c2).call().await.unwrap()._0;

    // 2. Pull tokens (Owner must has approved Relayer)
    match ctf.safeBatchTransferFrom(owner_addr, relayer_addr, vec![id1, id2], vec![amount, amount], alloy::primitives::Bytes::default()).send().await {
         Ok(p) => { let _ = p.watch().await; },
         Err(e) => return HttpResponse::BadRequest().json(TxResponse { success: false, tx_hash: None, error: Some(format!("Pull tokens: {:?}", e)) }),
    };

    // 3. Merge
    let partition = vec![U256::from(1), U256::from(2)];
    match ctf.mergePositions(usdc_addr, FixedBytes::ZERO, condition_id, partition, amount).send().await {
         Ok(p) => { let _ = p.watch().await; },
         Err(e) => return HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("Merge: {:?}", e)) }),
    };

    // 4. Return USDC
    match usdc.transfer(owner_addr, amount).send().await {
        Ok(p) => {
            let hash = p.watch().await.unwrap();
            HttpResponse::Ok().json(TxResponse { success: true, tx_hash: Some(hash.to_string()), error: None })
        },
        Err(e) => HttpResponse::InternalServerError().json(TxResponse { success: false, tx_hash: None, error: Some(format!("Return USDC: {:?}", e)) }),
    }
}

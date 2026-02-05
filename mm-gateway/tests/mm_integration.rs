//! # MM-Gateway Integration Tests
//!
//! Integration tests requiring running Anvil + CLOB services.

use std::time::Duration;
use tokio::time::sleep;

/// Test configuration for integration tests
struct TestConfig {
    clob_url: String,
    rpc_url: String,
}

impl Default for TestConfig {
    fn default() -> Self {
        Self {
            clob_url: std::env::var("CLOB_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:3030".to_string()),
            rpc_url: std::env::var("RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:8545".to_string()),
        }
    }
}

/// Check if CLOB service is available
async fn clob_available(url: &str) -> bool {
    match reqwest::get(format!("{}/health", url)).await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

/// Check if Anvil is available
async fn anvil_available(url: &str) -> bool {
    let client = reqwest::Client::new();
    match client
        .post(url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "method": "eth_blockNumber",
            "params": [],
            "id": 1
        }))
        .send()
        .await
    {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

#[tokio::test]
#[ignore = "Requires running Anvil + CLOB services"]
async fn test_mm_initialization() {
    let config = TestConfig::default();

    // Check services are available
    if !clob_available(&config.clob_url).await {
        eprintln!(
            "CLOB not available at {}. Skipping test.",
            config.clob_url
        );
        return;
    }

    if !anvil_available(&config.rpc_url).await {
        eprintln!("Anvil not available at {}. Skipping test.", config.rpc_url);
        return;
    }

    // Load MM config
    let mm_config = mm_gateway::config::MMConfig::from_env().expect("Config should load");
    mm_config.validate().expect("Config should be valid");

    // Create components
    let signer =
        mm_gateway::signer::OrderSigner::new(&mm_config).expect("Signer should initialize");
    let inventory =
        mm_gateway::inventory::InventoryManager::new(&mm_config).expect("Inventory should init");

    // Sync inventory
    let inv = inventory.sync().await.expect("Inventory sync should work");
    println!(
        "Initial inventory: USDC={} YES={} NO={}",
        inv.usdc_balance, inv.yes_balance, inv.no_balance
    );

    // Generate a test quote
    let quote_engine = mm_gateway::quote_engine::QuoteEngine::new(&mm_config);
    let quotes = quote_engine.generate_yes_quotes(&inv);
    println!("Generated {} quotes", quotes.len());

    // Sign a test order
    if !quotes.is_empty() {
        let quote = &quotes[0];
        let order = signer
            .sign_order(&quote.token_id, quote.side, quote.price, quote.quantity)
            .await
            .expect("Signing should work");

        assert!(order.signature.starts_with("0x"));
        assert_eq!(order.signature.len(), 132);
        println!("Signed order hash: {}", order.order_hash);
    }
}

#[tokio::test]
#[ignore = "Requires running Anvil + CLOB services"]
async fn test_order_submission() {
    let config = TestConfig::default();

    if !clob_available(&config.clob_url).await {
        eprintln!("CLOB not available. Skipping test.");
        return;
    }

    let mm_config = mm_gateway::config::MMConfig::from_env().expect("Config");
    let signer = mm_gateway::signer::OrderSigner::new(&mm_config).expect("Signer");
    let adapter = mm_gateway::orderbook_adapter::OrderbookAdapter::new(&mm_config);

    // Check CLOB health
    assert!(adapter.health().await, "CLOB should be healthy");

    // Sign and submit a test order
    let order = signer
        .sign_order(
            &mm_config.yes_token_id,
            mm_gateway::types::Side::BUY,
            490_000, // 0.49
            10_000_000, // 10 tokens
        )
        .await
        .expect("Signing should work");

    let response = adapter
        .submit_order(&order)
        .await
        .expect("Submission should work");

    println!("Order response: {:?}", response);
    assert!(response.success, "Order should be accepted");
}

#[tokio::test]
#[ignore = "Requires running Anvil + CLOB services"]
async fn test_orderbook_query() {
    let config = TestConfig::default();

    if !clob_available(&config.clob_url).await {
        eprintln!("CLOB not available. Skipping test.");
        return;
    }

    let mm_config = mm_gateway::config::MMConfig::from_env().expect("Config");
    let adapter = mm_gateway::orderbook_adapter::OrderbookAdapter::new(&mm_config);

    // Query orderbook
    let book = adapter
        .get_orderbook(&mm_config.yes_token_id)
        .await
        .expect("Orderbook query should work");

    println!(
        "Orderbook: {} bids, {} asks",
        book.bids.len(),
        book.asks.len()
    );
}

#[tokio::test]
#[ignore = "Requires running Anvil + CLOB + full test setup"]
async fn test_full_trading_cycle() {
    let config = TestConfig::default();

    if !clob_available(&config.clob_url).await || !anvil_available(&config.rpc_url).await {
        eprintln!("Services not available. Skipping test.");
        return;
    }

    let mm_config = mm_gateway::config::MMConfig::from_env().expect("Config");
    let signer = mm_gateway::signer::OrderSigner::new(&mm_config).expect("Signer");
    let adapter = mm_gateway::orderbook_adapter::OrderbookAdapter::new(&mm_config);
    let mut inventory = mm_gateway::inventory::InventoryManager::new(&mm_config).expect("Inv");

    // 1. Get initial inventory
    let initial_inv = inventory.sync().await.expect("Inventory sync");
    let initial_yes = initial_inv.yes_balance;
    println!("Initial YES balance: {}", initial_yes);

    // 2. Submit a SELL order
    let sell_order = signer
        .sign_order(
            &mm_config.yes_token_id,
            mm_gateway::types::Side::SELL,
            510_000, // 0.51
            10_000_000, // 10 tokens
        )
        .await
        .expect("Sign sell");

    let sell_response = adapter.submit_order(&sell_order).await.expect("Submit sell");
    println!("Sell order: {:?}", sell_response);

    // 3. Wait for potential fills
    sleep(Duration::from_secs(2)).await;

    // 4. Check final inventory
    let final_inv = inventory.sync().await.expect("Final inventory sync");
    println!("Final YES balance: {}", final_inv.yes_balance);

    // If there were fills, YES balance should have decreased
    if !sell_response.trades.is_empty() {
        assert!(
            final_inv.yes_balance < initial_yes,
            "YES balance should decrease after fill"
        );
    }
}

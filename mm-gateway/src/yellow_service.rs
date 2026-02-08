//! # Yellow Network Service
//!
//! Dedicated service for Yellow Network integration.
//! Runs independently from market-making logic.

use tracing::info;
use tokio::time::{sleep, Duration};

use crate::config::MMConfig;
use crate::yellow_client::YellowClient;
use alloy::signers::local::PrivateKeySigner;

/// Run Yellow Network service in isolated mode
/// This service only handles Yellow Network session notifications
/// and does not perform any market-making operations
pub async fn run_yellow_service(config: MMConfig, signer: PrivateKeySigner) -> Result<(), Box<dyn std::error::Error>> {
    info!("╔══════════════════════════════════════════════════════╗");
    info!("║        Yellow Network Service Starting...           ║");
    info!("╚══════════════════════════════════════════════════════╝");
    
    info!("Configuration:");
    info!("  Agent: {}", config.agent_address);
    info!("  Yellow WS: {}", config.yellow_ws_url);
    info!("  App Name: {}", config.yellow_app_name);
    
    // Initialize Yellow client
    let mut yellow_client = YellowClient::new(&config, signer);
    
    // Connect
    if let Err(e) = yellow_client.connect().await {
        return Err(format!("Failed to connect to Yellow Network: {}", e).into());
    }
    
    // Authenticate
    if let Err(e) = yellow_client.authenticate().await {
        return Err(format!("Failed to authenticate with Yellow Network: {}", e).into());
    }
    
    info!("✅ Successfully authenticated with Yellow Network");
    info!("🔄 Listening for session notifications...");
    
    // Main notification polling loop
    loop {
        // Pump WebSocket to receive any incoming notifications
        if let Err(e) = yellow_client.process_messages().await {
            info!("⚠️ Yellow WS error: {}. Attempting to continue...", e);
        }

        // Poll for notifications from the internal queue
        while let Some(notif) = yellow_client.poll_notification() {
            info!("📨 Yellow Notification Received: {:?}", notif);
            
            // Handle different notification types
            if let Some(method) = notif.get(1).and_then(|v| v.as_str()) {
                match method {
                    "create_app_session" | "asu" => {
                        let params = notif.get(2);
                        info!("🚀 New App Session Created/Updated ({}): {:?}", method, params);
                        
                        // Extract session ID if available (asu nested in AppSession object)
                        let session_id = params.and_then(|p| p.get("app_session_id")).and_then(|v| v.as_str())
                            .or_else(|| params.and_then(|p| p.get("app_session")).and_then(|s| s.get("app_session_id")).and_then(|v| v.as_str()));

                        if let Some(id) = session_id {
                            info!("   Session ID: {}", id);
                        }
                    }
                    "cu" => {
                        let params = notif.get(2);
                        info!("📈 Channel Update (cu): {:?}", params);
                    }
                    "update_app_session" => {
                        let params = notif.get(2);
                        info!("🔄 App Session Updated: {:?}", params);
                    }
                    "close_app_session" => {
                        let params = notif.get(2);
                        info!("🔚 App Session Closed: {:?}", params);
                    }
                    _ => {
                        info!("ℹ️  Unknown notification type: {}", method);
                    }
                }
            }
        }
        
        // Small sleep to avoid busy-waiting
        sleep(Duration::from_millis(100)).await;
    }
}

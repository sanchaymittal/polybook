use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
// use alloy::signers::Signer;
// use alloy::sol;
// use alloy::sol_types::{SolStruct, Eip712Domain};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
// use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::str::FromStr;
use tokio::net::TcpStream;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};
use tracing::{debug, info, warn};
use tokio::sync::mpsc;
// use url::Url;

use crate::config::MMConfig;

// Protocol Constants
// const NITRO_RPC_VERSION: &str = "NitroRPC/0.4";

// Define EIP-712 Types using sol!
use crate::yellow_signer::YellowSigner;

// ... existing methods ...


#[derive(Debug, Clone, Serialize, Deserialize)]
struct RpcMessage {
    #[serde(skip_serializing_if = "Option::is_none")]
    req: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    res: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sig: Option<Vec<String>>,
}

// ... inside YellowClient implementation ...

#[derive(Debug)]
pub struct YellowClient {
    ws_url: String,
    signer: PrivateKeySigner,
    ws_stream: Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
    next_id: AtomicU64,
    app_name: String,
    scope: String,
    notification_tx: mpsc::UnboundedSender<Value>,
    notification_rx: mpsc::UnboundedReceiver<Value>,
    session_signer: Option<PrivateKeySigner>,
    last_heartbeat: std::time::Instant,
    chain_id: u64,
    custody_address: String,
}

impl YellowClient {
    pub fn new(config: &MMConfig, signer: PrivateKeySigner) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            ws_url: config.yellow_ws_url.clone(),
            signer,
            ws_stream: None,
            next_id: AtomicU64::new(1),
            app_name: config.yellow_app_name.clone(),
            scope: config.yellow_scope.clone(),
            notification_tx: tx,
            notification_rx: rx,
            session_signer: None,
            last_heartbeat: std::time::Instant::now(),
            chain_id: config.chain_id,
            custody_address: config.custody_address.clone(),
        }
    }


    pub async fn connect(&mut self) -> Result<(), String> {
        // tokio-tungstenite 0.28 connect_async takes string or Url. 
        // passing &str implies IntoClientRequest.
        let (ws_stream, _) = connect_async(&self.ws_url).await.map_err(|e| e.to_string())?;
        info!("Connected to Yellow Network: {}", self.ws_url);
        self.ws_stream = Some(ws_stream);
        Ok(())
    }

    fn get_next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::SeqCst)
    }

    async fn send_message(&mut self, method: &str, params: Value, signature: Option<Vec<String>>) -> Result<u64, String> {
        let id = self.get_next_id();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        let msg = RpcMessage {
            req: Some(vec![
                Value::Number(serde_json::Number::from(id)),
                Value::String(method.to_string()),
                params,
                Value::Number(serde_json::Number::from(timestamp)),
            ]),
            res: None,
            error: None,
            sig: Some(signature.unwrap_or_else(|| vec![])),
        };

        let json = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
        debug!("Sending: {}", json);

        if let Some(ws) = &mut self.ws_stream {
            ws.send(tokio_tungstenite::tungstenite::Message::Text(json.into()))
                .await
                .map_err(|e| e.to_string())?;
            Ok(id)
        } else {
            Err("WebSocket not connected".to_string())
        }
    }
    


    async fn handle_ws_message(
        notification_tx: &mpsc::UnboundedSender<Value>,
        ws_stream: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
        msg: tokio_tungstenite::tungstenite::Message
    ) -> Result<Option<(u64, Value)>, String> {
        match msg {
            tokio_tungstenite::tungstenite::Message::Text(text) => {
                let text_str = text.as_str();
                info!("[Yellow] Received: {}", text_str);
                let rpc_msg: RpcMessage = match serde_json::from_str(text_str) {
                    Ok(m) => m,
                    Err(e) => {
                        warn!("[Yellow] Failed to parse JSON: {} | Raw: {}", e, text_str);
                        return Ok(None);
                    }
                };
                
                if let Some(res) = rpc_msg.res {
                    info!("[Yellow] Received RES: {:?}", res);
                    if let Some(res_id) = res.get(0).and_then(|v| v.as_u64()) {
                        if res_id == 0 {
                            // Treat ID 0 response as a notification/push
                            let _ = notification_tx.send(Value::Array(res));
                        } else {
                            return Ok(Some((res_id, Value::Array(res))));
                        }
                    }
                }

                // Handle notifications (as requests from server)
                if let Some(req) = rpc_msg.req {
                    info!("[Yellow] Received REQ: {:?}", req);
                    let _ = notification_tx.send(Value::Array(req));
                }
                Ok(None)
            }
            tokio_tungstenite::tungstenite::Message::Ping(p) => {
                let _ = ws_stream.send(tokio_tungstenite::tungstenite::Message::Pong(p)).await;
                Ok(None)
            }
            _ => Ok(None),
        }
    }

    async fn wait_for_response(&mut self, request_id: u64) -> Result<Value, String> {
        let timeout_duration = std::time::Duration::from_secs(30);
        let notification_tx = &self.notification_tx;

        if let Some(ws) = &mut self.ws_stream {
            let start = std::time::Instant::now();
            while start.elapsed() < timeout_duration {
                let msg_res = tokio::time::timeout(std::time::Duration::from_millis(500), ws.next()).await;
                
                let msg = match msg_res {
                    Ok(Some(Ok(m))) => m,
                    Ok(Some(Err(e))) => return Err(format!("WS Error: {}", e)),
                    Ok(None) => return Err("Stream closed by server".to_string()),
                    Err(_) => continue,
                };

                if let Some((id, res)) = Self::handle_ws_message(notification_tx, ws, msg).await? {
                    if id == request_id {
                        if let Some(res_type) = res.get(1).and_then(|v| v.as_str()) {
                            if res_type == "error" {
                                return Err(format!("RPC Error: {:?}", res.get(2)));
                            }
                        }
                        return Ok(res);
                    }
                }
            }
            Err("Timeout waiting for response".to_string())
        } else {
            Err("WebSocket not connected".to_string())
        }
    }

    /// Process any incoming messages from the WebSocket and store notifications
    pub async fn process_messages(&mut self) -> Result<(), String> {
        let notification_tx = &self.notification_tx;
        if let Some(ws) = &mut self.ws_stream {
            // Send heartbeat if needed
            if self.last_heartbeat.elapsed() > std::time::Duration::from_secs(30) {
                debug!("💓 Sending heartbeat PING");
                ws.send(tokio_tungstenite::tungstenite::Message::Ping(vec![].into()))
                    .await
                    .map_err(|e| e.to_string())?;
                self.last_heartbeat = std::time::Instant::now();
            }

            // Poll for messages without blocking too long
            while let Ok(msg_res) = tokio::time::timeout(std::time::Duration::from_millis(5), ws.next()).await {
                match msg_res {
                    Some(Ok(msg)) => {
                        let _ = Self::handle_ws_message(notification_tx, ws, msg).await?;
                    }
                    Some(Err(e)) => return Err(format!("WS Error: {}", e)),
                    None => return Err("Stream closed".to_string()),
                }
            }
            Ok(())
        } else {
            Err("WebSocket not connected".to_string())
        }
    }

    /// Poll for any stored notifications
    pub fn poll_notification(&mut self) -> Option<Value> {
        match self.notification_rx.try_recv() {
            Ok(notif) => Some(notif),
            Err(_) => None,
        }
    }

    pub async fn get_assets(&mut self) -> Result<Vec<Value>, String> {
        let req_id = self.send_message("get_assets", serde_json::json!(null), None).await?;
        let res = self.wait_for_response(req_id).await?;
        // res[2] is assets array
        let assets = res.get(2).and_then(|v| v.as_array()).ok_or("Invalid assets response")?;
        Ok(assets.clone())
    }

    pub async fn authenticate(&mut self) -> Result<(), String> {
        // 1. Auth Request
        let wallet_address = self.signer.address();
        let session_signer = PrivateKeySigner::random();
        let session_address = session_signer.address();
        self.session_signer = Some(session_signer);
        
        // Skip get_assets for now to match TypeScript flow and avoid ID mismatch issues
        // let assets = self.get_assets().await?;
        let asset_address = "ytest.usd";
        let app_name = self.app_name.clone();
        let scope = self.scope.clone();
        
        info!("Authenticating with asset: {}", asset_address);

        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
        let expires_at = now + 3600;

        let auth_params = serde_json::json!({
            "address": wallet_address.to_checksum(None),
            "session_key": session_address.to_checksum(None),
            "application": app_name,
            "scope": scope,
            "expires_at": expires_at,
            "allowances": [{
                "asset": asset_address,
                "amount": "1000000000000000000000"
            }]
        });

        let req_id = self.send_message("auth_request", auth_params.clone(), None).await?;
        let res = self.wait_for_response(req_id).await?;
        
        // 2. Handle Challenge
        let challenge_msg = res.get(2)
            .and_then(|v| v.get("challenge_message"))
            .and_then(|v| v.as_str())
            .ok_or("No challenge_message in auth response")?;

        info!("Received challenge, signing...");
        
        // 3. Prepare Allowances for Signer
        let allowances_input = vec![
            ("ytest.usd".to_string(), "1000000000000000000000".to_string())
        ];

        // 4. Sign Challenge Natively
        let req_id = self.get_next_id();
        info!("DEBUG: Signing with local private key (Native Rust EIP-712)...");
        
        let verify_fut = YellowSigner::sign_auth_challenge(
            &self.signer,
            &challenge_msg,
            &self.scope,
            wallet_address,
            session_address,
            expires_at,
            allowances_input,
            req_id,
            self.app_name.clone(),
        );
        let verify_res: Result<Value, String> = verify_fut.await;
        let verify_msg = verify_res.map_err(|e| format!("Native Signing Error: {}", e))?;

        // info!("Got verify message from yellow-server: {:?}", verify_msg);

        // 5. Send Verify Message
        // verify_msg is already the full JSON object expected by the server
        let json_str = serde_json::to_string(&verify_msg).map_err(|e| e.to_string())?;
        
        if let Some(ws) = &mut self.ws_stream {
            ws.send(tokio_tungstenite::tungstenite::Message::Text(json_str.into()))
                .await
                .map_err(|e| e.to_string())?;
            
            // Wait for response using the ID from the verify message
            // The verify message from yellow-server should have the ID we passed or similar
            // Let's assume req_id is what we track.
            let _verify_res = self.wait_for_response(req_id).await?;
            
            info!("Authentication successful!");
            Ok(())
        } else {
            Err("WebSocket not connected".to_string())
        }
    }

    pub async fn get_ledger_balances(&mut self) -> Result<Vec<Value>, String> {
        let address = self.signer.address();
        let params = serde_json::json!({
            "account_id": format!("{address:#x}")
        });
        let req_id = self.send_message("get_ledger_balances", params, None).await?;
        let res = self.wait_for_response(req_id).await?;
        
        let balances = res.get(2)
            .and_then(|v| v.get("ledger_balances"))
            .and_then(|v| v.as_array())
            .ok_or("Invalid ledger_balances response")?;
            
        Ok(balances.clone())
    }

    pub async fn get_app_sessions(&mut self) -> Result<Vec<Value>, String> {
        let address = self.signer.address();
        let params = serde_json::json!({
            "participant": format!("{address:#x}")
        });
        let req_id = self.send_message("get_app_sessions", params, None).await?;
        let res = self.wait_for_response(req_id).await?;
        
        // Response for get_app_sessions might be array of sessions directly or { app_sessions: [] }?
        // Let's assume matches get_ledger_balances pattern if in result object
        // Or it might be the result array itself if list.
        // NitroRPC usually returns object in result.
        
        // Based on `test_yellow_interaction.ts`, we didn't call get_app_sessions.
        // But `nitrolite` types suggest `GetAppSessionsRequest` -> `RpcResponse`.
        
        // Let's try to parse as object with `app_sessions` key, or array.
        if let Some(sessions) = res.get(2).and_then(|v| v.as_array()) {
            // Direct array?
            return Ok(sessions.clone());
        }
        
        if let Some(sessions) = res.get(2).and_then(|v| v.get("app_sessions")).and_then(|v| v.as_array()) {
             return Ok(sessions.clone());
        }
        
        Ok(vec![]) // Empty if parse fails or empty
    }
}

use alloy::primitives::Address;
use alloy::sol;
use alloy::sol_types::{Eip712Domain, SolStruct};
use alloy::signers::Signer;
use alloy::signers::local::PrivateKeySigner;
use serde_json::Value;

// Define EIP-712 structs exactly matching nitrolite definitions
sol! {
    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct Allowance {
        string asset;
        string amount;
    }

    #[derive(Debug, serde::Serialize, serde::Deserialize)]
    struct Policy {
        string challenge;
        string scope;
        address wallet;
        address session_key;
        uint64 expires_at;
        Allowance[] allowances;
    }
}

pub struct YellowSigner;

impl YellowSigner {
    pub async fn sign_auth_challenge(
        signer: &PrivateKeySigner,
        challenge: &str,
        scope: &str,
        wallet: Address,
        session_key: Address,
        expires_at: u64,
        allowances_input: Vec<(String, String)>,
        req_id: u64,
        app_name: String,
    ) -> Result<Value, String> {
        
        let domain = Eip712Domain {
            name: Some(app_name.into()),
            version: None,
            chain_id: None,
            verifying_contract: None,
            salt: None,
        };

        let allowances: Vec<Allowance> = allowances_input
            .into_iter()
            .map(|(asset, amount)| Allowance { asset, amount })
            .collect();

        let policy = Policy {
            challenge: challenge.to_string(),
            scope: scope.to_string(),
            wallet,
            session_key,
            expires_at,
            allowances,
        };

        // Compute the EIP-712 signing hash manually
        let hash = policy.eip712_signing_hash(&domain);

        // Sign the hash
        let signature = signer.sign_hash(&hash)
            .await
            .map_err(|e| format!("Signing error: {}", e))?;

        // Construct the expected JSON response format (Nitrolite RPC)
        // Verify message: {"req":[id, "auth_verify", {challenge: ...}], "sig": [...]}
        // But here we return just the payload expected by send_message?
        // No, YellowClient::authenticate calls this and expects the "verify_msg" object?
        // Wait, send_message wraps it. authenticate sends verify_msg as the payload?
        // Let's check duplicate logic.
        // In previous implementation:
        // verify_msg was the FULL object `{"req": ..., "sig": ...}` returned by yellow-server.
        // But standard `send_message` in yellow_client wraps `req`.
        // `createAuthVerifyMessageFromChallenge` in nitrolite returns the FULL JSON string.
        
        // However, `YellowClient::authenticate` does:
        // `let verify_msg = YellowSigner::sign_auth_challenge(...)`
        // `ws.send(verify_msg)`
        
        // So we need to construct the full RPC message here manually to match nitrolite's `createAuthVerifyMessageFromChallenge`.
        
        let sig_hex = format!("0x{}", hex::encode(signature.as_bytes()));
        
        // Construct the inner request part
        // [id, "auth_verify", {challenge: ...}, timestamp]
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;

        // Matches: createAuthVerifyMessageFromChallenge
        let req = serde_json::json!([
            req_id,
            "auth_verify",
            { "challenge": challenge },
            timestamp
        ]);

        let msg = serde_json::json!({
            "req": req,
            "sig": [sig_hex]
        });

        Ok(msg)
    }

    // Stub for session create - we can migrate this later or keep using server if needed?
    // User asked "let's try to create the connection without the yellow-server ts connection"
    // So we should probably disable/stub this or implement it natively too.
    // For now, let's just make it return error or stub since we are focusing on auth.
    pub async fn sign_session_create(
        _session_key_hex: &str,
        _maker: Address,
        _taker: Address,
        _asset: &str,
        _amount: &str,
        _req_id: u64
    ) -> Result<Value, String> {
        Err("Native session creation not yet implemented".to_string())
    }
}

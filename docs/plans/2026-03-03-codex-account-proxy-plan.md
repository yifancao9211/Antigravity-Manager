# Codex Account Proxy - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Codex (OpenAI) account support to Antigravity Tools, enabling users to proxy Codex accounts to Claude Code and Cursor.

**Architecture:** Add `AccountProvider` enum to the Account model with `#[serde(default)]` for backward compatibility. Codex accounts reuse existing `TokenData` struct. The proxy engine routes upstream requests based on `account.provider` — Google accounts to Google APIs, Codex accounts to `api.openai.com`. Three import methods: OAuth web login, manual token/key, import from `~/.codex/auth.json`.

**Tech Stack:** Rust (Tauri v2, Axum, tokio, reqwest, serde), TypeScript (React 19, Zustand, Ant Design), i18next

**Design Doc:** `docs/plans/2026-03-03-codex-account-proxy-design.md`

---

## Task 1: Add AccountProvider enum and update Rust data models

**Files:**
- Modify: `src-tauri/src/models/account.rs`
- Modify: `src-tauri/src/models/mod.rs`

**Step 1: Add AccountProvider enum to `models/account.rs`**

Add before the `Account` struct definition:

```rust
/// 账户服务商类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AccountProvider {
    Google,  // 现有的 Google/Gemini 账户
    Codex,   // OpenAI Codex 账户 (sess-... 或 sk-...)
}

impl Default for AccountProvider {
    fn default() -> Self {
        AccountProvider::Google
    }
}
```

**Step 2: Add `provider` field to `Account` struct**

Add after the `custom_label` field:

```rust
    /// 账户服务商类型 (Google/Codex)
    #[serde(default)]
    pub provider: AccountProvider,
```

**Step 3: Update `Account::new()` constructor**

Add `provider: AccountProvider::Google,` to the constructor body.

**Step 4: Add a `new_codex()` constructor**

```rust
    pub fn new_codex(id: String, email: String, token: TokenData) -> Self {
        let now = chrono::Utc::now().timestamp();
        Self {
            provider: AccountProvider::Codex,
            id,
            email,
            name: None,
            token,
            device_profile: None,
            device_history: Vec::new(),
            quota: None,
            disabled: false,
            disabled_reason: None,
            disabled_at: None,
            proxy_disabled: false,
            proxy_disabled_reason: None,
            proxy_disabled_at: None,
            protected_models: HashSet::new(),
            validation_blocked: false,
            validation_blocked_until: None,
            validation_blocked_reason: None,
            validation_url: None,
            created_at: now,
            last_used: now,
            proxy_id: None,
            proxy_bound_at: None,
            custom_label: None,
        }
    }
```

**Step 5: Add `provider` to `AccountSummary`**

```rust
pub struct AccountSummary {
    // ...existing fields...
    #[serde(default)]
    pub provider: AccountProvider,
}
```

**Step 6: Update `models/mod.rs` re-exports**

Add `AccountProvider` to the `pub use account::` line:

```rust
pub use account::{Account, AccountIndex, AccountSummary, DeviceProfile, DeviceProfileVersion, AccountExportItem, AccountExportResponse, AccountProvider};
```

**Step 7: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

Fix any compilation errors. The `Account::new()` call sites may need `provider: AccountProvider::Google` added if struct literal construction is used elsewhere.

**Step 8: Commit**

```bash
git add src-tauri/src/models/account.rs src-tauri/src/models/mod.rs
git commit -m "feat: add AccountProvider enum (Google/Codex) to Account model"
```

---

## Task 2: Add Codex OAuth module

**Files:**
- Create: `src-tauri/src/modules/codex_oauth.rs`
- Modify: `src-tauri/src/modules/mod.rs`

**Step 1: Create `codex_oauth.rs`**

This module handles OpenAI Codex authentication — OAuth PKCE flow, token refresh, and user info fetching.

```rust
use serde::{Deserialize, Serialize};
use tracing::{info, error, warn};
use crate::models::TokenData;

// OpenAI Codex OAuth configuration
// Client ID from the openai/codex CLI open source repository
const CODEX_CLIENT_ID: &str = "app_sOb0KOmdLU9kOJVxxGSFEFkH";
const CODEX_AUTH_URL: &str = "https://auth.openai.com/authorize";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_USERINFO_URL: &str = "https://api.openai.com/v1/me";
const CODEX_AUDIENCE: &str = "https://api.openai.com/v1";

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexTokenResponse {
    pub access_token: String,
    #[serde(default)]
    pub token_type: String,
    #[serde(default)]
    pub expires_in: Option<i64>,
    #[serde(default)]
    pub refresh_token: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CodexUserInfo {
    pub id: String,
    pub email: Option<String>,
    pub name: Option<String>,
}

/// Generate PKCE code verifier and challenge
fn generate_pkce() -> (String, String) {
    use sha2::{Sha256, Digest};
    use base64::Engine;
    use rand::Rng;

    let mut rng = rand::thread_rng();
    let verifier: String = (0..128)
        .map(|_| {
            let idx = rng.gen_range(0..62);
            let c = if idx < 10 { (b'0' + idx) as char }
                   else if idx < 36 { (b'A' + idx - 10) as char }
                   else { (b'a' + idx - 36) as char };
            c
        })
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash);

    (verifier, challenge)
}

/// Generate Codex OAuth authorization URL
pub fn get_codex_auth_url(redirect_uri: &str, state: &str) -> (String, String) {
    let (verifier, challenge) = generate_pkce();

    let params = vec![
        ("client_id", CODEX_CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", "openid profile email offline_access"),
        ("audience", CODEX_AUDIENCE),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
    ];

    let url = url::Url::parse_with_params(CODEX_AUTH_URL, &params)
        .expect("Invalid Codex Auth URL");

    (url.to_string(), verifier)
}

/// Exchange authorization code for Codex token
pub async fn exchange_codex_code(
    code: &str,
    redirect_uri: &str,
    code_verifier: &str,
) -> Result<CodexTokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("grant_type", "authorization_code"),
        ("client_id", CODEX_CLIENT_ID),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("code_verifier", code_verifier),
    ];

    let resp = client
        .post(CODEX_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Codex token exchange failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Codex token exchange HTTP {}: {}", status, body));
    }

    resp.json::<CodexTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse Codex token response: {}", e))
}

/// Refresh a Codex access token
pub async fn refresh_codex_token(refresh_token: &str) -> Result<CodexTokenResponse, String> {
    let client = reqwest::Client::new();

    let params = [
        ("grant_type", "refresh_token"),
        ("client_id", CODEX_CLIENT_ID),
        ("refresh_token", refresh_token),
    ];

    let resp = client
        .post(CODEX_TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Codex token refresh failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Codex token refresh HTTP {}: {}", status, body));
    }

    resp.json::<CodexTokenResponse>()
        .await
        .map_err(|e| format!("Failed to parse Codex refresh response: {}", e))
}

/// Get user info from OpenAI API using access token
pub async fn get_codex_user_info(access_token: &str) -> Result<CodexUserInfo, String> {
    let client = reqwest::Client::new();

    let resp = client
        .get(CODEX_USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Codex user info request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Codex user info HTTP {}: {}", status, body));
    }

    resp.json::<CodexUserInfo>()
        .await
        .map_err(|e| format!("Failed to parse Codex user info: {}", e))
}

/// Build TokenData from Codex token response
pub fn build_codex_token_data(
    token_resp: &CodexTokenResponse,
    email: Option<String>,
) -> TokenData {
    let expires_in = token_resp.expires_in.unwrap_or(3600);
    TokenData::new(
        token_resp.access_token.clone(),
        token_resp.refresh_token.clone().unwrap_or_default(),
        expires_in,
        email,
        None, // no project_id for Codex
        None, // no session_id
    )
}

/// Build TokenData for a manually-entered API key (sk-...)
pub fn build_codex_api_key_token_data(
    api_key: String,
    email: Option<String>,
) -> TokenData {
    TokenData::new(
        api_key,
        String::new(), // no refresh token for API keys
        315360000,     // ~10 years, effectively never expires
        email,
        None,
        None,
    )
}

/// Import Codex account from ~/.codex/auth.json
pub async fn import_from_codex_auth_file() -> Result<TokenData, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let auth_path = home.join(".codex").join("auth.json");

    if !auth_path.exists() {
        return Err(format!("Codex auth file not found: {}", auth_path.display()));
    }

    let content = std::fs::read_to_string(&auth_path)
        .map_err(|e| format!("Failed to read {}: {}", auth_path.display(), e))?;

    #[derive(Deserialize)]
    struct CodexAuthFile {
        #[serde(alias = "OPENAI_API_KEY")]
        access_token: Option<String>,
        #[serde(alias = "OPENAI_BASE_URL")]
        base_url: Option<String>,
        refresh_token: Option<String>,
        expires_at: Option<i64>,
    }

    let auth: CodexAuthFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse Codex auth.json: {}", e))?;

    let access_token = auth.access_token
        .ok_or("No access_token/OPENAI_API_KEY found in auth.json")?;

    let is_api_key = access_token.starts_with("sk-");

    if is_api_key {
        Ok(build_codex_api_key_token_data(access_token, None))
    } else {
        let expires_in = auth.expires_at
            .map(|ea| ea - chrono::Utc::now().timestamp())
            .unwrap_or(3600);

        Ok(TokenData::new(
            access_token,
            auth.refresh_token.unwrap_or_default(),
            expires_in.max(0),
            None,
            None,
            None,
        ))
    }
}

/// Check if a Codex token needs refresh and refresh it if needed
/// Returns the (possibly updated) TokenData
pub async fn ensure_codex_fresh_token(token: &TokenData) -> Result<Option<TokenData>, String> {
    // API keys don't expire
    if token.access_token.starts_with("sk-") {
        return Ok(None); // no update needed
    }

    // No refresh token available
    if token.refresh_token.is_empty() {
        return Ok(None);
    }

    // Check if token expires within 5 minutes
    let now = chrono::Utc::now().timestamp();
    if token.expiry_timestamp > now + 300 {
        return Ok(None); // still fresh
    }

    info!("Codex token expiring soon, refreshing...");
    let resp = refresh_codex_token(&token.refresh_token).await?;

    Ok(Some(TokenData::new(
        resp.access_token,
        resp.refresh_token.unwrap_or_else(|| token.refresh_token.clone()),
        resp.expires_in.unwrap_or(3600),
        token.email.clone(),
        None,
        None,
    )))
}
```

**Step 2: Register module in `modules/mod.rs`**

Add after the `pub mod oauth_server;` line:

```rust
pub mod codex_oauth;
```

**Step 3: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

Note: The `CODEX_CLIENT_ID` value needs verification from the openai/codex source. Use a placeholder if the exact value cannot be confirmed — mark it with a `// TODO: verify` comment.

**Step 4: Commit**

```bash
git add src-tauri/src/modules/codex_oauth.rs src-tauri/src/modules/mod.rs
git commit -m "feat: add Codex OAuth module (PKCE flow, token refresh, file import)"
```

---

## Task 3: Add Codex Tauri commands

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs` (invoke_handler registration)

**Step 1: Add Codex account commands to `commands/mod.rs`**

Add these new Tauri commands (after the existing OAuth commands):

```rust
/// Add a Codex account via manual token/API key input
#[tauri::command]
pub async fn add_codex_account_manual(
    app: tauri::AppHandle,
    proxy_state: tauri::State<'_, crate::commands::proxy::ProxyServiceState>,
    token: String,
    refresh_token: Option<String>,
) -> Result<crate::models::Account, String> {
    use crate::models::{Account, AccountProvider, TokenData};
    use crate::modules::codex_oauth;

    let is_api_key = token.starts_with("sk-");

    let token_data = if is_api_key {
        codex_oauth::build_codex_api_key_token_data(token.clone(), None)
    } else {
        TokenData::new(
            token.clone(),
            refresh_token.unwrap_or_default(),
            3600,
            None,
            None,
            None,
        )
    };

    // Try to get user info for display name
    let email = match codex_oauth::get_codex_user_info(&token_data.access_token).await {
        Ok(info) => info.email.unwrap_or_else(|| "codex-user".to_string()),
        Err(e) => {
            tracing::warn!("Failed to get Codex user info: {}, using placeholder", e);
            if is_api_key { "codex-api-key".to_string() } else { "codex-user".to_string() }
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let account = Account::new_codex(id, email, token_data);

    crate::modules::account::add_account_data(account.clone())?;

    // Reload proxy pool if running
    if let Ok(guard) = proxy_state.instance.read().await {
        if let Some(instance) = guard.as_ref() {
            instance.token_manager.reload_accounts().await;
        }
    }

    Ok(account)
}

/// Import Codex account from ~/.codex/auth.json
#[tauri::command]
pub async fn import_codex_from_file(
    app: tauri::AppHandle,
    proxy_state: tauri::State<'_, crate::commands::proxy::ProxyServiceState>,
) -> Result<crate::models::Account, String> {
    use crate::models::Account;
    use crate::modules::codex_oauth;

    let token_data = codex_oauth::import_from_codex_auth_file().await?;

    // Try to get user info
    let email = match codex_oauth::get_codex_user_info(&token_data.access_token).await {
        Ok(info) => info.email.unwrap_or_else(|| "codex-user".to_string()),
        Err(e) => {
            tracing::warn!("Failed to get Codex user info from file import: {}", e);
            "codex-file-import".to_string()
        }
    };

    let id = uuid::Uuid::new_v4().to_string();
    let mut account = Account::new_codex(id, email, token_data);

    crate::modules::account::add_account_data(account.clone())?;

    // Reload proxy pool
    if let Ok(guard) = proxy_state.instance.read().await {
        if let Some(instance) = guard.as_ref() {
            instance.token_manager.reload_accounts().await;
        }
    }

    Ok(account)
}

/// Start Codex OAuth login flow
#[tauri::command]
pub async fn start_codex_oauth_login(
    app_handle: tauri::AppHandle,
    proxy_state: tauri::State<'_, crate::commands::proxy::ProxyServiceState>,
) -> Result<crate::models::Account, String> {
    use crate::models::Account;
    use crate::modules::{codex_oauth, oauth_server};

    // Use oauth_server to prepare callback URL, but with Codex provider
    let (auth_url, redirect_uri, code_verifier) = oauth_server::prepare_codex_oauth(&app_handle).await?;

    // Open browser
    let _ = tauri_plugin_opener::open_url(auth_url, None::<&str>);

    // Wait for callback
    let code = oauth_server::wait_for_codex_callback().await?;

    // Exchange code for token
    let token_resp = codex_oauth::exchange_codex_code(&code, &redirect_uri, &code_verifier).await?;

    // Get user info
    let email = match codex_oauth::get_codex_user_info(&token_resp.access_token).await {
        Ok(info) => info.email.unwrap_or_else(|| "codex-user".to_string()),
        Err(_) => "codex-oauth-user".to_string(),
    };

    let token_data = codex_oauth::build_codex_token_data(&token_resp, Some(email.clone()));
    let id = uuid::Uuid::new_v4().to_string();
    let account = Account::new_codex(id, email, token_data);

    crate::modules::account::add_account_data(account.clone())?;

    // Reload proxy pool
    if let Ok(guard) = proxy_state.instance.read().await {
        if let Some(instance) = guard.as_ref() {
            instance.token_manager.reload_accounts().await;
        }
    }

    Ok(account)
}
```

**Step 2: Register commands in `lib.rs` invoke_handler**

Add to the `tauri::generate_handler![]` macro in `lib.rs`:

```rust
            // Codex account commands
            commands::add_codex_account_manual,
            commands::import_codex_from_file,
            commands::start_codex_oauth_login,
```

**Step 3: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

Note: The `oauth_server::prepare_codex_oauth` and `oauth_server::wait_for_codex_callback` functions don't exist yet. This task intentionally creates the command shells — Task 4 will implement the OAuth server changes. For now, expect compile errors related to these missing functions.

**Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: add Codex account Tauri commands (manual, file import, OAuth)"
```

---

## Task 4: Update OAuth server for Codex provider support

**Files:**
- Modify: `src-tauri/src/modules/oauth_server.rs`

**Step 1: Add Codex flow state**

Add a separate `OnceLock` for the Codex OAuth flow alongside the existing Google one. This avoids parameterizing the existing `OAuthFlowState` struct (which is private and deeply integrated):

```rust
struct CodexOAuthFlowState {
    auth_url: String,
    redirect_uri: String,
    code_verifier: String,
    state: String,
    cancel_tx: watch::Sender<bool>,
    code_tx: mpsc::Sender<Result<String, String>>,
    code_rx: Option<mpsc::Receiver<Result<String, String>>>,
}

static CODEX_OAUTH_FLOW_STATE: OnceLock<Mutex<Option<CodexOAuthFlowState>>> = OnceLock::new();

fn get_codex_oauth_flow_state() -> &'static Mutex<Option<CodexOAuthFlowState>> {
    CODEX_OAUTH_FLOW_STATE.get_or_init(|| Mutex::new(None))
}
```

**Step 2: Add `prepare_codex_oauth` function**

Follow the same TcpListener pattern as Google OAuth but call `codex_oauth::get_codex_auth_url`:

```rust
/// Prepare Codex OAuth flow — returns (auth_url, redirect_uri, code_verifier)
pub async fn prepare_codex_oauth(
    app_handle: &tauri::AppHandle,
) -> Result<(String, String, String), String> {
    // Cancel any existing flow
    if let Ok(mut state) = get_codex_oauth_flow_state().lock() {
        if let Some(s) = state.take() {
            let _ = s.cancel_tx.send(true);
        }
    }

    // Bind listener (same dual-stack pattern as Google OAuth)
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;
    let port = listener.local_addr().map_err(|e| format!("{}", e))?.port();
    let redirect_uri = format!("http://localhost:{}/oauth-callback", port);

    let state_str = uuid::Uuid::new_v4().to_string();
    let (auth_url, code_verifier) = crate::modules::codex_oauth::get_codex_auth_url(&redirect_uri, &state_str);

    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (code_tx, code_rx) = mpsc::channel(1);

    // Spawn callback listener (reuse existing pattern)
    let tx = code_tx.clone();
    let expected_state = state_str.clone();
    tokio::spawn(async move {
        // Accept connection and parse callback (same as Google flow)
        // Extract ?code=...&state=... from the request
        // Verify state matches, send code via tx
        // This follows the exact same pattern as the existing Google OAuth callback handler
    });

    // Store state
    if let Ok(mut guard) = get_codex_oauth_flow_state().lock() {
        *guard = Some(CodexOAuthFlowState {
            auth_url: auth_url.clone(),
            redirect_uri: redirect_uri.clone(),
            code_verifier: code_verifier.clone(),
            state: state_str,
            cancel_tx,
            code_tx,
            code_rx: Some(code_rx),
        });
    }

    Ok((auth_url, redirect_uri, code_verifier))
}

/// Wait for Codex OAuth callback — returns the authorization code
pub async fn wait_for_codex_callback() -> Result<String, String> {
    let rx = {
        let mut guard = get_codex_oauth_flow_state()
            .lock()
            .map_err(|_| "Lock error".to_string())?;
        let state = guard.as_mut().ok_or("No Codex OAuth flow in progress")?;
        state.code_rx.take().ok_or("Codex OAuth callback already consumed")?
    };

    match rx.recv().await {
        Some(Ok(code)) => Ok(code),
        Some(Err(e)) => Err(e),
        None => Err("Codex OAuth callback channel closed".to_string()),
    }
}
```

**Step 3: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

**Step 4: Commit**

```bash
git add src-tauri/src/modules/oauth_server.rs
git commit -m "feat: add Codex OAuth flow state and callback handling to oauth_server"
```

---

## Task 5: Update proxy token refresh to handle Codex accounts

**Files:**
- Modify: `src-tauri/src/modules/oauth.rs` (the `ensure_fresh_token` function)
- Grep for all call sites of `ensure_fresh_token` and `refresh_access_token`

**Step 1: Identify token refresh call sites**

Run: `grep -rn "ensure_fresh_token\|refresh_access_token" src-tauri/src/ --include="*.rs"`

**Step 2: Add provider-aware token refresh**

Where `ensure_fresh_token` is called, add a branch:

```rust
use crate::models::AccountProvider;

match account.provider {
    AccountProvider::Google => {
        // existing Google refresh logic
        oauth::ensure_fresh_token(&account.token, Some(&account.id)).await
    }
    AccountProvider::Codex => {
        // Codex refresh logic
        codex_oauth::ensure_codex_fresh_token(&account.token).await
    }
}
```

**Step 3: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

**Step 4: Commit**

```bash
git add -u src-tauri/src/
git commit -m "feat: add provider-aware token refresh (Google vs Codex branching)"
```

---

## Task 6: Add Codex client adapter

**Files:**
- Create: `src-tauri/src/proxy/common/client_adapters/codex.rs`
- Modify: `src-tauri/src/proxy/common/client_adapters/mod.rs`
- Modify: `src-tauri/src/proxy/common/client_adapter.rs` (CLIENT_ADAPTERS registration)

**Step 1: Create `codex.rs` adapter**

```rust
use super::super::client_adapter::{ClientAdapter, Protocol, SignatureBufferStrategy, get_user_agent};
use axum::http::HeaderMap;

/// Codex CLI 客户端适配器
pub struct CodexAdapter;

impl ClientAdapter for CodexAdapter {
    fn matches(&self, headers: &HeaderMap) -> bool {
        get_user_agent(headers)
            .map(|ua| {
                let lower = ua.to_lowercase();
                lower.contains("codex") && !lower.contains("opencode")
            })
            .unwrap_or(false)
    }

    fn let_it_crash(&self) -> bool {
        true
    }

    fn signature_buffer_strategy(&self) -> SignatureBufferStrategy {
        SignatureBufferStrategy::Fifo
    }

    fn supported_protocols(&self) -> Vec<Protocol> {
        vec![Protocol::OpenAI, Protocol::OACompatible]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn test_codex_adapter_matches() {
        let adapter = CodexAdapter;
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("codex/1.0.0"));
        assert!(adapter.matches(&headers));
    }

    #[test]
    fn test_codex_adapter_no_match_opencode() {
        let adapter = CodexAdapter;
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("opencode/1.0.0"));
        assert!(!adapter.matches(&headers));
    }

    #[test]
    fn test_codex_adapter_protocols() {
        let adapter = CodexAdapter;
        let protocols = adapter.supported_protocols();
        assert!(protocols.contains(&Protocol::OpenAI));
        assert!(protocols.contains(&Protocol::OACompatible));
        assert!(!protocols.contains(&Protocol::Anthropic));
    }
}
```

**Step 2: Register in `client_adapters/mod.rs`**

```rust
pub mod opencode;
pub mod codex;

pub use opencode::OpencodeAdapter;
pub use codex::CodexAdapter;
```

**Step 3: Add to CLIENT_ADAPTERS in `client_adapter.rs`**

Update the `Lazy` initialization:

```rust
use super::client_adapters::{OpencodeAdapter, CodexAdapter};

pub static CLIENT_ADAPTERS: Lazy<Vec<Arc<dyn ClientAdapter>>> = Lazy::new(|| {
    vec![
        Arc::new(OpencodeAdapter),
        Arc::new(CodexAdapter),
    ]
});
```

**Step 4: Build check and run tests**

Run: `cd src-tauri && cargo check && cargo test client_adapters 2>&1 | head -30`

**Step 5: Commit**

```bash
git add src-tauri/src/proxy/common/client_adapters/codex.rs src-tauri/src/proxy/common/client_adapters/mod.rs src-tauri/src/proxy/common/client_adapter.rs
git commit -m "feat: add Codex client adapter for proxy engine"
```

---

## Task 7: Update proxy upstream routing for Codex provider

**Files:**
- Modify: `src-tauri/src/proxy/handlers/openai.rs`
- Modify: `src-tauri/src/proxy/handlers/claude.rs`
- Potentially modify: `src-tauri/src/proxy/upstream/` (upstream request building)

**Step 1: Identify upstream request construction**

Run: `grep -rn "build_upstream\|upstream_url\|api.google\|generativelanguage" src-tauri/src/proxy/ --include="*.rs" | head -30`

This identifies where upstream URLs are constructed for Google accounts.

**Step 2: Add provider branching at upstream request construction**

At the point where the proxy builds the outbound HTTP request to the upstream AI provider, add:

```rust
use crate::models::AccountProvider;

let (upstream_url, auth_header) = match account.provider {
    AccountProvider::Google => {
        // existing Google logic — build URL with project_id, use OAuth token
        (existing_google_url, existing_google_auth)
    }
    AccountProvider::Codex => {
        let url = format!("https://api.openai.com/v1/chat/completions");
        let auth = format!("Bearer {}", account.token.access_token);
        (url, auth)
    }
};
```

**Step 3: Ensure token refresh before upstream call**

Before making the upstream request, check if the Codex token needs refresh:

```rust
if account.provider == AccountProvider::Codex {
    if let Ok(Some(new_token)) = codex_oauth::ensure_codex_fresh_token(&account.token).await {
        // Update the account's token in storage
        account.token = new_token;
        crate::modules::account::update_account_token(&account.id, &account.token)?;
    }
}
```

**Step 4: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

**Step 5: Commit**

```bash
git add -u src-tauri/src/proxy/
git commit -m "feat: add Codex upstream routing in proxy handlers"
```

---

## Task 8: Add model-to-provider routing logic

**Files:**
- Modify: `src-tauri/src/proxy/common/model_mapping.rs`

**Step 1: Add model-provider affinity function**

```rust
use crate::models::AccountProvider;

/// Determine the preferred provider for a given model name
pub fn preferred_provider_for_model(model: &str) -> Option<AccountProvider> {
    let lower = model.to_lowercase();

    // OpenAI models prefer Codex accounts
    if lower.starts_with("gpt-")
        || lower.starts_with("o1-")
        || lower.starts_with("o3-")
        || lower.starts_with("o4-")
        || lower.starts_with("chatgpt-")
        || lower == "gpt-4o"
        || lower == "gpt-4o-mini"
    {
        return Some(AccountProvider::Codex);
    }

    // Google/Anthropic models prefer Google accounts
    if lower.starts_with("claude-")
        || lower.starts_with("gemini-")
        || lower.starts_with("gemma-")
    {
        return Some(AccountProvider::Google);
    }

    // Unknown models — no preference, use any available account
    None
}
```

**Step 2: Integrate into account selection**

Find the account selection logic (likely in handlers or a token manager). When selecting an account for a request, prefer accounts matching `preferred_provider_for_model(model)`, falling back to any available account.

Run: `grep -rn "select_account\|pick_account\|choose_account\|get_next_account\|token_manager" src-tauri/src/proxy/ --include="*.rs" | head -20`

**Step 3: Build check**

Run: `cd src-tauri && cargo check 2>&1 | head -30`

**Step 4: Commit**

```bash
git add src-tauri/src/proxy/common/model_mapping.rs
git commit -m "feat: add model-to-provider routing affinity for Codex accounts"
```

---

## Task 9: Update TypeScript types and account service

**Files:**
- Modify: `src/types/account.ts`
- Modify: `src/services/accountService.ts`

**Step 1: Add `AccountProvider` type and update `Account` interface**

In `src/types/account.ts`, add:

```typescript
export type AccountProvider = 'google' | 'codex';
```

Add to the `Account` interface after `custom_label`:

```typescript
    provider?: AccountProvider;  // 默认 'google'
```

**Step 2: Add Codex service functions in `accountService.ts`**

```typescript
// Codex account management
export async function addCodexAccountManual(token: string, refreshToken?: string): Promise<Account> {
    return await invoke('add_codex_account_manual', { token, refreshToken });
}

export async function importCodexFromFile(): Promise<Account> {
    return await invoke('import_codex_from_file');
}

export async function startCodexOAuthLogin(): Promise<Account> {
    return await invoke('start_codex_oauth_login');
}
```

**Step 3: Commit**

```bash
git add src/types/account.ts src/services/accountService.ts
git commit -m "feat: add Codex account types and service functions in frontend"
```

---

## Task 10: Update Zustand store

**Files:**
- Modify: `src/stores/useAccountStore.ts`

**Step 1: Add Codex actions to store interface**

Add to `AccountState` interface:

```typescript
    addCodexAccountManual: (token: string, refreshToken?: string) => Promise<void>;
    importCodexFromFile: () => Promise<void>;
    startCodexOAuthLogin: () => Promise<void>;
```

**Step 2: Implement the actions**

Add to the store implementation:

```typescript
    addCodexAccountManual: async (token: string, refreshToken?: string) => {
        set({ loading: true, error: null });
        try {
            await accountService.addCodexAccountManual(token, refreshToken);
            await get().fetchAccounts();
            set({ loading: false });
        } catch (error) {
            set({ error: String(error), loading: false });
            throw error;
        }
    },

    importCodexFromFile: async () => {
        set({ loading: true, error: null });
        try {
            await accountService.importCodexFromFile();
            await get().fetchAccounts();
            set({ loading: false });
        } catch (error) {
            set({ error: String(error), loading: false });
            throw error;
        }
    },

    startCodexOAuthLogin: async () => {
        set({ loading: true, error: null });
        try {
            await accountService.startCodexOAuthLogin();
            await get().fetchAccounts();
            set({ loading: false });
        } catch (error) {
            set({ error: String(error), loading: false });
            throw error;
        }
    },
```

**Step 3: Commit**

```bash
git add src/stores/useAccountStore.ts
git commit -m "feat: add Codex account actions to useAccountStore"
```

---

## Task 11: Update AddAccountDialog UI

**Files:**
- Modify: `src/components/accounts/AddAccountDialog.tsx`

**Step 1: Add provider selection step**

At the top of the dialog, before showing tabs, add a provider selector:

```tsx
const [selectedProvider, setSelectedProvider] = useState<'google' | 'codex'>('google');
```

Add a provider selection UI at the beginning of the dialog body:

```tsx
{/* Provider selection */}
<div className="flex gap-2 mb-4">
    <button
        className={cn("flex-1 p-3 rounded-lg border-2 transition-all",
            selectedProvider === 'google' ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200")}
        onClick={() => setSelectedProvider('google')}
    >
        <div className="font-medium">{t('accounts.add.provider_google')}</div>
        <div className="text-xs text-gray-500">Google / Gemini / Claude</div>
    </button>
    <button
        className={cn("flex-1 p-3 rounded-lg border-2 transition-all",
            selectedProvider === 'codex' ? "border-green-500 bg-green-50 dark:bg-green-900/20" : "border-gray-200")}
        onClick={() => setSelectedProvider('codex')}
    >
        <div className="font-medium">{t('accounts.add.provider_codex')}</div>
        <div className="text-xs text-gray-500">OpenAI / GPT / O-series</div>
    </button>
</div>
```

**Step 2: Add Codex-specific tabs**

When `selectedProvider === 'codex'`, show these tabs instead of the Google ones:

```tsx
// Codex tabs: 'codex-oauth' | 'codex-token' | 'codex-import'
```

- **codex-oauth tab**: Call `startCodexOAuthLogin()` — similar to Google OAuth flow
- **codex-token tab**: Text area for pasting `sess-...` or `sk-...` token, optional refresh token field → call `addCodexAccountManual(token, refreshToken)`
- **codex-import tab**: Button to import from `~/.codex/auth.json` → call `importCodexFromFile()`

**Step 3: Commit**

```bash
git add src/components/accounts/AddAccountDialog.tsx
git commit -m "feat: add Codex provider selection and import tabs to AddAccountDialog"
```

---

## Task 12: Add provider badge to account list

**Files:**
- Modify: `src/components/accounts/AccountGrid.tsx`
- Modify: `src/components/accounts/AccountTable.tsx`

**Step 1: Add provider badge component**

Create a small inline component (or add directly in both files):

```tsx
function ProviderBadge({ provider }: { provider?: string }) {
    const isCodex = provider === 'codex';
    return (
        <span className={cn(
            "inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium",
            isCodex ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
        )}>
            {isCodex ? 'Codex' : 'Google'}
        </span>
    );
}
```

**Step 2: Add badge to account cards/rows**

In both `AccountGrid.tsx` and `AccountTable.tsx`, add `<ProviderBadge provider={account.provider} />` next to the account email display.

**Step 3: Commit**

```bash
git add src/components/accounts/AccountGrid.tsx src/components/accounts/AccountTable.tsx
git commit -m "feat: add provider badge (Google/Codex) to account list views"
```

---

## Task 13: Add i18n translation keys

**Files:**
- Modify: `src/locales/en/*.json` (or wherever English translations live)
- Modify: `src/locales/zh/*.json` (or wherever Chinese translations live)

**Step 1: Identify locale file structure**

Run: `ls src/locales/`

**Step 2: Add translation keys**

Add these keys to the appropriate namespace:

```json
{
    "accounts.add.select_provider": "Select AI Provider",
    "accounts.add.provider_google": "Google",
    "accounts.add.provider_codex": "Codex (OpenAI)",
    "accounts.add.codex_oauth": "OAuth Login",
    "accounts.add.codex_oauth_desc": "Login with your OpenAI account",
    "accounts.add.codex_token": "Manual Token",
    "accounts.add.codex_token_desc": "Paste a sess-... token or sk-... API key",
    "accounts.add.codex_token_placeholder": "Enter sess-... or sk-... token",
    "accounts.add.codex_refresh_token_placeholder": "Optional: Enter ref-... refresh token",
    "accounts.add.codex_import": "Import from File",
    "accounts.add.codex_import_desc": "Import from ~/.codex/auth.json",
    "accounts.add.codex_import_btn": "Import from Codex CLI",
    "accounts.provider.google": "Google",
    "accounts.provider.codex": "Codex"
}
```

And the Chinese equivalents.

**Step 3: Commit**

```bash
git add src/locales/
git commit -m "feat: add Codex i18n translation keys (en/zh)"
```

---

## Task 14: Update quota display for Codex accounts

**Files:**
- Modify: `src-tauri/src/commands/mod.rs` (the `fetch_account_quota` command)
- Modify account quota display components in frontend

**Step 1: Guard quota fetch by provider**

In the `fetch_account_quota` command, skip Google-specific quota fetching for Codex accounts:

```rust
// In fetch_account_quota command
let account = crate::modules::account::get_account(&account_id)?;
if account.provider == AccountProvider::Codex {
    // Return a minimal QuotaData for Codex accounts
    return Ok(QuotaData {
        models: vec![],
        last_updated: chrono::Utc::now().timestamp(),
        is_forbidden: Some(false),
        forbidden_reason: None,
        subscription_tier: Some("Codex".to_string()),
        model_forwarding_rules: None,
    });
}
// ... existing Google quota logic
```

**Step 2: Frontend quota display**

Where quota info is displayed, check `account.provider` and show appropriate info for Codex accounts (e.g., "Codex - Active" instead of quota percentages).

**Step 3: Commit**

```bash
git add -u src-tauri/src/commands/ src/
git commit -m "feat: skip Google-specific quota fetch for Codex accounts"
```

---

## Task 15: Integration test and final build

**Step 1: Full Rust build**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`

**Step 2: Frontend TypeScript check**

Run: `npm run build 2>&1 | tail -20`

**Step 3: Full Tauri dev test**

Run: `npx tauri dev`

Manual test checklist:
- [ ] Existing Google accounts still load and work
- [ ] Can add Codex account via manual token input
- [ ] Can import from ~/.codex/auth.json (if file exists)
- [ ] Codex OAuth login flow opens browser
- [ ] Account list shows provider badge
- [ ] Proxy routes requests through Codex accounts to OpenAI upstream
- [ ] Token refresh works for sess-... tokens

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete Codex account proxy integration"
```

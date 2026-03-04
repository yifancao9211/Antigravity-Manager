use serde::{Deserialize, Serialize};
use tracing::info;
use crate::models::TokenData;

// OpenAI Codex OAuth configuration
// Client ID verified from opencode (sst/opencode) source: packages/opencode/src/plugin/codex.ts
const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_AUTH_URL: &str = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
const CODEX_USERINFO_URL: &str = "https://api.openai.com/v1/me";

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

    // Match opencode's PKCE: 43 chars from RFC 7636 unreserved charset
    let charset = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    let mut rng = rand::thread_rng();
    let verifier: String = (0..43)
        .map(|_| {
            let idx = rng.gen_range(0..charset.len());
            charset[idx] as char
        })
        .collect();

    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let hash = hasher.finalize();
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(hash);

    (verifier, challenge)
}

/// Generate Codex OAuth authorization URL
/// Returns (auth_url, code_verifier)
pub fn get_codex_auth_url(redirect_uri: &str, state: &str) -> (String, String) {
    let (verifier, challenge) = generate_pkce();

    let params = vec![
        ("client_id", CODEX_CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", "openid profile email offline_access"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", state),
        ("originator", "antigravity"),
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

/// Codex auth.json file structure (shared by all import paths)
#[derive(Deserialize)]
pub struct CodexAuthFile {
    #[serde(alias = "OPENAI_API_KEY")]
    pub access_token: Option<String>,
    #[serde(alias = "OPENAI_BASE_URL")]
    #[allow(dead_code)]
    pub base_url: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_at: Option<i64>,
}

/// Import Codex account from a specific file path
pub async fn import_from_codex_auth_file_path(path: &std::path::Path) -> Result<TokenData, String> {
    if !path.exists() {
        return Err(format!("Codex auth file not found: {}", path.display()));
    }

    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    let auth: CodexAuthFile = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;

    let access_token = auth.access_token
        .ok_or_else(|| format!("No access_token/OPENAI_API_KEY found in {}", path.display()))?;

    let is_api_key = access_token.starts_with("sk-");

    if is_api_key {
        info!("Importing Codex API key from {}", path.display());
        Ok(build_codex_api_key_token_data(access_token, None))
    } else {
        info!("Importing Codex OAuth token from {}", path.display());
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

/// Import Codex account from ~/.codex/auth.json
pub async fn import_from_codex_auth_file() -> Result<TokenData, String> {
    let home = dirs::home_dir().ok_or("Cannot find home directory")?;
    let auth_path = home.join(".codex").join("auth.json");
    import_from_codex_auth_file_path(&auth_path).await
}

/// Check if a Codex token needs refresh and refresh it if needed
/// Returns Some(new_token) if refreshed, None if no update needed
pub async fn ensure_codex_fresh_token(token: &TokenData) -> Result<Option<TokenData>, String> {
    // API keys don't expire
    if token.access_token.starts_with("sk-") {
        return Ok(None);
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

use serde::{Deserialize, Serialize};
use tracing::info;
use crate::models::TokenData;

// OpenAI Codex OAuth configuration
// Client ID from the openai/codex CLI open source repository
const CODEX_CLIENT_ID: &str = "app_sOb0KOmdLU9kOJVxxGSFEFkH"; // TODO: verify from openai/codex source
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
            let idx = rng.gen_range(0..62u8);
            if idx < 10 { (b'0' + idx) as char }
            else if idx < 36 { (b'A' + idx - 10) as char }
            else { (b'a' + idx - 36) as char }
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
        #[allow(dead_code)]
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
        info!("Importing Codex API key from auth.json");
        Ok(build_codex_api_key_token_data(access_token, None))
    } else {
        info!("Importing Codex OAuth token from auth.json");
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

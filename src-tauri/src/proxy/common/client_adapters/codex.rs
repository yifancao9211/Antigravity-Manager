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
    fn test_codex_adapter_no_match_curl() {
        let adapter = CodexAdapter;
        let mut headers = HeaderMap::new();
        headers.insert("user-agent", HeaderValue::from_static("curl/7.68.0"));
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

    #[test]
    fn test_codex_adapter_strategies() {
        let adapter = CodexAdapter;
        assert!(adapter.let_it_crash());
        assert_eq!(adapter.signature_buffer_strategy(), SignatureBufferStrategy::Fifo);
    }
}

use serde::Deserialize;
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
pub struct GithubPingPayload {
    pub zen: Option<String>,
    pub hook_id: Option<u64>,
    pub hook: Option<Map<String, Value>>,
}

#[cfg(test)]
mod tests {
    use super::GithubPingPayload;

    #[test]
    fn parses_ping_payload() {
        let payload = r#"{"zen":"Keep it simple.","hook_id":123,"hook":{"id":123,"type":"Repository"},"repository":{"full_name":"owner/repo"}}"#;
        let ping: GithubPingPayload = serde_json::from_str(payload).unwrap();
        assert_eq!(ping.zen.as_deref(), Some("Keep it simple."));
        assert_eq!(ping.hook_id, Some(123));
        assert_eq!(ping.hook.unwrap()["type"], "Repository");

        let ping: GithubPingPayload = serde_json::from_str(r#"{"zen":"Keep it simple."}"#).unwrap();
        assert_eq!(ping.zen.as_deref(), Some("Keep it simple."));
        assert!(ping.hook_id.is_none());
        assert!(serde_json::from_str::<GithubPingPayload>(r#"{"hook_id":"invalid"}"#).is_err());
    }
}

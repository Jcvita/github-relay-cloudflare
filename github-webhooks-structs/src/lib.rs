use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
pub struct GithubPingPayload {
    pub zen: Option<String>,
    pub hook_id: Option<u64>,
    pub hook: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GithubPushPayload {
    pub after: String,
    pub base_ref: Option<String>,
    pub before: String,
    pub commits: Vec<PushCommit>,
    pub compare: String,
    pub created: bool,
    pub deleted: bool,
    pub forced: bool,
    pub head_commit: Option<PushCommit>,
    pub pusher: PushPusher,
    pub r#ref: String,
    pub repository: Option<PushRepository>,
    pub sender: Option<PushSender>,
    pub installation: Option<PushInstallation>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushCommit {
    pub id: String,
    pub message: String,
    pub timestamp: Option<String>,
    pub author: Option<PushCommitAuthor>,
    pub committer: Option<PushCommitAuthor>,
    #[serde(default)]
    pub added: Vec<String>,
    #[serde(default)]
    pub removed: Vec<String>,
    #[serde(default)]
    pub modified: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushCommitAuthor {
    pub name: String,
    pub email: Option<String>,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushPusher {
    pub name: String,
    pub email: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushRepository {
    pub id: u64,
    pub name: String,
    pub full_name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushSender {
    pub id: u64,
    pub login: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PushInstallation {
    pub id: u64,
}

pub enum GithubWebhookPayload {
    Push(GithubPushPayload),
    Ping(GithubPingPayload),
}

#[cfg(test)]
mod tests {
    use super::{GithubPingPayload, GithubPushPayload};

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

    #[test]
    fn parses_push_and_deleted_ref() {
        let push = r#"{
            "after": "abcd", "base_ref": null, "before": "1234",
            "commits": [{"id": "abcd", "message": "Update", "added": ["file.txt"]}],
            "compare": "https://github.com/o/r/compare/1234...abcd",
            "created": false, "deleted": false, "forced": false,
            "head_commit": {"id": "abcd", "message": "Update"},
            "pusher": {"name": "octocat", "email": "octocat@example.com"},
            "ref": "refs/heads/main",
            "repository": {"id": 1, "name": "r", "full_name": "o/r"},
            "sender": {"id": 2, "login": "octocat"},
            "installation": {"id": 3}
        }"#;
        let parsed: GithubPushPayload = serde_json::from_str(push).unwrap();
        assert_eq!(parsed.r#ref, "refs/heads/main");
        assert_eq!(parsed.commits[0].added, ["file.txt"]);
        assert_eq!(parsed.repository.as_ref().unwrap().full_name, "o/r");
        assert_eq!(parsed.installation.as_ref().unwrap().id, 3);
        let wire_json = serde_json::to_string(&parsed).unwrap();
        let wire: serde_json::Value = serde_json::from_str(&wire_json).unwrap();
        assert_eq!(wire["ref"], "refs/heads/main");
        assert_eq!(wire["head_commit"]["id"], "abcd");

        let deleted = push
            .replace("\"deleted\": false", "\"deleted\": true")
            .replace(
                "\"head_commit\": {\"id\": \"abcd\", \"message\": \"Update\"}",
                "\"head_commit\": null",
            );
        let parsed: GithubPushPayload = serde_json::from_str(&deleted).unwrap();
        assert!(parsed.deleted);
        assert!(parsed.head_commit.is_none());
    }

    #[test]
    fn rejects_missing_required_push_fields() {
        let payload = r#"{"ref":"refs/heads/main","commits":[]}"#;
        assert!(serde_json::from_str::<GithubPushPayload>(payload).is_err());
    }
}

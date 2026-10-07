use github_webhooks_structs::GithubWebhookPayload;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use worker::Request;

type ValidationError = (u16, &'static str);

#[derive(Debug, Clone)]
pub struct GithubWebhookRequestValidator {
    secret: String,
}

impl GithubWebhookRequestValidator {
    pub fn new(secret: String) -> Self {
        Self { secret }
    }

    pub async fn verify_request_signature(
        &self,
        req: &mut Request,
    ) -> Result<Vec<u8>, ValidationError> {
        let signature = req
            .headers()
            .get("x-hub-signature-256")
            .map_err(|_| (500, "Could not read signature header"))?
            .ok_or((403, "x-hub-signature-256 header is missing!"))?;

        let payload = req
            .bytes()
            .await
            .map_err(|_| (400, "Could not read request body"))?;
        if !verify_signature(&payload, &self.secret, &signature) {
            return Err((403, "Request signatures didn't match!"));
        }

        Ok(payload)
    }

    pub async fn parse_webhook(
        &self,
        req: &mut Request,
    ) -> Result<GithubWebhookPayload, ValidationError> {
        let payload = self.verify_request_signature(req).await?;
        let event = req
            .headers()
            .get("x-github-event")
            .map_err(|_| (500, "Could not read event header"))?;
        parse_webhook_payload(event.as_deref(), &payload)
    }
}

fn parse_webhook_payload(
    event: Option<&str>,
    payload: &[u8],
) -> Result<GithubWebhookPayload, ValidationError> {
    match event {
        Some("push") => serde_json::from_slice(payload)
            .map(GithubWebhookPayload::Push)
            .map_err(|_| (400, "Invalid push webhook payload")),
        Some("ping") => serde_json::from_slice(payload)
            .map(GithubWebhookPayload::Ping)
            .map_err(|_| (400, "Invalid ping webhook payload")),
        _ => Err((400, "Unsupported GitHub webhook event")),
    }
}

fn verify_signature(payload: &[u8], secret: &str, signature: &str) -> bool {
    let Some(hex_signature) = signature.strip_prefix("sha256=") else {
        return false;
    };
    if hex_signature.len() != 64
        || !hex_signature
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    let Ok(digest) = hex::decode(hex_signature) else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .expect("HMAC-SHA256 accepts any key length");
    mac.update(payload);
    mac.verify_slice(&digest).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{parse_webhook_payload, verify_signature, GithubWebhookPayload};

    #[test]
    fn verifies_github_sha256_signature() {
        let payload = b"Hello World!";
        let signature = "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9";
        assert!(verify_signature(
            payload,
            "It's a Secret to Everybody",
            signature
        ));
        assert!(!verify_signature(
            b"Hello World?",
            "It's a Secret to Everybody",
            signature
        ));
        assert!(!verify_signature(payload, "wrong secret", signature));
        assert!(!verify_signature(
            payload,
            "It's a Secret to Everybody",
            "sha1=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9"
        ));
        assert!(!verify_signature(
            payload,
            "It's a Secret to Everybody",
            "sha256=A4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9"
        ));
        assert!(!verify_signature(
            payload,
            "It's a Secret to Everybody",
            "sha256=invalid"
        ));
    }

    #[test]
    fn dispatches_ping_and_rejects_unsupported_events() {
        assert!(matches!(
            parse_webhook_payload(Some("ping"), br#"{"hook_id":42,"zen":"Hi"}"#),
            Ok(GithubWebhookPayload::Ping(_))
        ));
        assert!(parse_webhook_payload(Some("ping"), br#"{"hook_id":"invalid"}"#).is_err());
        assert!(parse_webhook_payload(Some("issues"), br#"{"hook_id":42}"#).is_err());
        assert!(parse_webhook_payload(None, br#"{"hook_id":42}"#).is_err());
    }
}

use subtle::ConstantTimeEq;
use worker::*;

pub mod github_webhook;
use github_webhook::GithubWebhookRequestValidator;
use github_webhooks_structs::GithubWebhookPayload;

const PUSH_WEBHOOK_PATH: &str = "/webhooks/github/push";
const WEBSOCKET_PATH: &str = "/relay/ws";
const BROADCAST_OBJECT_NAME: &str = "github-push-broadcast";

#[durable_object]
pub struct GithubHookRelay {
    state: State,
    env: Env,
}

impl DurableObject for GithubHookRelay {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        match req.path().as_str() {
            PUSH_WEBHOOK_PATH => {
                if req.method() != Method::Post {
                    return Response::error("Method not allowed", 405);
                }
                self.handle_webhook(&mut req).await
            }
            WEBSOCKET_PATH => {
                if req.method() != Method::Get {
                    return Response::error("Method not allowed", 405);
                }
                self.handle_websocket(&req)
            }
            _ => Response::error("Not found", 404),
        }
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        _message: WebSocketIncomingMessage,
    ) -> Result<()> {
        ws.close(Some(1003), Some("Push notifications only"))
    }

    async fn websocket_close(
        &self,
        _ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        Ok(())
    }

    async fn websocket_error(&self, _ws: WebSocket, error: Error) -> Result<()> {
        console_error!("WebSocket error: {}", error);
        Ok(())
    }
}

impl GithubHookRelay {
    async fn handle_webhook(&self, req: &mut Request) -> Result<Response> {
        let secret = self.env.secret("GITHUB_WEBHOOK_SECRET")?.to_string();
        if secret.is_empty() {
            return Response::error("Webhook secret is empty", 500);
        }
        let validator = GithubWebhookRequestValidator::new(secret);
        match validator.parse_webhook(req).await {
            Ok(GithubWebhookPayload::Push(payload)) => {
                let json = serde_json::to_string(&payload)?;
                for socket in self.state.get_websockets() {
                    if let Err(error) = socket.send_with_str(&json) {
                        console_error!("Failed to deliver push over WebSocket: {}", error);
                    }
                }
                Response::ok("OK")
            }
            Ok(GithubWebhookPayload::Ping(_ping)) => Response::ok("OK"),
            Err((status, message)) => Response::error(message, status),
        }
    }

    fn handle_websocket(&self, req: &Request) -> Result<Response> {
        if !req
            .headers()
            .get("upgrade")?
            .as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
        {
            return Response::error("WebSocket upgrade required", 426);
        }
        let secret = self
            .env
            .secret("GITHUB_RELAY_WEBSOCKET_SECRET")?
            .to_string();
        if secret.is_empty() {
            return Response::error("WebSocket secret is empty", 500);
        }
        if !authorized(req.headers().get("authorization")?.as_deref(), &secret) {
            return Response::error("Unauthorized", 401);
        }

        let pair = WebSocketPair::new()?;
        self.state.accept_web_socket(&pair.server);
        Response::from_websocket(pair.client)
    }
}

fn authorized(header: Option<&str>, secret: &str) -> bool {
    header
        .and_then(|value| value.strip_prefix("Bearer "))
        .is_some_and(|token| bool::from(secret.as_bytes().ct_eq(token.as_bytes())))
}

#[event(fetch)]
async fn fetch(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let path = req.path();
    if path == "/" && req.method() == Method::Get {
        return Response::ok("Hello Axum!");
    }
    match path.as_str() {
        PUSH_WEBHOOK_PATH if req.method() != Method::Post => {
            return Response::error("Method not allowed", 405);
        }
        WEBSOCKET_PATH if req.method() != Method::Get => {
            return Response::error("Method not allowed", 405);
        }
        PUSH_WEBHOOK_PATH | WEBSOCKET_PATH => {}
        _ => return Response::error("Not found", 404),
    }

    let namespace = env.durable_object("GITHUB_HOOK_RELAY")?;
    let stub = namespace.id_from_name(BROADCAST_OBJECT_NAME)?.get_stub()?;
    stub.fetch_with_request(req).await
}

#[cfg(test)]
mod tests {
    use super::authorized;

    #[test]
    fn websocket_requires_matching_bearer_secret() {
        assert!(authorized(Some("Bearer correct-secret"), "correct-secret"));
        assert!(!authorized(None, "correct-secret"));
        assert!(!authorized(Some("Bearer wrong-secret"), "correct-secret"));
        assert!(!authorized(Some("correct-secret"), "correct-secret"));
        assert!(!authorized(
            Some("Bearer correct-secret-extra"),
            "correct-secret"
        ));
    }
}

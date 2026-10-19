use subtle::ConstantTimeEq;
use worker::*;

pub mod github_webhook;
use github_webhook::GithubWebhookRequestValidator;
use github_webhooks_structs::GithubWebhookPayload;

const BROADCAST_OBJECT_NAME: &str = "github-push-broadcast";

#[derive(Debug, PartialEq)]
enum RelayRoute {
    Webhook,
    WebSocket,
}

struct RelayPaths {
    webhook: String,
    websocket: String,
}

impl RelayPaths {
    fn from_env(env: &Env) -> Result<Self> {
        Self::new(
            env.var("CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH")?.to_string(),
            env.var("CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH")?.to_string(),
        )
    }

    fn new(webhook: String, websocket: String) -> Result<Self> {
        if !valid_relay_path(&webhook)
            || !valid_relay_path(&websocket)
            || webhook == websocket
            || webhook.starts_with(&format!("{websocket}/"))
            || websocket.starts_with(&format!("{webhook}/"))
        {
            return Err(Error::RustError(
                "Relay paths must be canonical, non-root, distinct and non-nested".into(),
            ));
        }
        Ok(Self { webhook, websocket })
    }

    fn route(&self, path: &str) -> Option<RelayRoute> {
        if path == self.webhook {
            Some(RelayRoute::Webhook)
        } else if path == self.websocket {
            Some(RelayRoute::WebSocket)
        } else {
            None
        }
    }
}

fn valid_relay_path(path: &str) -> bool {
    path.starts_with('/')
        && path[1..].split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~')
                })
        })
}

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
        let paths = match RelayPaths::from_env(&self.env) {
            Ok(paths) => paths,
            Err(error) => {
                console_error!("Invalid relay path configuration: {}", error);
                return Response::error("Invalid relay path configuration", 500);
            }
        };
        match paths.route(&req.path()) {
            Some(RelayRoute::Webhook) => {
                if req.method() != Method::Post {
                    return Response::error("Method not allowed", 405);
                }
                self.handle_webhook(&mut req).await
            }
            Some(RelayRoute::WebSocket) => {
                if req.method() != Method::Get {
                    return Response::error("Method not allowed", 405);
                }
                self.handle_websocket(&req)
            }
            None => Response::error("Not found", 404),
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
    let paths = match RelayPaths::from_env(&env) {
        Ok(paths) => paths,
        Err(error) => {
            console_error!("Invalid relay path configuration: {}", error);
            return Response::error("Invalid relay path configuration", 500);
        }
    };
    match paths.route(&path) {
        Some(RelayRoute::Webhook) if req.method() != Method::Post => {
            return Response::error("Method not allowed", 405);
        }
        Some(RelayRoute::WebSocket) if req.method() != Method::Get => {
            return Response::error("Method not allowed", 405);
        }
        Some(_) => {}
        None => return Response::error("Not found", 404),
    }

    let namespace = env.durable_object("GITHUB_HOOK_RELAY")?;
    let stub = namespace.id_from_name(BROADCAST_OBJECT_NAME)?.get_stub()?;
    stub.fetch_with_request(req).await
}

#[cfg(test)]
mod tests {
    use super::{authorized, valid_relay_path, RelayPaths, RelayRoute};

    #[test]
    fn configured_paths_replace_default_routes() {
        let paths = RelayPaths::new("/custom/github".into(), "/custom/socket".into()).unwrap();
        assert_eq!(paths.route("/custom/github"), Some(RelayRoute::Webhook));
        assert_eq!(paths.route("/custom/socket"), Some(RelayRoute::WebSocket));
        assert_eq!(paths.route("/relay/webhooks/github/push"), None);
        assert_eq!(paths.route("/relay/ws"), None);
        assert_eq!(paths.route("/custom/github/extra"), None);
        assert_eq!(paths.route("/custom/socket/"), None);
    }

    #[test]
    fn paths_reject_ambiguous_url_forms() {
        for path in [
            "", "/", "relative", "//hook", "/hook/", "/hook//push", "/a/./b",
            "/a/../b", "/hook?x=1", "/hook#fragment", "/hook*", "/a%2fb",
            "/a\\b", "/has space", "/caf\u{e9}",
        ] {
            assert!(!valid_relay_path(path), "Accepted invalid path: {path}");
        }
        assert!(valid_relay_path("/hooks/github.push_v2-~"));
    }

    #[test]
    fn paths_must_be_distinct_and_non_nested() {
        for (webhook, websocket) in [
            ("/same", "/same"),
            ("/relay", "/relay/ws"),
            ("/relay/hook", "/relay"),
        ] {
            assert!(RelayPaths::new(webhook.into(), websocket.into()).is_err());
        }
        assert!(RelayPaths::new("/hook".into(), "/hooks".into()).is_ok());
    }

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

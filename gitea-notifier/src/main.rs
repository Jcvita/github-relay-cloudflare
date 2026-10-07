use std::{env, error::Error, io, path::Path, time::Duration};

use futures_util::StreamExt;
use serde::Deserialize;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        Message,
        client::IntoClientRequest,
        http::{HeaderValue, header::AUTHORIZATION},
    },
};
use url::Url;

const MIN_RETRY: Duration = Duration::from_secs(1);
const MAX_RETRY: Duration = Duration::from_secs(30);

struct Config {
    url: Url,
    secret: String,
}

impl Config {
    fn load() -> Result<Self, Box<dyn Error>> {
        if Path::new(".env").exists() {
            dotenvy::from_filename(".env")
                .map_err(|_| io::Error::other("could not read .env in the current directory"))?;
        }
        Self::from_values(
            env::var("WEBSOCKET_URL")?,
            env::var("GITHUB_RELAY_WEBSOCKET_SECRET")?,
        )
    }

    fn from_values(url: String, secret: String) -> Result<Self, Box<dyn Error>> {
        let url = Url::parse(&url)?;
        if !matches!(url.scheme(), "wss" | "ws")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/relay/ws"
        {
            return Err(
                "WEBSOCKET_URL must be a ws(s) URL ending in /relay/ws (no query or credentials)"
                    .into(),
            );
        }
        if secret.is_empty() || secret.trim() != secret {
            return Err(
                "GITHUB_RELAY_WEBSOCKET_SECRET must be nonempty with no surrounding whitespace"
                    .into(),
            );
        }
        Ok(Self { url, secret })
    }

    fn request(&self) -> Result<tokio_tungstenite::tungstenite::http::Request<()>, Box<dyn Error>> {
        let mut request = self.url.as_str().into_client_request()?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", self.secret))?;
        authorization.set_sensitive(true);
        request.headers_mut().insert(AUTHORIZATION, authorization);
        Ok(request)
    }
}

#[derive(Debug, Deserialize, PartialEq)]
struct PushEvent {
    #[serde(rename = "ref")]
    git_ref: String,
    after: String,
    repository: Repository,
    #[serde(default)]
    commits: Vec<Commit>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Repository {
    full_name: String,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Commit {
    id: String,
    message: String,
}

fn print_event(data: &[u8]) {
    match serde_json::from_slice::<PushEvent>(data) {
        Ok(event) => println!("{event:#?}"),
        Err(error) => eprintln!("Invalid GitHub push payload: {error}"),
    }
}

async fn listen(config: &Config) -> Result<(), Box<dyn Error>> {
    let (mut socket, _) = connect_async(config.request()?).await?;
    eprintln!("Connected to GitHub push relay");
    while let Some(message) = socket.next().await {
        match message? {
            Message::Text(text) => print_event(text.as_bytes()),
            Message::Binary(bytes) => print_event(&bytes),
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("Failed to install rustls crypto provider");
    let config = Config::load()?;
    let mut retry = MIN_RETRY;
    loop {
        let started = tokio::time::Instant::now();
        if let Err(error) = listen(&config).await {
            eprintln!("WebSocket connection ended: {error}");
        } else {
            eprintln!("WebSocket disconnected");
        }
        if started.elapsed() >= MAX_RETRY {
            retry = MIN_RETRY;
        }
        eprintln!("Reconnecting in {}s", retry.as_secs());
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(MAX_RETRY);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        accept_hdr_async,
        tungstenite::handshake::server::{Request, Response},
    };

    #[test]
    fn accepts_only_relay_websocket_urls() {
        assert!(
            Config::from_values(
                "wss://worker.example/relay/ws".into(),
                "shared-secret".into()
            )
            .is_ok()
        );
        for url in [
            "https://worker.example/relay/ws",
            "wss://worker.example/relay/ws/",
            "wss://worker.example/relay/ws/12345",
            "wss://worker.example/relay/ws/123/extra",
            "wss://worker.example/relay/ws?other=1",
        ] {
            assert!(
                Config::from_values(url.into(), "secret".into()).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn handshake_includes_bearer_secret() {
        let config =
            Config::from_values("wss://worker.example/relay/ws".into(), "secret".into()).unwrap();
        let request = config.request().unwrap();
        assert_eq!(request.headers()[AUTHORIZATION], "Bearer secret");
        assert!(request.headers()[AUTHORIZATION].is_sensitive());
        assert!(Config::from_values(config.url.to_string(), " ".into()).is_err());
        assert!(Config::from_values(config.url.to_string(), "secret\n".into()).is_err());
    }

    #[test]
    fn deserializes_github_push_event() {
        let payload = r#"{
            "ref": "refs/heads/main",
            "after": "abc123",
            "repository": {"full_name": "owner/repo", "private": true},
            "commits": [{"id": "abc123", "message": "Update", "added": ["file.txt"]}],
            "sender": {"login": "user"}
        }"#;
        let event: PushEvent = serde_json::from_str(payload).unwrap();
        assert_eq!(event.git_ref, "refs/heads/main");
        assert_eq!(event.repository.full_name, "owner/repo");
        assert_eq!(event.commits[0].id, "abc123");
        assert!(serde_json::from_str::<PushEvent>(r#"{"repository":{}}"#).is_err());
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn connects_with_authorization_and_consumes_push() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(tcp, |request: &Request, response: Response| {
                assert_eq!(request.uri().path(), "/relay/ws");
                assert_eq!(request.headers()[AUTHORIZATION], "Bearer test-secret");
                Ok(response)
            })
            .await
            .unwrap();
            socket
                .send(Message::Text(
                    r#"{"ref":"refs/heads/main","after":"abc","repository":{"full_name":"owner/repo"}}"#
                        .into(),
                ))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
        });

        let config =
            Config::from_values(format!("ws://{address}/relay/ws"), "test-secret".into()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), listen(&config))
            .await
            .unwrap()
            .unwrap();
        server.await.unwrap();
    }
}

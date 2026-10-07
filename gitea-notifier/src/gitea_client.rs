use reqwest::Client;

pub struct GiteaUserClient {
    client: Client,
    /// The host URL of the Gitea instance. Example: "https://gitea.example.com"
    host: String,
    /// The username of the Gitea account. Example: "admin"
    user: String,

}


impl GiteaUserClient {
    pub fn new(token: &str, host: &str, user: &str) -> Self {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::AUTHORIZATION,
            format!("token {}", token).parse().unwrap(),
        );

        let client = Client::builder()
            .default_headers(headers)
            .build()
            .expect("Failed to build reqwest client");


        Self {
            client,
            host: host.to_string(),
            user: user.to_string(),
        }
    }

    pub async fn issue_sync(&self, repository_name: &str) -> Result<(), GiteaRequestError> { 
        let url = format!(
            "{}/api/v1/repos/{}/{}/mirror-sync",
            self.host, self.user, repository_name
        );

        let response = self.client.post(&url).send().await?;
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            let error = match status {
                reqwest::StatusCode::FORBIDDEN => GiteaRequestError::Forbidden(text),
                reqwest::StatusCode::NOT_FOUND => GiteaRequestError::NotFound(text),
                _ => GiteaRequestError::UnknownError(text),
            };
            Err(error)
        }
    }

    pub fn issue_sync_sync(&self, repository_name: &str) -> Result<(), GiteaRequestError> {
        tokio::runtime::Runtime::new().unwrap().block_on(self.issue_sync(repository_name))
    }
}

#[derive(Debug)]
pub enum GiteaRequestError {
    ReqwestError(reqwest::Error),
    Forbidden(String),
    NotFound(String),
    UnknownError(String),
}

impl From<reqwest::Error> for GiteaRequestError {
    fn from(err: reqwest::Error) -> Self {
        GiteaRequestError::ReqwestError(err)
    }
}

impl std::fmt::Display for GiteaRequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GiteaRequestError::ReqwestError(err) => write!(f, "Reqwest error: {}", err),
            GiteaRequestError::Forbidden(msg) => write!(f, "Forbidden: {}", msg),
            GiteaRequestError::NotFound(msg) => write!(f, "Not Found: {}", msg),
            GiteaRequestError::UnknownError(msg) => write!(f, "Unknown Error: {}", msg),  
        }
    }
}

impl std::error::Error for GiteaRequestError {}
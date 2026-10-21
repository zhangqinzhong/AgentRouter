use ai_memory_core::Sanitizer;
use serde::de::DeserializeOwned;

use crate::error::{LlmError, LlmResult};
use crate::text::truncate_with_ellipsis;

/// Generous cap for successful provider responses. Normal chat, structured
/// output, SSE transcripts, and embedding payloads are far smaller; this only
/// protects us from broken or hostile provider endpoints buffering forever.
pub(crate) const MAX_PROVIDER_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_PROVIDER_ERROR_BYTES: usize = 1024 * 1024;
const DISPLAY_ERROR_BYTES: usize = 1024;

pub(crate) async fn response_bytes_limited(
    mut resp: reqwest::Response,
    max_bytes: usize,
) -> LlmResult<Vec<u8>> {
    let status = resp.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(LlmError::from)? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(LlmError::Provider {
                status,
                body: format!("provider response exceeded {max_bytes} bytes"),
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub(crate) async fn response_text_limited(resp: reqwest::Response) -> LlmResult<String> {
    let bytes = response_bytes_limited(resp, MAX_PROVIDER_RESPONSE_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) async fn response_json_limited<T: DeserializeOwned>(
    resp: reqwest::Response,
) -> LlmResult<T> {
    let bytes = response_bytes_limited(resp, MAX_PROVIDER_RESPONSE_BYTES).await?;
    serde_json::from_slice(&bytes).map_err(LlmError::from)
}

/// Read a failed response's body for an error message: at most 1 MiB is
/// read, secrets and terminal control sequences are scrubbed, and at most
/// 1 KiB is kept.
///
/// Gateways and providers echo request content in error bodies, and the
/// result is printed to a terminal or carried in [`LlmError::Provider`].
/// Scrubbing runs before the cut so a secret straddling the 1 KiB boundary
/// is still redacted rather than left as an unrecognisable prefix.
pub async fn provider_error_body(resp: reqwest::Response) -> String {
    match response_bytes_limited(resp, MAX_PROVIDER_ERROR_BYTES).await {
        Ok(bytes) => {
            let body = Sanitizer::builtin().scrub(&String::from_utf8_lossy(&bytes));
            truncate_with_ellipsis(&body, DISPLAY_ERROR_BYTES)
        }
        Err(LlmError::Provider { body, .. }) => body,
        Err(e) => format!("<failed to read provider error body: {e}>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Answer one request on a loopback port with `status` and `body`.
    async fn serve_once(status: &'static str, body: String) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            let mut buf = [0_u8; 4096];
            let _ = stream.read(&mut buf).await;
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body.as_bytes()).await;
        });
        format!("http://{addr}/")
    }

    async fn error_body_for(body: String) -> String {
        let url = serve_once("400 Bad Request", body).await;
        let resp = reqwest::Client::new().get(url).send().await.unwrap();
        provider_error_body(resp).await
    }

    #[tokio::test]
    async fn provider_error_body_redacts_a_secret_straddling_the_display_cut() {
        // The cut keeps `ghp_` plus 12 characters: too short for the GitHub
        // token pattern, so only scrubbing before the cut redacts it.
        let secret = format!("ghp_{}", "FAKEfake0123".repeat(3));
        let prefix = format!("{} ", "x".repeat(DISPLAY_ERROR_BYTES - 17));
        let body = format!("{prefix}{secret}");

        let shown = error_body_for(body).await;

        assert!(!shown.contains("ghp_"), "secret prefix leaked: {shown}");
        assert!(shown.starts_with(&prefix), "unrelated text was lost");
    }

    #[tokio::test]
    async fn provider_error_body_strips_terminal_control_sequences() {
        let shown = error_body_for("before\x1b]0;retitled\x07\x1b[2Jafter".to_string()).await;

        assert!(
            !shown.contains('\x1b'),
            "escape sequence survived: {shown:?}"
        );
        assert!(!shown.contains('\x07'), "bell survived: {shown:?}");
        assert!(shown.starts_with("before"));
    }

    #[tokio::test]
    async fn provider_error_body_caps_what_it_reads_and_what_it_shows() {
        let shown = error_body_for("a".repeat(MAX_PROVIDER_ERROR_BYTES - 1)).await;
        assert!(shown.len() <= DISPLAY_ERROR_BYTES + "…".len());

        let oversized = error_body_for("a".repeat(MAX_PROVIDER_ERROR_BYTES + 1)).await;
        assert!(oversized.contains("exceeded"), "unexpected: {oversized}");
    }
}

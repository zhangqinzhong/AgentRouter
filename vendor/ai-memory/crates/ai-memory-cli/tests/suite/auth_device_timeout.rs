//! Device-login deadlines cover HTTP polling and provider-directed waits.

mod slow {
    use std::path::Path;
    use std::process::Output;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use axum::http::StatusCode;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;
    use tokio::sync::Notify;

    const BIN: &str = env!("CARGO_BIN_EXE_ai-memory");

    #[derive(Clone, Copy)]
    enum Reply {
        Error(&'static str),
        Token(Duration),
    }

    struct Issuer {
        url: String,
        polled: Arc<Notify>,
        polls: Arc<AtomicUsize>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Issuer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn issuer(reply: Reply) -> Issuer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let discovery = json!({
            "device_authorization_endpoint": format!("{url}/device"),
            "token_endpoint": format!("{url}/token"),
        });
        let device = json!({
            "device_code": "synthetic-device-code",
            "user_code": "TEST-CODE",
            "verification_uri": format!("{url}/verify"),
            "interval": 20,
            "expires_in": 600,
        });
        let polled = Arc::new(Notify::new());
        let polls = Arc::new(AtomicUsize::new(0));
        let notify = Arc::clone(&polled);
        let count = Arc::clone(&polls);
        let app = Router::new()
            .route(
                "/.well-known/openid-configuration",
                get(move || async move { Json(discovery) }),
            )
            .route("/device", post(move || async move { Json(device) }))
            .route(
                "/token",
                post(move || {
                    let notify = Arc::clone(&notify);
                    let count = Arc::clone(&count);
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        notify.notify_one();
                        match reply {
                            Reply::Error(error) => {
                                (StatusCode::BAD_REQUEST, Json(json!({ "error": error })))
                            }
                            Reply::Token(delay) => {
                                tokio::time::sleep(delay).await;
                                (
                                    StatusCode::OK,
                                    Json(json!({
                                        "access_token": "synthetic-access",
                                        "refresh_token": "synthetic-refresh",
                                        "expires_in": 600,
                                    })),
                                )
                            }
                        }
                    }
                }),
            );
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Issuer {
            url,
            polled,
            polls,
            task,
        }
    }

    async fn login(root: &Path, issuer: &Issuer, timeout_secs: &str) -> Output {
        let mut command = crate::e2e_support::hermetic(BIN);
        command
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("AI_MEMORY_HOME", root)
            .env("XDG_CONFIG_HOME", root.join("config"))
            .env("NO_PROXY", "127.0.0.1,localhost")
            .env("no_proxy", "127.0.0.1,localhost")
            .current_dir(root)
            .arg("--data-dir")
            .arg(root.join("data"))
            .args([
                "auth",
                "login",
                "oidc-device",
                "--issuer",
                &issuer.url,
                "--client-id",
                "synthetic-client",
                "--timeout-secs",
                timeout_secs,
            ]);
        let mut command = tokio::process::Command::from(command);
        command.kill_on_drop(true);
        let output = command.output();
        tokio::pin!(output);
        // Budget process startup separately: the product deadline starts only
        // once the device code is issued, not while macOS scans the binary.
        tokio::select! {
            biased;
            result = tokio::time::timeout(Duration::from_secs(30), issuer.polled.notified()) => {
                result.expect("login never reached the loopback token endpoint");
            }
            result = &mut output => panic!("login ended before polling: {result:?}"),
        }
        tokio::time::timeout(Duration::from_secs(5), &mut output)
            .await
            .expect("the one-second login deadline did not cancel polling")
            .unwrap()
    }

    #[rstest::rstest]
    #[case("authorization_pending")]
    #[case("slow_down")]
    #[tokio::test]
    async fn deadline_interrupts_provider_polling_waits(#[case] error: &'static str) {
        let root = tempfile::tempdir().unwrap();
        let issuer = issuer(Reply::Error(error)).await;
        let output = login(root.path(), &issuer, "1").await;
        assert!(!output.status.success(), "{output:?}");
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("timed out waiting for oidc-device authorization"),
            "{output:?}",
        );
        assert_eq!(issuer.polls.load(Ordering::SeqCst), 1);
        assert!(!root.path().join("data/auth.json").exists());
    }

    #[tokio::test]
    async fn deadline_discards_a_late_token_without_changing_stored_credentials() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("data")).unwrap();
        let token_path = root.path().join("data/auth.json");
        let original = r#"{"fixture":{"keep":"unrelated-provider"}}"#;
        std::fs::write(&token_path, original).unwrap();
        let issuer = issuer(Reply::Token(Duration::from_secs(3))).await;
        let output = login(root.path(), &issuer, "1").await;
        assert!(
            !output.status.success(),
            "late authorization succeeded: {output:?}"
        );
        assert!(
            String::from_utf8_lossy(&output.stderr)
                .contains("timed out waiting for oidc-device authorization"),
            "{output:?}",
        );
        assert_eq!(std::fs::read_to_string(token_path).unwrap(), original);
        assert_eq!(issuer.polls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn authorization_before_the_deadline_still_saves_the_token() {
        let root = tempfile::tempdir().unwrap();
        let issuer = issuer(Reply::Token(Duration::ZERO)).await;
        let output = login(root.path(), &issuer, "10").await;
        assert!(output.status.success(), "{output:?}");
        let stored: serde_json::Value =
            serde_json::from_slice(&std::fs::read(root.path().join("data/auth.json")).unwrap())
                .unwrap();
        assert_eq!(stored["oidc"]["access"], "synthetic-access");
        assert_eq!(issuer.polls.load(Ordering::SeqCst), 1);
    }
}

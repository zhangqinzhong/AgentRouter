//! The server and thin clients must resolve the same configured HTTP mount.

/// These tests start the shipped binary with isolated homes and stores.
mod slow {
    use std::path::Path;
    use std::process::Command;
    use std::time::Duration;

    use reqwest::StatusCode;

    use crate::e2e_support::{ServerGuard, hermetic, start_serve};

    const BIN: &str = env!("CARGO_BIN_EXE_ai-memory");
    const TOKEN: &str = "base-path-fixture-root";

    fn command(root: &Path) -> Command {
        let mut command = hermetic(BIN);
        command
            .env("HOME", root)
            .env("USERPROFILE", root)
            .env("AI_MEMORY_HOME", root)
            .env("AI_MEMORY_DATA_DIR", root.join("data"))
            .env("AI_MEMORY_EMBEDDING_PROVIDER", "none")
            .env("AI_MEMORY_BACKFILL_ON_START", "false")
            .env("RUST_LOG", "off")
            .current_dir(root);
        command
    }

    async fn serve(
        client: &reqwest::Client,
        root: &Path,
        config_prefix: Option<&str>,
        env_prefix: Option<&str>,
        flag_prefix: Option<&str>,
        with_web_auth: bool,
    ) -> (ServerGuard, String) {
        std::fs::create_dir_all(root.join("data")).unwrap();
        start_serve(client, &root.join("serve.log"), |port| {
            let mut config = format!("bind = \"127.0.0.1:{port}\"\n");
            if let Some(prefix) = config_prefix {
                config.push_str(&format!("base_path = {prefix:?}\n"));
            }
            config.push_str(
                "[maintenance]\nenabled = false\n[auto_improve.scheduler]\nenabled = false\n",
            );
            if with_web_auth {
                config.push_str(&format!("[auth]\nbearer_token = {TOKEN:?}\n"));
            }
            std::fs::write(root.join("data/config.toml"), config).unwrap();
            let mut command = command(root);
            command.args(["serve", "--transport", "http", "--no-watcher"]);
            if let Some(prefix) = env_prefix {
                command.env("AI_MEMORY_BASE_PATH", prefix);
            }
            if let Some(prefix) = flag_prefix {
                command.args(["--base-path", prefix]);
            }
            if with_web_auth {
                command.arg("--enable-web");
            }
            command
        })
        .await
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn toml_base_path_keeps_clients_web_and_auth_on_the_same_mount() {
        let root = tempfile::tempdir().unwrap();
        let client = client();
        let (_server, origin) = serve(&client, root.path(), Some("/wiki/"), None, None, true).await;

        assert_eq!(
            client
                .get(format!("{origin}/wiki/healthz"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
        );
        for path in ["/healthz", "/admin/status", "/web/login"] {
            assert_eq!(
                client
                    .get(format!("{origin}{path}"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND,
                "root route {path} must not alias the configured mount",
            );
        }
        let status_url = format!("{origin}/wiki/admin/status");
        for bearer in [None, Some("wrong-fixture-token")] {
            let mut request = client.get(&status_url);
            if let Some(bearer) = bearer {
                request = request.bearer_auth(bearer);
            }
            assert_eq!(
                request.send().await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            client
                .get(&status_url)
                .bearer_auth(TOKEN)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
        );
        assert_eq!(
            client
                .get(&status_url)
                .bearer_auth(TOKEN)
                .header("host", "foreign.invalid")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN,
        );

        let login = client
            .get(format!("{origin}/wiki/web/login"))
            .send()
            .await
            .unwrap();
        assert_eq!(login.status(), StatusCode::OK);
        assert!(
            login
                .text()
                .await
                .unwrap()
                .contains("<base href=\"/wiki/web/\"")
        );
        assert_eq!(
            client
                .get(format!("{origin}/favicon.ico"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
            "the public favicon stays at the host root",
        );

        let output = command(root.path())
            .args(["status", "--json"])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let status: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(status["counts"]["sessions"], 0);
    }

    #[tokio::test]
    async fn base_path_flag_and_env_override_toml_including_explicit_root() {
        let client = client();
        for (env, flag, expected) in [
            (Some("/env"), None, "/env"),
            (Some("/env"), Some("/flag"), "/flag"),
            (Some("/env"), Some(""), ""),
            (Some(""), None, ""),
            (None, Some("/"), ""),
        ] {
            let root = tempfile::tempdir().unwrap();
            let (_server, origin) =
                serve(&client, root.path(), Some("/wiki"), env, flag, false).await;
            assert_eq!(
                client
                    .get(format!("{origin}{expected}/healthz"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::OK,
                "env={env:?}, flag={flag:?}",
            );
            assert_eq!(
                client
                    .get(format!("{origin}/wiki/healthz"))
                    .send()
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND,
            );
        }
    }

    #[tokio::test]
    async fn no_base_path_keeps_the_root_mount() {
        let root = tempfile::tempdir().unwrap();
        let client = client();
        let (_server, origin) = serve(&client, root.path(), None, None, None, false).await;
        assert_eq!(
            client
                .get(format!("{origin}/healthz"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::OK,
        );
    }
}

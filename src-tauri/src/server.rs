//! The local helper: the Rust counterpart of `serve.py`, kept route for route the same so the
//! page does not care which one it talks to.
//!
//!   * serves the editor's files, which are built into the program;
//!   * runs "Sign in with ChatGPT" (OpenAI sends the sign-in back to a loopback address) and
//!     keeps the tokens in a file in the home directory, shared with `serve.py`; the page never
//!     sees them;
//!   * forwards a fixed list of requests to api.openai.com;
//!   * saves exported files through a "Save as" dialog (`/api/save`, desktop only).
//!
//! It listens on 127.0.0.1 only and refuses API requests that do not come from its own page.

use std::{
    collections::HashMap,
    net::TcpListener,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::Response,
    Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use include_dir::{include_dir, Dir};
use rand::RngCore;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

static WEB: Dir<'_> = include_dir!("$OUT_DIR/web");

// OpenAI's sign-in for locally run, open-source apps ("Sign in with ChatGPT").
const AUTH_HOST: &str = "auth.openai.com";
const AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
const TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
const API_ORIGIN: &str = "https://api.openai.com";
const RESOURCE: &str = "https://api.openai.com/v1";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// A first sign-in registers this app and gets its own client id back, which is used from then on.
const FIRST_CLIENT_ID: &str = "dynamic_agent_client";
const APP_NAME: &str = "Planetarium Spatial Editor";

/// The only things the page may ask the helper to forward.
const FORWARDABLE: [(&str, &str); 4] = [
    ("POST", "/v1/responses"),
    ("POST", "/v1/images/generations"),
    ("POST", "/v1/images/edits"),
    ("GET", "/v1/models"),
];

/// Exported packs and projects embed pictures and videos, so bodies can be large.
const MAX_BODY: usize = 512 * 1024 * 1024;

/// The sign-in in progress. One at a time.
#[derive(Clone)]
struct Pending {
    state: String,
    nonce: String,
    verifier: String,
    redirect_uri: String,
    client_id: String,
}

struct Shared {
    app: AppHandle,
    port: u16,
    http: reqwest::Client,
    pending: Mutex<Option<Pending>>,
    /// Why the last sign-in failed, shown by the page; cleared when a new one starts.
    last_error: Mutex<String>,
    /// Serialises reads and writes of the token file, and token refreshes.
    store: tokio::sync::Mutex<()>,
}

type Store = Map<String, Value>;

pub fn start(app: AppHandle, listener: TcpListener, port: u16) {
    let shared = Arc::new(Shared {
        app,
        port,
        http: reqwest::Client::builder().connect_timeout(Duration::from_secs(30)).build().expect("an HTTP client"),
        pending: Mutex::new(None),
        last_error: Mutex::new(String::new()),
        store: tokio::sync::Mutex::new(()),
    });
    let router = Router::new().fallback(handle).layer(DefaultBodyLimit::max(MAX_BODY)).with_state(shared);
    tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("a listening socket");
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("the local server stopped: {error}");
        }
    });
}

// ---------------------------------------------------------------------------- small helpers

fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

fn random_token(bytes: usize) -> String {
    let mut raw = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

fn same(a: &str, b: &str) -> bool {
    // Compared without stopping at the first difference.
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn text<'a>(map: &'a Store, key: &str) -> &'a str {
    map.get(key).and_then(Value::as_str).unwrap_or("")
}

fn respond(status: StatusCode, content_type: &str, cache: &str, body: impl Into<Body>) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .body(body.into())
        .expect("a well-formed response")
}

fn send_json(status: StatusCode, body: Value) -> Response {
    respond(status, "application/json", "no-store", body.to_string())
}

fn send_page(status: StatusCode, title: &str, message: &str) -> Response {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let (title, message) = (escape(title), escape(message));
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"font:16px system-ui;background:#14151a;color:#e7e8ee;display:grid;place-items:center;height:100vh;margin:0\">\
         <div style=\"max-width:520px;padding:24px;text-align:center\"><h1 style=\"font-size:20px\">{title}</h1><p>{message}</p></div>"
    );
    respond(status, "text/html; charset=utf-8", "no-store", html)
}

fn header_text<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

/// The payload of a JWT, without checking its signature.
fn claims_of(jwt: &str) -> Store {
    jwt.split('.')
        .nth(1)
        .and_then(|payload| URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok())
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn describe(body: &Value) -> String {
    match body.get("error") {
        Some(Value::Object(error)) => error.get("message").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| Value::Object(error.clone()).to_string()),
        error => body
            .get("error_description")
            .and_then(Value::as_str)
            .or_else(|| error.and_then(Value::as_str))
            .unwrap_or("unknown error")
            .to_owned(),
    }
}

// ---------------------------------------------------------------------------- stored session

fn store_path() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".planetarium-editor").join("openai.json")
}

fn load_store() -> Store {
    std::fs::read(store_path())
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn save_store(store: &Store) -> std::io::Result<()> {
    let path = store_path();
    if let Some(folder) = path.parent() {
        std::fs::create_dir_all(folder)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(store).unwrap_or_default())?;
    std::fs::rename(tmp, path)
}

fn forget_tokens(store: &mut Store) {
    for key in ["access_token", "refresh_token", "id_token", "expires_at"] {
        store.remove(key);
    }
}

fn keep_tokens(store: &mut Store, tokens: &Value) -> std::io::Result<()> {
    store.insert("access_token".into(), tokens["access_token"].clone());
    // Refresh tokens rotate: each use returns the next one, and the old one stops working.
    for key in ["refresh_token", "id_token"] {
        if tokens.get(key).and_then(Value::as_str).is_some_and(|value| !value.is_empty()) {
            store.insert(key.into(), tokens[key].clone());
        }
    }
    let lifetime = tokens.get("expires_in").and_then(Value::as_f64).filter(|seconds| *seconds > 0.0).unwrap_or(3600.0);
    store.insert("expires_at".into(), json!(now() + lifetime));
    save_store(store)
}

impl Shared {
    /// POSTs a form to OpenAI's token endpoint. Returns (status, parsed JSON body).
    async fn token_request(&self, fields: &[(&str, &str)]) -> Result<(u16, Value), reqwest::Error> {
        let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
        let response = self
            .http
            .post(TOKEN_URL)
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .header(header::ACCEPT, "application/json")
            .timeout(Duration::from_secs(30))
            .body(body)
            .send()
            .await?;
        let status = response.status().as_u16();
        let raw = response.bytes().await?;
        let parsed = serde_json::from_slice::<Value>(&raw).unwrap_or_else(|_| {
            let shown: String = String::from_utf8_lossy(&raw).chars().take(300).collect();
            json!({ "error": shown })
        });
        Ok((status, parsed))
    }

    /// A usable access token, refreshed if it is about to expire. None when not signed in.
    async fn access_token(&self, force_refresh: bool) -> Option<String> {
        let _guard = self.store.lock().await;
        let mut store = load_store();
        let current = text(&store, "access_token").to_owned();
        if current.is_empty() {
            return None;
        }
        let expires_at = store.get("expires_at").and_then(Value::as_f64).unwrap_or(0.0);
        if !force_refresh && expires_at - now() > 120.0 {
            return Some(current);
        }
        let refresh = text(&store, "refresh_token").to_owned();
        if refresh.is_empty() {
            return if force_refresh { None } else { Some(current) };
        }
        let client_id = text(&store, "client_id").to_owned();
        let result = self
            .token_request(&[("grant_type", "refresh_token"), ("client_id", &client_id), ("refresh_token", &refresh), ("resource", RESOURCE)])
            .await;
        match result {
            Ok((200, body)) if body.get("access_token").and_then(Value::as_str).is_some() => {
                let _ = keep_tokens(&mut store, &body);
                Some(text(&store, "access_token").to_owned())
            }
            Ok(_) => {
                // The sign-in has lapsed (refresh tokens last 30 days) or was revoked.
                forget_tokens(&mut store);
                let _ = save_store(&store);
                None
            }
            // OpenAI could not be reached: keep the sign-in, and let the request itself report it.
            Err(_) => if force_refresh { None } else { Some(current) },
        }
    }

    fn session_status(&self) -> Value {
        let store = load_store();
        let claims = claims_of(text(&store, "id_token"));
        let account = [text(&claims, "email"), text(&claims, "name")].into_iter().find(|value| !value.is_empty()).unwrap_or("");
        json!({
            "signedIn": !text(&store, "access_token").is_empty(),
            "account": account,
            "error": *self.last_error.lock().unwrap(),
        })
    }

    // ------------------------------------------------------------------------ sign-in

    async fn start_sign_in(&self) -> std::io::Result<String> {
        let _guard = self.store.lock().await;
        let mut store = load_store();
        // Identifies this installation to OpenAI: a UUID URN, chosen once and sent every time.
        if !text(&store, "host_id").starts_with("urn:uuid:") {
            store.insert("host_id".into(), json!(format!("urn:uuid:{}", uuid::Uuid::new_v4())));
            save_store(&store)?;
        }
        let verifier = random_token(48);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let stored_client = text(&store, "client_id");
        let client_id = if stored_client.is_empty() { FIRST_CLIENT_ID } else { stored_client }.to_owned();
        let attempt = Pending {
            state: random_token(24),
            nonce: random_token(24),
            verifier,
            // OpenAI accepts a loopback redirect on 127.0.0.1 (not "localhost"); only the port may vary.
            redirect_uri: format!("http://127.0.0.1:{}/auth/callback", self.port),
            client_id: client_id.clone(),
        };
        let mut params: Vec<(&str, &str)> = vec![
            ("response_type", "code"),
            ("client_id", &client_id),
            ("redirect_uri", &attempt.redirect_uri),
            ("scope", SCOPE),
            ("resource", RESOURCE),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &attempt.state),
            ("nonce", &attempt.nonce),
            ("ext_agent_host_id", text(&store, "host_id")),
        ];
        if client_id == FIRST_CLIENT_ID {
            params.push(("agent_name_hint", APP_NAME)); // shown to the person; only sent when registering
        } else if !text(&store, "id_token").is_empty() {
            // Signing in again: tells OpenAI which account this was, even if that token has expired.
            params.push(("id_token_hint", text(&store, "id_token")));
        }
        let query = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(&params).finish();
        *self.pending.lock().unwrap() = Some(attempt.clone());
        self.last_error.lock().unwrap().clear();
        Ok(format!("{AUTHORIZE_URL}?{query}"))
    }

    /// Handles OpenAI's redirect back. Returns an error message, or nothing on success.
    async fn finish_sign_in(&self, query: &HashMap<String, String>) -> Result<(), String> {
        let get = |key: &str| query.get(key).map(String::as_str).unwrap_or("");
        let attempt = {
            let mut pending = self.pending.lock().unwrap();
            // Only the redirect that carries this sign-in's state ends it; anything else that hits
            // this address leaves the sign-in in progress untouched.
            match pending.as_ref() {
                Some(attempt) if same(get("state"), &attempt.state) => pending.take().expect("checked above"),
                _ => return Err("This sign-in was not started from the editor, or it was started twice. Start again from the editor.".into()),
            }
        };
        if !get("error").is_empty() {
            return Err(if get("error_description").is_empty() { get("error") } else { get("error_description") }.into());
        }
        if get("code").is_empty() {
            return Err("OpenAI sent no authorization code.".into());
        }
        let client_id = if get("client_id").is_empty() { attempt.client_id.as_str() } else { get("client_id") }.to_owned();
        if client_id == FIRST_CLIENT_ID {
            return Err("OpenAI did not issue this app a client id; the registration is incomplete. Try again.".into());
        }
        if attempt.client_id != FIRST_CLIENT_ID && client_id != attempt.client_id {
            return Err("The sign-in came back for a different app than the one that asked.".into());
        }
        let (status, body) = self
            .token_request(&[
                ("grant_type", "authorization_code"),
                ("client_id", &client_id),
                ("code", get("code")),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", &attempt.redirect_uri),
                ("resource", RESOURCE),
            ])
            .await
            .map_err(|error| format!("Could not reach OpenAI: {error}"))?;
        if status != 200 || body.get("access_token").and_then(Value::as_str).is_none() {
            return Err(format!("OpenAI refused the sign-in: {}", describe(&body)));
        }

        // The ID token came straight from OpenAI over TLS, which stands in for checking its signature
        // (OpenID Connect Core 3.1.3.7); its claims still have to be the ones this sign-in asked for.
        let claims = claims_of(body.get("id_token").and_then(Value::as_str).unwrap_or(""));
        if !claims.is_empty() {
            let audience_matches = match claims.get("aud") {
                Some(Value::Array(list)) => list.iter().any(|item| item.as_str() == Some(client_id.as_str())),
                Some(Value::String(one)) => *one == client_id,
                _ => false,
            };
            if text(&claims, "iss").trim_end_matches('/') != format!("https://{AUTH_HOST}") {
                return Err("The sign-in came from an unexpected issuer.".into());
            }
            if !audience_matches {
                return Err("The sign-in was issued for a different app.".into());
            }
            if text(&claims, "nonce") != attempt.nonce {
                return Err("The sign-in does not match the request that started it.".into());
            }
        }
        let granted = body.get("scope").and_then(Value::as_str).filter(|scope| !scope.is_empty()).unwrap_or(SCOPE);
        if !granted.split_whitespace().any(|scope| scope == "chatgpt.tokens.use.direct") {
            return Err("This account did not grant use of its ChatGPT plan (it may not be eligible).".into());
        }

        let _guard = self.store.lock().await;
        let mut store = load_store();
        store.insert("client_id".into(), json!(client_id));
        keep_tokens(&mut store, &body).map_err(|error| format!("Could not save the sign-in: {error}"))
    }

    async fn sign_out(&self) {
        let _guard = self.store.lock().await;
        let mut store = load_store();
        forget_tokens(&mut store);
        let _ = save_store(&store);
    }

    // ------------------------------------------------------------------------ guards

    /// Whether the request is addressed to, and (if it says) comes from, this helper's page.
    fn own_origin(&self, headers: &HeaderMap) -> bool {
        let allowed = [format!("127.0.0.1:{}", self.port), format!("localhost:{}", self.port)];
        let Some(host) = header_text(headers, "host") else { return false };
        if !allowed.iter().any(|name| name == host) {
            return false; // a different name pointing at 127.0.0.1 (DNS rebinding)
        }
        match headers.get(header::ORIGIN) {
            None => true,
            Some(origin) => origin.to_str().is_ok_and(|origin| allowed.iter().any(|name| origin == format!("http://{name}"))),
        }
    }

    fn api_allowed(&self, headers: &HeaderMap) -> bool {
        // A header a plain cross-site form or link cannot set.
        self.own_origin(headers) && header_text(headers, "x-wall-editor") == Some("1")
    }

    // ------------------------------------------------------------------------ forwarding

    async fn forward(&self, method: &Method, path: &str, headers: &HeaderMap, body: Bytes) -> Response {
        if !FORWARDABLE.contains(&(method.as_str(), path)) {
            return send_json(StatusCode::NOT_FOUND, json!({ "error": "this endpoint is not forwarded" }));
        }
        let use_session = header_text(headers, "x-wall-auth") == Some("session");
        let mut force_refresh = false;
        loop {
            let authorization = if use_session {
                match self.access_token(force_refresh).await {
                    Some(token) => format!("Bearer {token}"),
                    None => {
                        return send_json(
                            StatusCode::UNAUTHORIZED,
                            json!({ "error": { "message": "Not signed in to ChatGPT. Sign in from the editor settings.", "code": "not_signed_in" } }),
                        )
                    }
                }
            } else {
                header_text(headers, "authorization").unwrap_or("").to_owned()
            };
            let mut request = self
                .http
                .request(method.clone(), format!("{API_ORIGIN}{path}"))
                .header(header::AUTHORIZATION, authorization)
                .header(header::ACCEPT, header_text(headers, "accept").unwrap_or("*/*"));
            if !body.is_empty() {
                request = request.header(header::CONTENT_TYPE, header_text(headers, "content-type").unwrap_or("application/json")).body(body.clone());
            }
            let upstream = match request.send().await {
                Ok(upstream) => upstream,
                Err(error) => return send_json(StatusCode::BAD_GATEWAY, json!({ "error": { "message": format!("Could not reach api.openai.com: {error}") } })),
            };
            if use_session && !force_refresh && upstream.status() == StatusCode::UNAUTHORIZED {
                // The token was rejected early: refresh it once and try again.
                force_refresh = true;
                continue;
            }
            let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            let content_type = upstream.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok()).unwrap_or("application/json").to_owned();
            // Passed on as it arrives, so a streamed reply reaches the page token by token.
            return respond(status, &content_type, "no-store", Body::from_stream(upstream.bytes_stream()));
        }
    }

    // ------------------------------------------------------------------------ saving files

    /// Asks where to save a file the page has made, and writes it there.
    async fn save_file(&self, headers: &HeaderMap, body: Bytes) -> Response {
        let requested = header_text(headers, "x-wall-filename").unwrap_or("");
        let decoded = percent_encoding::percent_decode_str(requested).decode_utf8_lossy().into_owned();
        // A file name only: whatever folder it goes to is the person's choice in the dialog.
        let name: String = decoded.chars().map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).collect();
        let name = if name.trim().is_empty() { "wallpaper".to_owned() } else { name };
        let extension = name.rsplit_once('.').map(|(_, ext)| ext.to_owned()).filter(|ext| !ext.is_empty() && ext.len() <= 8);

        let app = self.app.clone();
        let chosen = tauri::async_runtime::spawn_blocking(move || {
            let mut dialog = app.dialog().file().set_file_name(&name);
            if let Some(ext) = &extension {
                dialog = dialog.add_filter(ext.to_uppercase(), &[ext.as_str()]);
            }
            if let Some(window) = app.get_webview_window("main") {
                dialog = dialog.set_parent(&window);
            }
            dialog.blocking_save_file()
        })
        .await;
        let path = match chosen {
            Ok(Some(path)) => match path.into_path() {
                Ok(path) => path,
                Err(error) => return send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error.to_string() })),
            },
            Ok(None) => return send_json(StatusCode::OK, json!({ "saved": false })),
            Err(error) => return send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error.to_string() })),
        };
        match tokio::fs::write(&path, &body).await {
            Ok(()) => send_json(StatusCode::OK, json!({ "saved": true, "path": path.to_string_lossy() })),
            Err(error) => send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": format!("{}: {error}", path.display()) })),
        }
    }
}

// ---------------------------------------------------------------------------- the editor's files

fn serve_file(path: &str) -> Response {
    let decoded = percent_encoding::percent_decode_str(path).decode_utf8_lossy().into_owned();
    let relative = decoded.trim_start_matches('/');
    let relative = if relative.is_empty() { "index.html" } else { relative };
    // Hidden files and anything that climbs out of the folder are not served.
    if relative.contains('\\') || relative.split('/').any(|part| part.is_empty() || part.starts_with('.')) {
        return respond(StatusCode::NOT_FOUND, "text/plain", "no-store", "not found");
    }
    let Some(file) = WEB.get_file(relative) else {
        return respond(StatusCode::NOT_FOUND, "text/plain", "no-store", "not found");
    };
    let mime = mime_guess::from_path(relative).first_or_octet_stream();
    let content_type = if mime.type_() == "text" || mime.subtype() == "javascript" { format!("{mime}; charset=utf-8") } else { mime.to_string() };
    if relative == "index.html" {
        // Tells the page it runs in the desktop program: files are saved through a dialog and
        // sign-in pages open in the system browser.
        let html = String::from_utf8_lossy(file.contents()).replacen("</head>", "<script>window.WALL_DESKTOP = true;</script>\n</head>", 1);
        return respond(StatusCode::OK, &content_type, "no-cache", html);
    }
    respond(StatusCode::OK, &content_type, "no-cache", file.contents())
}

// ---------------------------------------------------------------------------- routes

async fn handle(State(shared): State<Arc<Shared>>, method: Method, uri: Uri, headers: HeaderMap, body: Bytes) -> Response {
    let path = uri.path();
    let refused = || send_json(StatusCode::FORBIDDEN, json!({ "error": "refused" }));
    let not_found = || send_json(StatusCode::NOT_FOUND, json!({ "error": "not found" }));

    if method == Method::GET && path == "/auth/callback" {
        if !shared.own_origin(&headers) {
            return send_page(StatusCode::FORBIDDEN, "Refused", "This request did not come from the editor.");
        }
        let query: HashMap<String, String> = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).fold(HashMap::new(), |mut map, (key, value)| {
            map.entry(key.into_owned()).or_insert_with(|| value.into_owned());
            map
        });
        let result = shared.finish_sign_in(&query).await;
        *shared.last_error.lock().unwrap() = result.clone().err().unwrap_or_default();
        return match result {
            Ok(()) => {
                // Back to the editor: the sign-in happened in the system browser.
                if let Some(window) = shared.app.get_webview_window("main") {
                    let _ = window.set_focus();
                }
                send_page(StatusCode::OK, "登入完成", "可以關閉這個分頁,回到編輯器。")
            }
            Err(error) => send_page(StatusCode::BAD_REQUEST, "登入失敗", &error),
        };
    }

    if path.starts_with("/api/") {
        if !shared.api_allowed(&headers) {
            return refused();
        }
        let openai = path.strip_prefix("/api/openai").filter(|rest| rest.starts_with("/v1/"));
        return match (method.as_str(), path) {
            ("GET", "/api/status") => send_json(StatusCode::OK, json!({ "helper": true, "desktop": true, "openai": shared.session_status() })),
            ("POST", "/api/openai/signin") => match shared.start_sign_in().await {
                Ok(url) => {
                    let opened = open::that_detached(&url).is_ok();
                    send_json(StatusCode::OK, json!({ "url": url, "opened": opened }))
                }
                Err(error) => send_json(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": format!("Could not prepare the sign-in: {error}") })),
            },
            ("POST", "/api/openai/signout") => {
                shared.sign_out().await;
                send_json(StatusCode::OK, json!({ "ok": true }))
            }
            ("POST", "/api/save") => shared.save_file(&headers, body).await,
            ("GET" | "POST", _) if openai.is_some() => shared.forward(&method, openai.expect("checked above"), &headers, body).await,
            _ => not_found(),
        };
    }

    if method == Method::GET || method == Method::HEAD {
        return serve_file(path);
    }
    refused()
}

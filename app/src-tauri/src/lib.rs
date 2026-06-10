// Native discovery for the "pull" connection model.
//
// The pi extension advertises each live session by writing
//   ~/.accordion/sessions/<id>.json
// and a one-shot focus request to
//   ~/.accordion/focus.json
// (see app/src/lib/live/registry.ts — these constants MUST stay in sync).
//
// A browser tab cannot read the filesystem, which is exactly why discovery lives
// here in native code. The webview calls these commands via `invoke`.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::Manager;

// Per-process cache for head-reads: path → (mtime_ms, title, cwd).
// Avoids re-reading unchanged files on every 3-second poll.
static HEAD_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<std::path::PathBuf, (u64, String, String)>>,
> = std::sync::OnceLock::new();

fn head_cache() -> std::sync::MutexGuard<
    'static,
    std::collections::HashMap<std::path::PathBuf, (u64, String, String)>,
> {
    HEAD_CACHE
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// `~/.accordion` — base of the registry. `ACCORDION_HOME` overrides the home dir
/// (kept in sync with the extension so both sides can be pointed at a temp dir).
fn registry_root() -> Option<PathBuf> {
    let home = std::env::var("ACCORDION_HOME")
        .ok()
        .map(PathBuf::from)
        .or_else(home_dir)?;
    Some(home.join(".accordion"))
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// Read every session descriptor. Returns raw JSON values; the app validates the
/// protocol/staleness (registry.ts `isLiveEntry`) so the rules live in one place.
#[tauri::command]
fn list_sessions() -> Vec<Value> {
    let mut out = Vec::new();
    let Some(root) = registry_root() else {
        return out;
    };
    let dir = root.join("sessions");
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        // Skip half-written temp files (extension writes <id>.json.<pid>.tmp).
        if let Ok(text) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&text) {
                out.push(value);
            }
        }
    }
    out
}

/// Delete a stale/dead session descriptor (the app reaps when a heartbeat lapses).
#[tauri::command]
fn reap_session(session_id: String) -> bool {
    // Guard against path traversal: only a bare file name, never a path.
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return false;
    }
    let Some(root) = registry_root() else {
        return false;
    };
    let path = root.join("sessions").join(format!("{session_id}.json"));
    fs::remove_file(path).is_ok()
}

/// Read-and-consume the `/accordion` focus request (delete so it fires once).
#[tauri::command]
fn take_focus_request() -> Option<Value> {
    let root = registry_root()?;
    let path = root.join("focus.json");
    let text = fs::read_to_string(&path).ok()?;
    match serde_json::from_str::<Value>(&text) {
        Ok(value) => {
            let _ = fs::remove_file(&path); // consume only a well-formed request
            Some(value)
        }
        // Leave a corrupt/partial file in place so a transient bad write is retried on the
        // next tick (or overwritten by the next /accordion) instead of silently lost.
        Err(_) => None,
    }
}

/// Discover recent Claude Code transcript files under `~/.claude/projects/`.
///
/// Each immediate child of `projects/` that is a directory (a project folder) is
/// scanned for top-level `*.jsonl` files; nested dirs (e.g. `subagents/`) are skipped.
/// Results are sorted newest-first by mtime; only the 50 most-recent are returned.
/// A head-read (up to 96 KB) extracts a title and cwd from each file's JSONL lines.
#[tauri::command]
fn list_claude_sessions() -> Vec<Value> {
    // 1. Resolve the projects root.
    let Some(home) = home_dir() else {
        return Vec::new();
    };
    let projects_root = home.join(".claude").join("projects");
    let Ok(project_dirs) = fs::read_dir(&projects_root) else {
        return Vec::new();
    };

    // 2. Collect (path, mtime_ms, size) for every top-level *.jsonl in each project dir.
    struct FileInfo {
        path: PathBuf,
        folder_name: String,
        mtime_ms: u64,
        size: u64,
    }

    let mut files: Vec<FileInfo> = Vec::new();

    for proj_entry in project_dirs.flatten() {
        let proj_path = proj_entry.path();
        // Only directories are project folders.
        let Ok(proj_meta) = fs::metadata(&proj_path) else {
            continue;
        };
        if !proj_meta.is_dir() {
            continue;
        }
        let folder_name = proj_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let Ok(entries) = fs::read_dir(&proj_path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Skip subdirectories (e.g. subagents/).
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if meta.is_dir() {
                continue;
            }
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            // Extract mtime as milliseconds since UNIX_EPOCH.
            let mtime_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let size = meta.len();
            files.push(FileInfo {
                path,
                folder_name: folder_name.clone(),
                mtime_ms,
                size,
            });
        }
    }

    // 3. Sort descending by mtime, keep newest 50.
    files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    files.truncate(50);

    // 4. Head-read each of the 50 to extract title and cwd.
    let mut out: Vec<Value> = Vec::new();

    for fi in &files {
        let session_id = fi
            .path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let file_path_str = fi.path.to_string_lossy().to_string();

        // Check the per-process head-read cache before touching disk.
        // Key: (path, mtime_ms) — a changed mtime means the file content may differ.
        let cached = {
            let cache = head_cache();
            cache
                .get(&fi.path)
                .filter(|(cached_mtime, _, _)| *cached_mtime == fi.mtime_ms)
                .map(|(_, t, c)| (t.clone(), c.clone()))
        };

        let (resolved_title, cwd) = if let Some((title, cwd)) = cached {
            (title, cwd)
        } else {
            // Read up to 96 KB (ai-title observed at ≤33 KB; 96 KB gives safe headroom).
            const HEAD_BYTES: u64 = 96 * 1024;
            let raw_bytes: Vec<u8> = if fi.size <= HEAD_BYTES {
                match fs::read(&fi.path) {
                    Ok(b) => b,
                    Err(_) => continue,
                }
            } else {
                use std::io::Read;
                let Ok(mut f) = fs::File::open(&fi.path) else {
                    continue;
                };
                let mut buf = vec![0u8; HEAD_BYTES as usize];
                // File is guaranteed >= HEAD_BYTES, so read_exact fills the buffer.
                // On an unexpected I/O error keep whatever partial bytes were written
                // rather than panicking; the lossy decode below handles null padding.
                let _ = f.read_exact(&mut buf);
                buf
            };

            // Lossily convert so a truncated multibyte sequence at the boundary doesn't panic.
            let text = String::from_utf8_lossy(&raw_bytes);
            let lines: Vec<&str> = text.lines().collect();

            let mut title: Option<String> = None;
            let mut cwd = String::new();
            let mut first_user_text: Option<String> = None;

            for line in &lines {
                let Ok(obj) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let obj_type = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");

                // Extract cwd from any object that carries it (Claude Code user messages do).
                if cwd.is_empty() {
                    if let Some(c) = obj.get("cwd").and_then(|v| v.as_str()) {
                        if !c.is_empty() {
                            cwd = c.to_string();
                        }
                    }
                }

                // Title priority: (1) ai-title, (2) summary, (3) first user message.
                if title.is_none() {
                    if obj_type == "ai-title" {
                        if let Some(s) = obj.get("aiTitle").and_then(|v| v.as_str()) {
                            if !s.is_empty() {
                                title = Some(s.chars().take(80).collect());
                            }
                        }
                    } else if obj_type == "summary" {
                        if let Some(s) = obj.get("summary").and_then(|v| v.as_str()) {
                            if !s.is_empty() {
                                title = Some(s.chars().take(80).collect());
                            }
                        }
                    }
                }

                if title.is_none() && first_user_text.is_none() && obj_type == "user" {
                    if let Some(msg) = obj.get("message") {
                        let text_from_content = if let Some(s) =
                            msg.get("content").and_then(|v| v.as_str())
                        {
                            // Plain string content.
                            Some(s.to_string())
                        } else if let Some(arr) = msg.get("content").and_then(|v| v.as_array()) {
                            // Array of content blocks — use first text block.
                            arr.iter()
                                .find(|block| {
                                    block.get("type").and_then(|t| t.as_str()) == Some("text")
                                })
                                .and_then(|block| block.get("text").and_then(|t| t.as_str()))
                                .map(|s| s.to_string())
                        } else {
                            None
                        };
                        if let Some(t) = text_from_content {
                            if !t.trim().is_empty() {
                                first_user_text = Some(t.chars().take(80).collect());
                            }
                        }
                    }
                }

                // Stop scanning once we have a title (or fallback) and cwd.
                if (title.is_some() || first_user_text.is_some()) && !cwd.is_empty() {
                    break;
                }
            }

            let resolved_title = title
                .or(first_user_text)
                .unwrap_or_else(|| "(untitled)".to_string());

            // Update the cache; Mutex is locked only for this insert, not across the read.
            {
                let mut cache = head_cache();
                cache.insert(
                    fi.path.clone(),
                    (fi.mtime_ms, resolved_title.clone(), cwd.clone()),
                );
            }

            (resolved_title, cwd)
        };

        // project: basename of cwd (split on / and \), or fallback to folder name.
        let project = if !cwd.is_empty() {
            cwd.split(['/', '\\'])
                .filter(|s| !s.is_empty())
                .last()
                .unwrap_or(&fi.folder_name)
                .to_string()
        } else {
            fi.folder_name.clone()
        };

        out.push(serde_json::json!({
            "sessionId": session_id,
            "filePath": file_path_str,
            "title": resolved_title,
            "cwd": cwd,
            "project": project,
            "mtime": fi.mtime_ms,
            "size": fi.size
        }));
    }

    // Prune the cache to only the paths seen in this scan, bounding growth over time.
    {
        let seen: std::collections::HashSet<&std::path::PathBuf> =
            files.iter().map(|fi| &fi.path).collect();
        let mut cache = head_cache();
        cache.retain(|path, _| seen.contains(path));
    }

    out
}

/// Read a Claude Code transcript's full text. Rust owns `~/.claude` access (the JS fs
/// plugin's scope does not cover programmatic reads of `~/.claude/projects/**`, only
/// dialog-picked files), so the file load + tail goes through here. The path is
/// confined to the projects root — a crafted `invoke` cannot read arbitrary disk.
#[tauri::command]
fn read_claude_session(path: String) -> Result<String, String> {
    let home = home_dir().ok_or_else(|| "no home directory".to_string())?;
    let projects_root = home.join(".claude").join("projects");
    // Canonicalize both sides so symlinks / `..` / mixed separators can't escape the
    // root (canonicalize requires the file to exist, which is what we want anyway).
    let root =
        fs::canonicalize(&projects_root).map_err(|e| format!("projects root unavailable: {e}"))?;
    let target = fs::canonicalize(&path).map_err(|e| format!("cannot resolve path: {e}"))?;
    if !target.starts_with(&root) {
        return Err(format!("forbidden path (outside projects root): {path}"));
    }
    if target.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(format!("not a .jsonl transcript: {path}"));
    }
    fs::read_to_string(&target).map_err(|e| format!("read failed: {e}"))
}

// ── Accordion home I/O ────────────────────────────────────────────────────────

/// Windows reserved device basenames that must never be used as file names
/// (case-insensitive; with or without extension).
const WIN_RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_reserved_device_name(name: &str) -> bool {
    // Strip extension for the comparison (e.g. "NUL.txt" → "NUL").
    let stem = name.split('.').next().unwrap_or(name);
    let upper = stem.to_ascii_uppercase();
    WIN_RESERVED.contains(&upper.as_str())
}

/// Validate a relative path component: no absolute paths, no drive letters,
/// no `..` segments, no backslashes (we normalize separators to `/`). Returns
/// a `PathBuf` rooted in `~/.accordion` on success, canonicalized so symlinks
/// and mixed separators cannot escape the root.
fn accordion_path(rel_path: &str) -> Result<PathBuf, String> {
    // Normalize: convert backslashes to forward slashes.
    let normalized = rel_path.replace('\\', "/");

    // Reject absolute paths or drive letters (e.g. C:/).
    if normalized.starts_with('/') || normalized.contains(':') {
        return Err(format!("forbidden path (absolute or drive letter): {rel_path}"));
    }
    // Validate each path segment.
    for segment in normalized.split('/') {
        if segment == ".." {
            return Err(format!("forbidden path (contains ..): {rel_path}"));
        }
        if is_reserved_device_name(segment) {
            return Err(format!("forbidden path (Windows reserved device name '{segment}'): {rel_path}"));
        }
    }

    let root = registry_root().ok_or_else(|| "no accordion home".to_string())?;
    // Ensure the base directory exists so canonicalize succeeds.
    fs::create_dir_all(&root).map_err(|e| format!("create accordion home failed: {e}"))?;
    let canon_root = fs::canonicalize(&root)
        .map_err(|e| format!("canonicalize accordion home failed: {e}"))?;

    let joined = canon_root.join(&normalized);
    // For confinement: canonicalize the parent (which must exist after create_dir_all)
    // so we can verify the final path stays under root. We canonicalize the parent
    // because the target file itself may not exist yet (writes/appends).
    let parent = joined.parent().unwrap_or(&joined);
    fs::create_dir_all(parent).map_err(|e| format!("create parent dirs failed: {e}"))?;
    let canon_parent = fs::canonicalize(parent)
        .map_err(|e| format!("canonicalize parent failed: {e}"))?;
    if !canon_parent.starts_with(&canon_root) {
        return Err(format!("forbidden path (escapes accordion home): {rel_path}"));
    }
    // Re-assemble the final path using the canonicalized parent.
    let file_name = joined
        .file_name()
        .ok_or_else(|| format!("path has no file name component: {rel_path}"))?;
    Ok(canon_parent.join(file_name))
}

/// Read a file at `rel_path` under `~/.accordion`. Returns `""` if the file
/// does not exist. Capped at 8 MB to prevent runaway reads.
#[tauri::command]
fn accordion_read_text(rel_path: String) -> Result<String, String> {
    let path = accordion_path(&rel_path)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let meta = fs::metadata(&path).map_err(|e| format!("stat failed: {e}"))?;
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    if meta.len() > MAX_BYTES {
        return Err(format!("file too large ({} bytes > 8 MB limit)", meta.len()));
    }
    fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))
}

/// Append `line + "\n"` to `rel_path` under `~/.accordion`. Creates parent
/// directories as needed. Rejects lines containing a newline character.
#[tauri::command]
fn accordion_append_line(rel_path: String, line: String) -> Result<(), String> {
    if line.contains('\n') || line.contains('\r') {
        return Err("line must not contain newline or carriage-return characters".to_string());
    }
    let path = accordion_path(&rel_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create_dir_all failed: {e}"))?;
    }
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open failed: {e}"))?;
    writeln!(file, "{line}").map_err(|e| format!("write failed: {e}"))
}

// ── LLM generation ────────────────────────────────────────────────────────────

/// Serde types that mirror LlmRequest / LlmResponse in types.ts.
/// camelCase matches the TypeScript invoke convention.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmGenRequest {
    pub role: String,
    pub system: Option<String>,
    pub user: String,
    pub json_schema: Option<Value>,
    pub max_output_tokens: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmGenResponse {
    pub text: String,
    pub in_tokens: u64,
    pub out_tokens: u64,
    pub model: String,
    pub provider: String,
}

// Per-process Vertex token cache. Protected by a std Mutex (not async) because
// the token is a small string and the lock is held only for read/write of the
// cache struct, not during the network call.
static VERTEX_TOKEN_CACHE: std::sync::OnceLock<
    std::sync::Mutex<Option<(String, Instant)>>,
> = std::sync::OnceLock::new();

const VERTEX_TOKEN_TTL: Duration = Duration::from_secs(45 * 60);
/// Safety margin subtracted from TTL so we never hand out a token that expires
/// during the in-flight request (mirrors the 60 s margin in llm-node.mjs).
const VERTEX_TOKEN_MARGIN: Duration = Duration::from_secs(60);
const VERTEX_PROJECT: &str  = "runner-frontier-74255";
const VERTEX_LOCATION: &str = "us-central1";

fn vertex_token_cache() -> std::sync::MutexGuard<'static, Option<(String, Instant)>> {
    VERTEX_TOKEN_CACHE
        .get_or_init(|| std::sync::Mutex::new(None))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Mint or return a cached Vertex OAuth token.
fn get_vertex_token(force_refresh: bool) -> Result<String, String> {
    {
        let cache = vertex_token_cache();
        if !force_refresh {
            if let Some((ref tok, ref minted_at)) = *cache {
                if minted_at.elapsed() + VERTEX_TOKEN_MARGIN < VERTEX_TOKEN_TTL {
                    return Ok(tok.clone());
                }
            }
        }
    } // drop lock before spawning

    // gcloud.cmd on Windows — use cmd /C to invoke it.
    let output = std::process::Command::new("cmd")
        .args(["/C", "gcloud", "auth", "print-access-token"])
        .output()
        .map_err(|e| format!("failed to spawn gcloud: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("gcloud auth failed: {stderr}"));
    }

    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() {
        return Err("gcloud returned an empty token".to_string());
    }

    // Store in cache.
    *vertex_token_cache() = Some((token.clone(), Instant::now()));
    Ok(token)
}

/// Read GEMINI_API_KEY: env first, then Windows registry HKCU\Environment.
fn resolve_gemini_key() -> Option<String> {
    if let Ok(key) = std::env::var("GEMINI_API_KEY") {
        if !key.is_empty() {
            return Some(key);
        }
    }
    // Windows registry fallback.
    let output = std::process::Command::new("reg")
        .args(["query", "HKCU\\Environment", "/v", "GEMINI_API_KEY"])
        .output()
        .ok()?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Line format: "    GEMINI_API_KEY    REG_SZ    <value>"
        for line in stdout.lines() {
            if line.trim_start().starts_with("GEMINI_API_KEY") {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    return Some(parts[parts.len() - 1].to_string());
                }
            }
        }
    }
    None
}

/// Build a Gemini-compatible JSON request body.
fn build_gemini_body(req: &LlmGenRequest) -> Value {
    let mut body = serde_json::json!({
        "contents": [{"role": "user", "parts": [{"text": req.user}]}]
    });
    if let Some(sys) = &req.system {
        body["systemInstruction"] = serde_json::json!({"parts": [{"text": sys}]});
    }
    let mut gen_config = serde_json::Map::new();
    if let Some(max_tok) = req.max_output_tokens {
        gen_config.insert("maxOutputTokens".to_string(), max_tok.into());
    }
    if let Some(schema) = &req.json_schema {
        gen_config.insert("responseMimeType".to_string(), "application/json".into());
        gen_config.insert("responseSchema".to_string(), schema.clone());
    }
    if !gen_config.is_empty() {
        body["generationConfig"] = Value::Object(gen_config);
    }
    body
}

/// Safely take up to `n` Unicode scalar values from `s` as a new `String`.
/// Never panics on a char boundary, unlike `&s[..n]`.
fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Parse the Gemini response envelope into our response type.
fn parse_gemini_response(raw: &Value, model: &str, provider: &str) -> Result<LlmGenResponse, String> {
    let text = raw
        .pointer("/candidates/0/content/parts/0/text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("unexpected response shape: {}", truncate_chars(&raw.to_string(), 200)))?
        .to_string();

    let in_tokens  = raw.pointer("/usageMetadata/promptTokenCount")    .and_then(|v| v.as_u64()).unwrap_or(0);
    let out_tokens = raw.pointer("/usageMetadata/candidatesTokenCount") .and_then(|v| v.as_u64()).unwrap_or(0);

    Ok(LlmGenResponse {
        text,
        in_tokens,
        out_tokens,
        model: model.to_string(),
        provider: provider.to_string(),
    })
}

/// Returns true only when a 429 is caused by depleted prepay/billing credits
/// (not a plain rate-limit). Case-insensitive check for "prepay", "prepayment",
/// "billing", or "credits" in the body. A plain RESOURCE_EXHAUSTED without those
/// keywords is a transient rate-limit, not a permanent provider kill signal.
fn is_prepay_error(status: u16, body: &str) -> bool {
    if status != 429 {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("prepay") || lower.contains("billing") || lower.contains("credits")
}

/// Main LLM generation command. Tries AI Studio first; falls back to Vertex on
/// prepay/quota exhaustion.
#[tauri::command]
async fn llm_generate(req: LlmGenRequest) -> Result<LlmGenResponse, String> {
    let model_for_role = |provider: &str| -> &'static str {
        match (provider, req.role.as_str()) {
            ("aistudio", "tick")    => "gemini-flash-latest",
            ("aistudio", _)        => "gemini-flash-lite-latest",
            ("vertex",   _)        => "gemini-2.5-flash-lite",
            _                     => "gemini-2.5-flash-lite",
        }
    };

    let body = build_gemini_body(&req);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("reqwest build failed: {e}"))?;

    // ── Try AI Studio ──────────────────────────────────────────────────────────
    let gemini_key = resolve_gemini_key();
    if let Some(key) = &gemini_key {
        let model = model_for_role("aistudio");
        // Send the key as a request header, NOT in the URL query string.
        // (URL query params appear in reqwest error Display which is returned to the webview.)
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        );
        let resp = client.post(&url)
            .header("x-goog-api-key", key.as_str())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("AI Studio request failed: {}", e.without_url()))?;
        let status = resp.status().as_u16();
        let raw_body = resp.text().await.map_err(|e| format!("read body failed: {}", e.without_url()))?;

        if status == 200 {
            let parsed: Value = serde_json::from_str(&raw_body)
                .map_err(|e| format!("parse AI Studio response: {e}"))?;
            return parse_gemini_response(&parsed, model, "aistudio");
        }

        if is_prepay_error(status, &raw_body) {
            // Prepay credits depleted — fall through to Vertex.
        } else {
            // Surface other AI Studio errors directly.
            let kind = if status == 429 { "quota" } else { "http" };
            return Err(format!("{kind}: AI Studio HTTP {status}: {}", truncate_chars(&raw_body, 300)));
        }
    }

    // ── Try Vertex AI ──────────────────────────────────────────────────────────
    let vertex_model = model_for_role("vertex");
    let vertex_url = format!(
        "https://{VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/{VERTEX_PROJECT}\
         /locations/{VERTEX_LOCATION}/publishers/google/models/{vertex_model}:generateContent"
    );

    // Neither provider is usable: no key and gcloud is absent/fails.
    let vertex_token_result = get_vertex_token(false);
    let token = match vertex_token_result {
        Ok(t) => t,
        Err(e) if gemini_key.is_none() => {
            return Err(format!("unavailable: no usable LLM provider (no GEMINI_API_KEY and Vertex unavailable: {e})"));
        }
        Err(e) => return Err(e),
    };

    let resp = client.post(&vertex_url)
        .bearer_auth(&token)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Vertex request failed: {}", e.without_url()))?;
    let status = resp.status().as_u16();
    let raw_body = resp.text().await.map_err(|e| format!("read Vertex body: {}", e.without_url()))?;

    // On 401, refresh token once and retry.
    if status == 401 {
        let fresh_token = get_vertex_token(true)?;
        let resp2 = client.post(&vertex_url)
            .bearer_auth(&fresh_token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Vertex retry failed: {}", e.without_url()))?;
        let status2 = resp2.status().as_u16();
        let raw_body2 = resp2.text().await.map_err(|e| format!("read Vertex retry body: {}", e.without_url()))?;

        if status2 != 200 {
            let kind = if status2 == 429 { "quota" } else { "http" };
            return Err(format!("{kind}: Vertex HTTP {status2}: {}", truncate_chars(&raw_body2, 300)));
        }
        let parsed: Value = serde_json::from_str(&raw_body2)
            .map_err(|e| format!("parse Vertex response: {e}"))?;
        return parse_gemini_response(&parsed, vertex_model, "vertex");
    }

    if status != 200 {
        let kind = if status == 429 { "quota" } else { "http" };
        return Err(format!("{kind}: Vertex HTTP {status}: {}", truncate_chars(&raw_body, 300)));
    }

    let parsed: Value = serde_json::from_str(&raw_body)
        .map_err(|e| format!("parse Vertex response: {e}"))?;
    parse_gemini_response(&parsed, vertex_model, "vertex")
}

// ── Window management ─────────────────────────────────────────────────────────

fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Bring the main window to the foreground (used when a focus request fires).
#[tauri::command]
fn focus_window(app: tauri::AppHandle) {
    focus_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            reap_session,
            take_focus_request,
            focus_window,
            list_claude_sessions,
            read_claude_session,
            accordion_read_text,
            accordion_append_line,
            llm_generate
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

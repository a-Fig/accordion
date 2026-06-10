use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

fn live_path() -> PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".pi/agent/accordion-live-session.jsonl")
}

struct TailResult {
    size: usize,
    chunk: String,
    reset: bool,
}

fn read_tail(path: &PathBuf, cursor: usize) -> TailResult {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return TailResult { size: 0, chunk: String::new(), reset: false },
    };
    let size = meta.len() as usize;
    if size < cursor {
        let full = fs::read_to_string(path).unwrap_or_default();
        return TailResult {
            size: full.as_bytes().len(),
            chunk: full,
            reset: true,
        };
    }
    if size == cursor {
        return TailResult {
            size,
            chunk: String::new(),
            reset: false,
        };
    }
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return TailResult { size: cursor, chunk: String::new(), reset: false },
    };
    if file.seek(SeekFrom::Start(cursor as u64)).is_err() {
        return TailResult {
            size: cursor,
            chunk: String::new(),
            reset: false,
        };
    }
    let mut chunk = String::new();
    if file.read_to_string(&mut chunk).is_err() {
        return TailResult {
            size: cursor,
            chunk: String::new(),
            reset: false,
        };
    }
    TailResult { size, chunk, reset: false }
}

struct WatchState {
    cursor: usize,
    watcher: RecommendedWatcher,
}

static WATCH: Mutex<Option<WatchState>> = Mutex::new(None);

#[tauri::command]
fn start_live_watch(app: AppHandle) -> Result<(), String> {
    stop_live_watch()?;
    let path = live_path();
    let initial = fs::read_to_string(&path).unwrap_or_default();
    let cursor = initial.as_bytes().len();
    app.emit("live-session-snapshot", initial)
        .map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let watch_path = path.clone();
    let cursor_state = Mutex::new(cursor);

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if res.is_err() {
                return;
            }
            let mut cur = *cursor_state.lock().unwrap();
            let tail = read_tail(&watch_path, cur);
            if tail.reset {
                cur = tail.size;
                *cursor_state.lock().unwrap() = cur;
                let _ = app_handle.emit("live-session-snapshot", tail.chunk);
            } else if !tail.chunk.is_empty() {
                cur = tail.size;
                *cursor_state.lock().unwrap() = cur;
                let _ = app_handle.emit("live-session-append", tail.chunk);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    if path.exists() {
        watcher
            .watch(&path, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    } else if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }

    *WATCH.lock().unwrap() = Some(WatchState { cursor, watcher });
    Ok(())
}

#[tauri::command]
fn stop_live_watch() -> Result<(), String> {
    WATCH.lock().unwrap().take();
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet, start_live_watch, stop_live_watch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

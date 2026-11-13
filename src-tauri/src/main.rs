//! The desktop program for the spatial wallpaper editor.
//!
//! It is the editor's page in its own window, plus the local helper that `serve.py` provides
//! when the editor runs in a browser: the page is served from a loopback address by the program
//! itself, so "Sign in with ChatGPT", the OpenAI forwarding and the autosave all work the same
//! way in both. The page gets no access to the program beyond that local server.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::net::TcpListener;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// The program's own port, so the page keeps one origin (and with it the autosave and settings)
/// from run to run. `serve.py` uses 8765; the two can run side by side.
const PORT: u16 = 8766;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Started a second time: show the window that is already open.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Loopback only. If the usual port is taken, any free one will do (the page then
            // starts with empty settings, as a different origin).
            let listener = TcpListener::bind(("127.0.0.1", PORT)).or_else(|_| TcpListener::bind(("127.0.0.1", 0)))?;
            listener.set_nonblocking(true)?;
            let port = listener.local_addr()?.port();
            server::start(app.handle().clone(), listener, port);

            let url = format!("http://127.0.0.1:{port}/").parse().expect("a valid local address");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Planetarium 空間桌布編輯器")
                .inner_size(1440.0, 900.0)
                .min_inner_size(1000.0, 640.0)
                // Leave dropped files to the page, which accepts pictures, projects and packs.
                .disable_drag_drop_handler()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the editor could not start");
}

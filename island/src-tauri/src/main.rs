#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(debug_assertions, windows_subsystem = "windows")]

use tauri::Manager;
use tauri::webview::Color;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize, Deserialize, Default)]
struct WindowPos {
    x: f64,
    y: f64,
}

/// Single CLI tool registered for launching from the island.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct Tool {
    id: String,
    name: String,
    /// Executable name or absolute path. Looked up via PATH if not absolute.
    command: String,
    /// Optional argv after `command` (e.g. ["run", "dev"] for "bun run dev").
    #[serde(default)]
    args: Vec<String>,
    /// Optional working directory (set via wt.exe --startingDirectory or cd).
    #[serde(default)]
    cwd: Option<String>,
    /// CSS color string for the round indicator in the island UI (#hex / rgb).
    #[serde(default = "default_color")]
    color: String,
}

fn default_color() -> String {
    "#888".to_string()
}

#[derive(Serialize, Deserialize, Default)]
struct ToolsConfig {
    tools: Vec<Tool>,
}

fn config_dir() -> PathBuf {
    let mut p = dirs_next::config_dir().unwrap_or_else(|| PathBuf::from("."));
    p.push("haking-island");
    fs::create_dir_all(&p).ok();
    p
}

fn pos_file() -> PathBuf {
    let mut p = config_dir();
    p.push("position.json");
    p
}

fn tools_file() -> PathBuf {
    let mut p = config_dir();
    p.push("tools.json");
    p
}

fn load_pos() -> WindowPos {
    fs::read_to_string(pos_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(WindowPos { x: 100.0, y: 50.0 })
}

fn save_pos(pos: &WindowPos) {
    if let Ok(json) = serde_json::to_string(pos) {
        fs::write(pos_file(), json).ok();
    }
}

fn default_tools_config() -> ToolsConfig {
    ToolsConfig {
        tools: vec![
            Tool {
                id: "haking".into(),
                name: "Haking Code".into(),
                command: "bun".into(),
                args: vec!["run".into(), "dev".into()],
                cwd: Some("D:\\miserad".into()),
                color: "#00fff7".into(),
            },
            Tool {
                id: "opencode".into(),
                name: "OpenCode".into(),
                command: "opencode".into(),
                args: vec![],
                cwd: None,
                color: "#ff6b35".into(),
            },
            Tool {
                id: "codex".into(),
                name: "Codex".into(),
                command: "codex".into(),
                args: vec![],
                cwd: None,
                color: "#00ff88".into(),
            },
            Tool {
                id: "claude".into(),
                name: "Claude Code".into(),
                command: "claude".into(),
                args: vec![],
                cwd: None,
                color: "#d77757".into(),
            },
            Tool {
                id: "aider".into(),
                name: "Aider".into(),
                command: "aider".into(),
                args: vec![],
                cwd: None,
                color: "#ff2d95".into(),
            },
            Tool {
                id: "gemini".into(),
                name: "Gemini CLI".into(),
                command: "gemini".into(),
                args: vec![],
                cwd: None,
                color: "#5769f7".into(),
            },
        ],
    }
}

fn load_tools_config() -> ToolsConfig {
    let path = tools_file();
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(cfg) = serde_json::from_str::<ToolsConfig>(&text) {
            return cfg;
        }
    }
    // First run (or corrupt file) — write defaults so the user has something
    // to edit if they want to customize later.
    let cfg = default_tools_config();
    if let Ok(json) = serde_json::to_string_pretty(&cfg) {
        fs::write(&path, json).ok();
    }
    cfg
}

#[tauri::command]
fn save_window_position(x: f64, y: f64) {
    save_pos(&WindowPos { x, y });
}

#[tauri::command]
fn focus_terminal_window(session_id: String) {
    #[cfg(target_os = "windows")]
    {
        let script = format!(
            r#"$w = Get-Process | Where-Object {{$_.MainWindowTitle -match '{}'}} | Select-Object -First 1; if($w) {{ [void][System.Reflection.Assembly]::LoadWithPartialName('Microsoft.VisualBasic'); [Microsoft.VisualBasic.Interaction]::AppActivate($w.Id) }}"#,
            session_id
        );
        Command::new("powershell")
            .args(["-Command", &script])
            .spawn()
            .ok();
    }
}

#[tauri::command]
fn list_tools() -> Vec<Tool> {
    load_tools_config().tools
}

/// Detect Windows Terminal once. wt.exe is installed by default on Win11
/// and most updated Win10 boxes; older systems fall back to spawning each
/// tool in its own cmd window.
#[cfg(target_os = "windows")]
fn has_wt() -> bool {
    Command::new("where")
        .arg("wt.exe")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(not(target_os = "windows"))]
fn has_wt() -> bool {
    false
}

/// Build the `wt.exe` argv for ONE tool — used both for single launch and
/// as a building block for split-pane chains.
///
/// Layout: [--title T --startingDirectory CWD -- COMMAND ARGS...]
fn wt_args_for(tool: &Tool) -> Vec<String> {
    let mut args: Vec<String> = vec!["--title".into(), tool.name.clone()];
    if let Some(cwd) = tool.cwd.as_deref() {
        if !cwd.is_empty() {
            args.push("--startingDirectory".into());
            args.push(cwd.into());
        }
    }
    // `--` ensures wt stops parsing its own flags and treats the rest as the
    // child commandline.
    args.push("--".into());
    args.push(tool.command.clone());
    for a in &tool.args {
        args.push(a.clone());
    }
    args
}

#[tauri::command]
fn launch_tool(id: String) -> Result<(), String> {
    let cfg = load_tools_config();
    let tool = cfg
        .tools
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("tool '{id}' not found in tools.json"))?;

    if has_wt() {
        let mut args: Vec<String> = vec!["new-tab".into()];
        args.extend(wt_args_for(&tool));
        Command::new("wt.exe")
            .args(&args)
            .spawn()
            .map_err(|e| format!("wt.exe failed: {e}"))?;
        return Ok(());
    }

    // Fallback for systems without wt.exe: spawn an independent cmd window
    // running the tool. Less polished but works on every Windows install.
    #[cfg(target_os = "windows")]
    {
        let mut full = format!("start \"{}\" cmd /K \"{}\"", tool.name, tool.command);
        for a in &tool.args {
            full.push(' ');
            full.push_str(a);
        }
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", &full]);
        if let Some(cwd) = tool.cwd.as_deref() {
            cmd.current_dir(cwd);
        }
        cmd.spawn().map_err(|e| format!("cmd fallback failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("only Windows is currently supported".to_string())
    }
}

/// Launch multiple tools split-pane'd into ONE Windows Terminal window.
///
/// `layout` accepts:
///   "vertical"   → all tools split vertically (left | mid | right)
///   "horizontal" → all tools split horizontally (top / mid / bottom)
///   "grid"       → 4-tool quadrant (defaults to vertical for !=4)
///   "tabs"       → each tool in its own wt tab (no split)
///
/// Without wt.exe we fall back to launching each tool in its own cmd window.
#[tauri::command]
fn launch_split(ids: Vec<String>, layout: String) -> Result<(), String> {
    if ids.is_empty() {
        return Err("no tools selected".into());
    }
    let cfg = load_tools_config();
    let tools: Vec<Tool> = ids
        .iter()
        .filter_map(|id| cfg.tools.iter().find(|t| &t.id == id).cloned())
        .collect();
    if tools.is_empty() {
        return Err("no matching tools found".into());
    }

    if !has_wt() {
        // No Windows Terminal — degrade to one window per tool.
        for t in &tools {
            launch_tool(t.id.clone())?;
        }
        return Ok(());
    }

    // Build wt argv: new-tab tool0 ; split-pane -V tool1 ; split-pane -V tool2 ...
    let mut args: Vec<String> = vec!["new-tab".into()];
    args.extend(wt_args_for(&tools[0]));

    for (idx, tool) in tools.iter().enumerate().skip(1) {
        args.push(";".into());

        match layout.as_str() {
            "tabs" => {
                args.push("new-tab".into());
                args.extend(wt_args_for(tool));
            }
            "horizontal" => {
                args.push("split-pane".into());
                args.push("-H".into());
                args.extend(wt_args_for(tool));
            }
            "grid" => {
                // 4-quadrant: pane0 left-top, pane1 right-top (vertical
                // split), pane2 right-bottom (horizontal split focused on
                // pane1), pane3 left-bottom (move-focus left, then split).
                match idx {
                    1 => {
                        args.push("split-pane".into());
                        args.push("-V".into());
                        args.extend(wt_args_for(tool));
                    }
                    2 => {
                        args.push("split-pane".into());
                        args.push("-H".into());
                        args.extend(wt_args_for(tool));
                    }
                    3 => {
                        args.push("move-focus".into());
                        args.push("left".into());
                        args.push(";".into());
                        args.push("split-pane".into());
                        args.push("-H".into());
                        args.extend(wt_args_for(tool));
                    }
                    _ => {
                        args.push("split-pane".into());
                        args.push("-V".into());
                        args.extend(wt_args_for(tool));
                    }
                }
            }
            // "vertical" or anything else — default to vertical split chain.
            _ => {
                args.push("split-pane".into());
                args.push("-V".into());
                args.extend(wt_args_for(tool));
            }
        }
    }

    Command::new("wt.exe")
        .args(&args)
        .spawn()
        .map_err(|e| format!("wt.exe split-pane failed: {e}"))?;
    Ok(())
}

fn main() {
    let pos = load_pos();
    // Touch tools.json on startup so first-run users see a populated file
    // they can edit immediately, even if they never click the Tools section.
    let _ = load_tools_config();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            save_window_position,
            focus_terminal_window,
            list_tools,
            launch_tool,
            launch_split,
        ])
        .setup(move |app| {
            let window = app.get_webview_window("main").unwrap();
            window.set_background_color(Some(Color(0, 0, 0, 0))).ok();
            window
                .set_position(tauri::PhysicalPosition::new(pos.x as i32, pos.y as i32))
                .ok();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error running haking island");
}

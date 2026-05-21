fn main() {
    // Skip Windows resource compilation if rc.exe is not available
    std::env::set_var("TAURI_SKIP_WINRES", "1");
    tauri_build::build()
}

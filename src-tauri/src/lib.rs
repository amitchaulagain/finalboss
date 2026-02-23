use serde::{Deserialize, Serialize};
use tauri::Emitter;
use base64::Engine;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const APP_NAME: &str = "FinalBoss";
const MANAGED_FILES_INDEX_VERSION: u32 = 1;
const MAX_MANAGED_FILES_PER_USER: usize = 10_000;
const MAX_MANAGED_FILE_CONTENT_BYTES: usize = 10 * 1024 * 1024;
const MAX_MANAGED_FILES_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024; // 2GB

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileEntry {
    id: String,
    user_id: String,
    feature: String,
    job_id: Option<String>,
    filename: String,
    stored_name: String,
    relative_path: String,
    source_route: Option<String>,
    mime_type: Option<String>,
    size: u64,
    created_at: String,
    updated_at: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileIndex {
    version: u32,
    entries: Vec<ManagedFileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFilesQuotaInfo {
    used_file_count: usize,
    max_file_count: usize,
    used_bytes: u64,
    max_bytes: u64,
    file_count_usage_percent: f64,
    bytes_usage_percent: f64,
    warning_level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFilesRebuildResult {
    reindexed_count: usize,
    skipped_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterManagedFileInput {
    user_id: String,
    feature: String,
    filename: String,
    content: String,
    job_id: Option<String>,
    source_route: Option<String>,
    mime_type: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterManagedFileBase64Input {
    user_id: String,
    feature: String,
    filename: String,
    content_base64: String,
    job_id: Option<String>,
    source_route: Option<String>,
    mime_type: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileListQuery {
    user_id: String,
    feature: Option<String>,
    search: Option<String>,
    job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFilePreviewQuery {
    user_id: String,
    file_id: String,
    max_chars: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileBulkDeleteInput {
    user_id: String,
    file_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileBulkMoveInput {
    user_id: String,
    file_ids: Vec<String>,
    target_feature: String,
    target_job_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFileOpenInput {
    user_id: String,
    file_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFilesBackupInput {
    user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedFilesImportInput {
    user_id: String,
    backup_path: String,
}

fn epoch_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_iso_like() -> String {
    epoch_seconds().to_string()
}

fn sanitize_segment(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn get_app_data_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").ok();
    if cfg!(target_os = "windows") {
        let base = std::env::var("APPDATA")
            .or_else(|_| std::env::var("LOCALAPPDATA"))
            .map(PathBuf::from)
            .or_else(|_| {
                home.clone()
                    .map(|h| PathBuf::from(h).join("AppData").join("Roaming"))
                    .ok_or_else(|| "Cannot resolve APPDATA path".to_string())
            })?;
        return Ok(base.join(APP_NAME));
    }
    if cfg!(target_os = "macos") {
        let home_dir = home.ok_or_else(|| "Cannot resolve HOME path".to_string())?;
        return Ok(PathBuf::from(home_dir).join("Library").join("Application Support").join(APP_NAME));
    }
    let base = std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|_| {
            home.clone()
                .map(|h| PathBuf::from(h).join(".local").join("share"))
                .ok_or_else(|| "Cannot resolve XDG data directory".to_string())
        })?;
    Ok(base.join(APP_NAME.to_lowercase()))
}

fn get_user_root(user_id: &str) -> Result<PathBuf, String> {
    let root = get_app_data_root()?;
    Ok(root.join("users").join(sanitize_segment(user_id)))
}

fn get_index_path(user_id: &str) -> Result<PathBuf, String> {
    Ok(get_user_root(user_id)?.join("index").join("files-index.json"))
}

fn load_index(user_id: &str) -> Result<ManagedFileIndex, String> {
    let index_path = get_index_path(user_id)?;
    if !index_path.exists() {
        return Ok(ManagedFileIndex {
            version: MANAGED_FILES_INDEX_VERSION,
            entries: vec![],
        });
    }
    let content = std::fs::read_to_string(&index_path)
        .map_err(|e| format!("Failed reading index file {}: {}", index_path.display(), e))?;
    match serde_json::from_str::<ManagedFileIndex>(&content) {
        Ok(parsed) => Ok(parsed),
        Err(parse_error) => {
            // Self-heal malformed index: preserve corrupt payload and continue with empty index.
            let corrupted = index_path.with_extension(format!("corrupt-{}.json", epoch_seconds()));
            let _ = std::fs::rename(&index_path, &corrupted);
            eprintln!(
                "Managed files index recovery: moved malformed index to {} ({})",
                corrupted.display(),
                parse_error
            );
            Ok(ManagedFileIndex {
                version: MANAGED_FILES_INDEX_VERSION,
                entries: vec![],
            })
        }
    }
}

fn lock_path_for_user(user_id: &str) -> Result<PathBuf, String> {
    Ok(get_user_root(user_id)?.join("index").join("files-index.lock"))
}

struct IndexLock {
    lock_path: PathBuf,
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.lock_path);
    }
}

fn acquire_index_lock(user_id: &str) -> Result<IndexLock, String> {
    let lock_path = lock_path_for_user(user_id)?;
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating lock directory {}: {}", parent.display(), e))?;
    }

    for _ in 0..120 {
        let lock_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&lock_path);
        if let Ok(mut file) = lock_file {
            let _ = writeln!(file, "pid={} ts={}", std::process::id(), epoch_seconds());
            return Ok(IndexLock { lock_path });
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err("Managed files index is currently busy. Please retry.".to_string())
}

fn save_index(user_id: &str, index: &ManagedFileIndex) -> Result<(), String> {
    let index_path = get_index_path(user_id)?;
    if let Some(parent) = index_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed creating index directory {}: {}", parent.display(), e))?;
    }
    let content = serde_json::to_string_pretty(index)
        .map_err(|e| format!("Failed serializing index: {}", e))?;
    let temp_path = index_path.with_extension(format!("tmp-{}.json", epoch_seconds()));
    std::fs::write(&temp_path, content)
        .map_err(|e| format!("Failed writing temp index {}: {}", temp_path.display(), e))?;
    std::fs::rename(&temp_path, &index_path)
        .map_err(|e| format!("Failed replacing index {}: {}", index_path.display(), e))?;
    Ok(())
}

fn update_index<F, T>(user_id: &str, updater: F) -> Result<T, String>
where
    F: FnOnce(&mut ManagedFileIndex) -> Result<T, String>,
{
    let _guard = acquire_index_lock(user_id)?;
    let mut index = load_index(user_id)?;
    let result = updater(&mut index)?;
    save_index(user_id, &index)?;
    Ok(result)
}

fn build_storage_rel_path(feature: &str, job_id: Option<&str>, stored_name: &str) -> String {
    let mut parts = vec!["storage".to_string(), sanitize_segment(feature)];
    if let Some(job) = job_id {
        let safe_job = sanitize_segment(job);
        if !safe_job.is_empty() {
            parts.push(safe_job);
        }
    }
    parts.push(stored_name.to_string());
    parts.join("/")
}

fn open_path_in_os(path: &Path) -> Result<(), String> {
    let status = if cfg!(target_os = "macos") {
        std::process::Command::new("open").arg(path).status()
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer").arg(path).status()
    } else {
        std::process::Command::new("xdg-open").arg(path).status()
    }
    .map_err(|e| format!("Failed to launch OS opener: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("OS opener failed with status: {:?}", status.code()))
    }
}

fn resolve_entry_path(user_id: &str, entry: &ManagedFileEntry) -> Result<PathBuf, String> {
    let root = get_user_root(user_id)?;
    let rel = PathBuf::from(entry.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if rel.is_absolute() {
        return Err("Managed file path must be relative".to_string());
    }

    // Check for path traversal attacks
    for component in rel.components() {
        match component {
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err("Invalid managed file path component".to_string());
            }
            _ => {}
        }
    }

    // First, try the clean format: resumes/filename.pdf (now contains correct binary files)
    let clean_path = root.join("resumes").join(&entry.filename);
    if clean_path.exists() {
        return Ok(clean_path);
    }

    // Fall back to the old format stored in relative_path
    let full = root.join(rel);
    if !full.starts_with(&root) {
        return Err("Managed file path escaped user root".to_string());
    }
    if full.exists() {
        return Ok(full);
    }

    Ok(full)
}

fn build_quota_info(index: &ManagedFileIndex) -> ManagedFilesQuotaInfo {
    let used_file_count = index.entries.len();
    let used_bytes: u64 = index.entries.iter().map(|e| e.size).sum();
    let file_count_usage_percent = if MAX_MANAGED_FILES_PER_USER == 0 {
        0.0
    } else {
        (used_file_count as f64 / MAX_MANAGED_FILES_PER_USER as f64) * 100.0
    };
    let bytes_usage_percent = if MAX_MANAGED_FILES_TOTAL_BYTES == 0 {
        0.0
    } else {
        (used_bytes as f64 / MAX_MANAGED_FILES_TOTAL_BYTES as f64) * 100.0
    };
    let worst = file_count_usage_percent.max(bytes_usage_percent);
    let warning_level = if worst >= 100.0 {
        "critical"
    } else if worst >= 85.0 {
        "warning"
    } else {
        "ok"
    }
    .to_string();

    ManagedFilesQuotaInfo {
        used_file_count,
        max_file_count: MAX_MANAGED_FILES_PER_USER,
        used_bytes,
        max_bytes: MAX_MANAGED_FILES_TOTAL_BYTES,
        file_count_usage_percent,
        bytes_usage_percent,
        warning_level,
    }
}

fn collect_storage_files(user_root: &Path) -> Result<Vec<(PathBuf, String)>, String> {
    let storage_root = user_root.join("storage");
    if !storage_root.exists() {
        return Ok(vec![]);
    }

    let mut stack = vec![storage_root];
    let mut out: Vec<(PathBuf, String)> = vec![];

    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)
            .map_err(|e| format!("Failed reading directory {}: {}", dir.display(), e))?
        {
            let entry = entry.map_err(|e| format!("Failed reading directory entry: {}", e))?;
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if !path.is_file() {
                continue;
            }
            let rel = path
                .strip_prefix(user_root)
                .map_err(|e| format!("Failed creating relative path for {}: {}", path.display(), e))?;
            let rel_norm = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            if !rel_norm.starts_with("storage/") {
                continue;
            }
            out.push((path, rel_norm));
        }
    }

    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

fn parse_relative_path_parts(relative_path: &str) -> (String, Option<String>, String) {
    let parts = relative_path.split('/').collect::<Vec<_>>();
    let feature = parts.get(1).copied().unwrap_or("other").to_string();
    let job_id = if parts.len() >= 4 {
        Some(parts[2].to_string())
    } else {
        None
    };
    let stored_name = parts.last().copied().unwrap_or("unknown").to_string();
    (feature, job_id, stored_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_segment_replaces_unsafe_chars() {
        let got = sanitize_segment("john/doe@email.com");
        assert_eq!(got, "john_doe_email.com");
    }

    #[test]
    fn storage_rel_path_is_stable() {
        let rel = build_storage_rel_path("cover-letter", Some("job/123"), "abc.txt");
        assert_eq!(rel, "storage/cover-letter/job_123/abc.txt");
    }

    #[test]
    fn resolve_entry_path_rejects_parent_traversal() {
        let entry = ManagedFileEntry {
            id: "x".to_string(),
            user_id: "u@example.com".to_string(),
            feature: "resume".to_string(),
            job_id: None,
            filename: "a.pdf".to_string(),
            stored_name: "s".to_string(),
            relative_path: "../escape/a.pdf".to_string(),
            source_route: None,
            mime_type: None,
            size: 1,
            created_at: "0".to_string(),
            updated_at: "0".to_string(),
            tags: vec![],
        };
        assert!(resolve_entry_path("u@example.com", &entry).is_err());
    }
}

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

#[tauri::command]
async fn get_app_config_path() -> Result<String, String> {
    let root = get_app_data_root()?;
    Ok(root.join("user-config.json").to_string_lossy().to_string())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command(async)]
fn list_files(path: &str) -> Result<Vec<String>, String> {
    use std::env;

    // Resolve path from project root (same logic as read_file_async)
    let full_path = if path.starts_with("/") || (cfg!(windows) && path.len() > 1 && path.chars().nth(1) == Some(':')) {
        std::path::PathBuf::from(path)
    } else {
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop();
        }
        project_root.join(path)
    };

    let entries = full_path.read_dir()
        .map_err(|e| format!("Failed to read directory {}: {}", full_path.display(), e))?
        .filter_map(|entry| {
            entry.ok().and_then(|e| {
                e.file_name().to_str().map(|s| s.to_owned())
            })
        })
        .collect::<Vec<String>>();

    Ok(entries)
}

#[tauri::command]
async fn write_file_async(filename: &str, content: &str) -> Result<String, String> {
    use tokio::fs;
    use std::env;
    
    // Get the current working directory and resolve relative paths
    let path = if filename.starts_with("/") || (cfg!(windows) && filename.len() > 1 && filename.chars().nth(1) == Some(':')) {
        // Absolute path
        std::path::PathBuf::from(filename)
    } else {
        // Relative path - resolve from project root
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop(); // Go up one level if we're in src-tauri
        }
        project_root.join(filename)
    };
    
    // Create parent directories if they don't exist
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    
    match fs::write(&path, content).await {
        Ok(_) => Ok(format!("Successfully wrote to {}", path.display())),
        Err(e) => Err(format!("Failed to write file: {}", e))
    }
}

#[tauri::command]
async fn read_file_async(filename: &str) -> Result<String, String> {
    use tokio::fs;
    use std::env;
    
    // Get the current working directory and resolve relative paths
    let path = if filename.starts_with("/") || (cfg!(windows) && filename.len() > 1 && filename.chars().nth(1) == Some(':')) {
        // Absolute path
        std::path::PathBuf::from(filename)
    } else {
        // Relative path - resolve from project root
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop(); // Go up one level if we're in src-tauri
        }
        project_root.join(filename)
    };
    
    match fs::read_to_string(&path).await {
        Ok(content) => Ok(content),
        Err(e) => Err(format!("Failed to read file {}: {}", path.display(), e))
    }
}

#[tauri::command]
async fn read_file_base64(filename: &str) -> Result<String, String> {
    use tokio::fs;
    use std::env;

    let path = if filename.starts_with('/') || (cfg!(windows) && filename.len() > 1 && filename.chars().nth(1) == Some(':')) {
        std::path::PathBuf::from(filename)
    } else {
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop();
        }
        project_root.join(filename)
    };

    let bytes = fs::read(&path).await.map_err(|e| format!("Failed to read file {}: {}", path.display(), e))?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
async fn copy_file_async(source: &str, destination: &str) -> Result<String, String> {
    use tokio::fs;
    
    match fs::copy(source, destination).await {
        Ok(bytes_copied) => Ok(format!("Successfully copied {} bytes from {} to {}", bytes_copied, source, destination)),
        Err(e) => Err(format!("Failed to copy file: {}", e))
    }
}

#[tauri::command]
async fn rename_file_async(old_name: &str, new_name: &str) -> Result<String, String> {
    use tokio::fs;
    
    match fs::rename(old_name, new_name).await {
        Ok(_) => Ok(format!("Successfully renamed {} to {}", old_name, new_name)),
        Err(e) => Err(format!("Failed to rename file: {}", e))
    }
}

#[tauri::command]
async fn delete_file_async(filename: &str) -> Result<String, String> {
    use tokio::fs;
    
    match fs::remove_file(filename).await {
        Ok(_) => Ok(format!("Successfully deleted {}", filename)),
        Err(e) => Err(format!("Failed to delete file: {}", e))
    }
}

#[tauri::command]
async fn create_directory_async(dirname: &str) -> Result<String, String> {
    use tokio::fs;
    use std::env;
    
    // Get the current working directory and resolve relative paths
    let path = if dirname.starts_with("/") || (cfg!(windows) && dirname.len() > 1 && dirname.chars().nth(1) == Some(':')) {
        // Absolute path
        std::path::PathBuf::from(dirname)
    } else {
        // Relative path - resolve from project root
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop(); // Go up one level if we're in src-tauri
        }
        project_root.join(dirname)
    };
    
    match fs::create_dir_all(&path).await {
        Ok(_) => Ok(format!("Successfully created directory {}", path.display())),
        Err(e) => Err(format!("Failed to create directory: {}", e))
    }
}

#[tauri::command]
async fn remove_directory_async(dirname: &str) -> Result<String, String> {
    use tokio::fs;
    
    match fs::remove_dir_all(dirname).await {
        Ok(_) => Ok(format!("Successfully removed directory {}", dirname)),
        Err(e) => Err(format!("Failed to remove directory: {}", e))
    }
}

#[tauri::command]
async fn file_exists_async(filename: &str) -> Result<bool, String> {
    use tokio::fs;
    
    match fs::try_exists(filename).await {
        Ok(exists) => Ok(exists),
        Err(e) => Err(format!("Failed to check file existence: {}", e))
    }
}

#[tauri::command]
async fn get_file_metadata_async(filename: &str) -> Result<String, String> {
    use tokio::fs;
    
    match fs::metadata(filename).await {
        Ok(metadata) => {
            let info = format!(
                "File: {}\nSize: {} bytes\nIs file: {}\nIs directory: {}\nReadonly: {}\nModified: {:?}",
                filename,
                metadata.len(),
                metadata.is_file(),
                metadata.is_dir(),
                metadata.permissions().readonly(),
                metadata.modified()
            );
            Ok(info)
        },
        Err(e) => Err(format!("Failed to get metadata: {}", e))
    }
}

#[tauri::command]
async fn run_python_script(script_path: &str) -> Result<String, String> {
    use tokio::process::Command;
    use std::env;
    
    // Get the current working directory and resolve relative paths
    let path = if script_path.starts_with("/") || (cfg!(windows) && script_path.len() > 1 && script_path.chars().nth(1) == Some(':')) {
        // Absolute path
        std::path::PathBuf::from(script_path)
    } else {
        // Relative path - resolve from project root
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop(); // Go up one level if we're in src-tauri
        }
        project_root.join(script_path)
    };
    
    // Check if the script exists
    if !path.exists() {
        return Err(format!("Python script not found: {}", path.display()));
    }
    
    // Run the Python script
    let output = Command::new("python3")
        .arg(path.to_str().unwrap())
        .current_dir({
            let mut dir = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
            if dir.ends_with("src-tauri") {
                dir.pop(); // Go up one level if we're in src-tauri
            }
            dir
        })
        .output()
        .await
        .map_err(|e| format!("Failed to execute python script: {}", e))?;
    
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(format!("Script executed successfully!\nOutput: {}\nErrors: {}", stdout, stderr))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed with exit code: {}\nError: {}", output.status.code().unwrap_or(-1), stderr))
    }
}

#[tauri::command]
async fn run_javascript_script(script_path: &str, args: Option<Vec<String>>) -> Result<String, String> {
    use tokio::process::Command;
    use std::env;

    // Get the current working directory and resolve relative paths
    let path = if script_path.starts_with("/") || (cfg!(windows) && script_path.len() > 1 && script_path.chars().nth(1) == Some(':')) {
        // Absolute path
        std::path::PathBuf::from(script_path)
    } else {
        // Relative path - resolve from project root
        let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
        if project_root.ends_with("src-tauri") {
            project_root.pop(); // Go up one level if we're in src-tauri
        }
        project_root.join(script_path)
    };

    // Check if the script exists
    if !path.exists() {
        return Err(format!("JavaScript script not found: {}", path.display()));
    }

    // Build command with arguments
    let mut cmd = Command::new("bun");
    cmd.arg(path.to_str().unwrap());

    // Add arguments if provided
    if let Some(args) = args {
        for arg in args {
            cmd.arg(&arg);
        }
    }

    let output = cmd
        .current_dir({
            let mut dir = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
            if dir.ends_with("src-tauri") {
                dir.pop(); // Go up one level if we're in src-tauri
            }
            dir
        })
        .output()
        .await
        .map_err(|e| format!("Failed to execute javascript script with bun: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        Ok(format!("Script executed successfully!\nOutput: {}\nErrors: {}", stdout, stderr))
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Script execution failed with exit code: {}\nError: {}", output.status.code().unwrap_or(-1), stderr))
    }
}

#[tauri::command]
async fn run_bot_streaming(
    app: tauri::AppHandle,
    bot_name: String
) -> Result<String, String> {
    use tokio::process::Command;
    use tokio::io::{BufReader, AsyncBufReadExt};
    use std::process::Stdio;
    use std::env;

    // Resolve project root
    let mut project_root = env::current_dir().map_err(|e| format!("Failed to get current directory: {}", e))?;
    if project_root.ends_with("src-tauri") {
        project_root.pop();
    }

    let script_path = project_root.join("src/bots/bot_starter.ts");

    if !script_path.exists() {
        return Err(format!("Bot starter script not found: {}", script_path.display()));
    }

    // Spawn bot process with piped stdout
    let mut child = Command::new("bun")
        .arg(script_path.to_str().unwrap())
        .arg(&bot_name)
        .current_dir(&project_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit()) // Debug logs show in terminal
        .spawn()
        .map_err(|e| format!("Failed to spawn bot process: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let reader = BufReader::new(stdout);
    let mut lines = reader.lines();

    // Clone app handle for use in async task (AppHandle is Clone)
    let app_clone = app.clone();

    // Spawn task to stream stdout lines as Tauri events
    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            // Filter for structured events with [BOT_EVENT] prefix
            if line.starts_with("[BOT_EVENT]") {
                let json_str = &line[11..]; // Remove prefix
                if let Ok(event) = serde_json::from_str::<serde_json::Value>(json_str) {
                    // Emit to UI (using cloned app handle)
                    let _ = app_clone.emit("bot-progress", event);
                }
            }
            // All other lines are debug logs - ignored by UI
        }
    });

    // Wait for bot process to complete
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    Ok(format!("Bot '{}' started successfully", bot_name))
}

#[tauri::command]
async fn register_managed_file(input: RegisterManagedFileInput) -> Result<ManagedFileEntry, String> {
    let user_root = get_user_root(&input.user_id)?;
    let stored_name = input.filename.clone();
    let full_path = user_root.join("resumes").join(&stored_name);

    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed creating managed-file directory: {}", e))?;
    }

    if input.content.as_bytes().len() > MAX_MANAGED_FILE_CONTENT_BYTES {
        return Err(format!(
            "Managed file exceeds max size ({} bytes)",
            MAX_MANAGED_FILE_CONTENT_BYTES
        ));
    }

    tokio::fs::write(&full_path, input.content.as_bytes())
        .await
        .map_err(|e| format!("Failed writing managed file: {}", e))?;

    let metadata = tokio::fs::metadata(&full_path)
        .await
        .map_err(|e| format!("Failed reading managed file metadata: {}", e))?;

    let now = now_iso_like();
    let id = format!("mf_{}_{}", epoch_seconds(), sanitize_segment(&input.filename));
    let entry = ManagedFileEntry {
        id,
        user_id: input.user_id.clone(),
        feature: input.feature.clone(),
        job_id: input.job_id.clone(),
        filename: input.filename,
        stored_name: stored_name.clone(),
        relative_path: format!("resumes/{}", stored_name),
        source_route: input.source_route,
        mime_type: input.mime_type,
        size: metadata.len(),
        created_at: now.clone(),
        updated_at: now,
        tags: input.tags.unwrap_or_default(),
    };

    update_index(&input.user_id, |index| {
        if index.entries.len() >= MAX_MANAGED_FILES_PER_USER {
            return Err(format!(
                "Managed files limit reached (max {})",
                MAX_MANAGED_FILES_PER_USER
            ));
        }
        let used_bytes: u64 = index.entries.iter().map(|e| e.size).sum();
        if used_bytes.saturating_add(metadata.len()) > MAX_MANAGED_FILES_TOTAL_BYTES {
            return Err(format!(
                "Managed files storage limit reached (max {} bytes)",
                MAX_MANAGED_FILES_TOTAL_BYTES
            ));
        }
        index.entries.push(entry.clone());
        Ok(())
    })?;

    Ok(entry)
}

#[tauri::command]
async fn register_managed_file_base64(input: RegisterManagedFileBase64Input) -> Result<ManagedFileEntry, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(input.content_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 payload: {}", e))?;

    if bytes.len() > MAX_MANAGED_FILE_CONTENT_BYTES {
        return Err(format!(
            "Managed file exceeds max size ({} bytes)",
            MAX_MANAGED_FILE_CONTENT_BYTES
        ));
    }

    let user_root = get_user_root(&input.user_id)?;
    let stored_name = input.filename.clone();
    let full_path = user_root.join("resumes").join(&stored_name);

    if let Some(parent) = full_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed creating managed-file directory: {}", e))?;
    }

    tokio::fs::write(&full_path, &bytes)
        .await
        .map_err(|e| format!("Failed writing managed file: {}", e))?;

    let metadata = tokio::fs::metadata(&full_path)
        .await
        .map_err(|e| format!("Failed reading managed file metadata: {}", e))?;

    let now = now_iso_like();
    let id = format!("mf_{}_{}", epoch_seconds(), sanitize_segment(&input.filename));
    let entry = ManagedFileEntry {
        id,
        user_id: input.user_id.clone(),
        feature: input.feature.clone(),
        job_id: input.job_id.clone(),
        filename: input.filename,
        stored_name: stored_name.clone(),
        relative_path: format!("resumes/{}", stored_name),
        source_route: input.source_route,
        mime_type: input.mime_type,
        size: metadata.len(),
        created_at: now.clone(),
        updated_at: now,
        tags: input.tags.unwrap_or_default(),
    };

    update_index(&input.user_id, |index| {
        if index.entries.len() >= MAX_MANAGED_FILES_PER_USER {
            return Err(format!(
                "Managed files limit reached (max {})",
                MAX_MANAGED_FILES_PER_USER
            ));
        }
        let used_bytes: u64 = index.entries.iter().map(|e| e.size).sum();
        if used_bytes.saturating_add(metadata.len()) > MAX_MANAGED_FILES_TOTAL_BYTES {
            return Err(format!(
                "Managed files storage limit reached (max {} bytes)",
                MAX_MANAGED_FILES_TOTAL_BYTES
            ));
        }
        index.entries.push(entry.clone());
        Ok(())
    })?;

    Ok(entry)
}

#[tauri::command]
async fn get_managed_files_quota(user_id: String) -> Result<ManagedFilesQuotaInfo, String> {
    let index = load_index(&user_id)?;
    Ok(build_quota_info(&index))
}

#[tauri::command]
async fn rebuild_managed_files_index(user_id: String) -> Result<ManagedFilesRebuildResult, String> {
    let user_root = get_user_root(&user_id)?;
    std::fs::create_dir_all(user_root.join("storage"))
        .map_err(|e| format!("Failed ensuring storage root exists: {}", e))?;

    let discovered = collect_storage_files(&user_root)?;
    let now = now_iso_like();

    update_index(&user_id, |index| {
        let mut by_relative: HashMap<String, ManagedFileEntry> = index
            .entries
            .iter()
            .cloned()
            .map(|entry| (entry.relative_path.clone(), entry))
            .collect();

        let mut rebuilt_entries: Vec<ManagedFileEntry> = vec![];
        let mut skipped_count = 0usize;
        let mut used_bytes = 0u64;

        for (full_path, relative_path) in discovered.iter() {
            let metadata = std::fs::metadata(full_path).map_err(|e| {
                format!("Failed reading metadata for {}: {}", full_path.display(), e)
            })?;
            let size = metadata.len();

            if rebuilt_entries.len() >= MAX_MANAGED_FILES_PER_USER
                || used_bytes.saturating_add(size) > MAX_MANAGED_FILES_TOTAL_BYTES
            {
                skipped_count += 1;
                continue;
            }

            if let Some(mut existing) = by_relative.remove(relative_path) {
                existing.size = size;
                existing.updated_at = now.clone();
                rebuilt_entries.push(existing);
                used_bytes = used_bytes.saturating_add(size);
                continue;
            }

            let (feature, job_id, stored_name) = parse_relative_path_parts(relative_path);
            let fallback_filename = Path::new(relative_path)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_else(|| "managed-file".to_string());

            rebuilt_entries.push(ManagedFileEntry {
                id: format!("mf_rebuild_{}_{}", epoch_seconds(), sanitize_segment(&stored_name)),
                user_id: user_id.clone(),
                feature: sanitize_segment(&feature),
                job_id,
                filename: fallback_filename,
                stored_name,
                relative_path: relative_path.clone(),
                source_route: None,
                mime_type: None,
                size,
                created_at: now.clone(),
                updated_at: now.clone(),
                tags: vec!["reindexed".to_string()],
            });
            used_bytes = used_bytes.saturating_add(size);
        }

        index.entries = rebuilt_entries;
        Ok(ManagedFilesRebuildResult {
            reindexed_count: index.entries.len(),
            skipped_count,
        })
    })
}

#[tauri::command]
async fn get_managed_files(query: ManagedFileListQuery) -> Result<Vec<ManagedFileEntry>, String> {
    let index = load_index(&query.user_id)?;
    let search = query.search.unwrap_or_default().to_lowercase();
    let filtered = index
        .entries
        .into_iter()
        .filter(|entry| {
            let feature_ok = query
                .feature
                .as_ref()
                .map(|f| entry.feature == sanitize_segment(f))
                .unwrap_or(true);
            let job_ok = query
                .job_id
                .as_ref()
                .map(|j| entry.job_id.as_deref() == Some(j.as_str()))
                .unwrap_or(true);
            let search_ok = if search.is_empty() {
                true
            } else {
                entry.filename.to_lowercase().contains(&search)
                    || entry
                        .job_id
                        .as_ref()
                        .map(|v| v.to_lowercase().contains(&search))
                        .unwrap_or(false)
                    || entry
                        .source_route
                        .as_ref()
                        .map(|v| v.to_lowercase().contains(&search))
                        .unwrap_or(false)
            };
            feature_ok && job_ok && search_ok
        })
        .collect::<Vec<_>>();
    Ok(filtered)
}

#[tauri::command]
async fn preview_managed_file(query: ManagedFilePreviewQuery) -> Result<String, String> {
    let index = load_index(&query.user_id)?;
    let entry = index
        .entries
        .iter()
        .find(|f| f.id == query.file_id)
        .ok_or_else(|| "Managed file not found".to_string())?;
    let full_path = resolve_entry_path(&query.user_id, entry)?;
    // Check if this is a binary file that shouldn't be previewed as text
    let file_name = full_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_lowercase();

    if file_name.ends_with(".pdf") || file_name.ends_with(".doc") || file_name.ends_with(".docx") {
        return Ok(format!("[Binary file: {}. Use file opening to view content.]",
                         full_path.file_name().unwrap_or_default().to_string_lossy()));
    }

    let content = tokio::fs::read_to_string(&full_path)
        .await
        .or_else(|_| std::fs::read(&full_path).map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
        .map_err(|e| format!("Failed reading file preview {}: {}", full_path.display(), e))?;

    let limit = query.max_chars.unwrap_or(8000);
    if content.len() > limit {
        // Use char_indices to find safe UTF-8 boundary
        let truncated = content.char_indices()
            .nth(limit)
            .map(|(i, _)| &content[..i])
            .unwrap_or(&content);
        Ok(format!("{}...", truncated))
    } else {
        Ok(content)
    }
}

#[tauri::command]
async fn delete_managed_files(input: ManagedFileBulkDeleteInput) -> Result<usize, String> {
    update_index(&input.user_id, |index| {
        let before = index.entries.len();
        index.entries.retain(|entry| {
            if input.file_ids.iter().any(|id| id == &entry.id) {
                if let Ok(full_path) = resolve_entry_path(&input.user_id, entry) {
                    let _ = std::fs::remove_file(full_path);
                }
                false
            } else {
                true
            }
        });
        Ok(before.saturating_sub(index.entries.len()))
    })
}

#[tauri::command]
async fn move_managed_files(input: ManagedFileBulkMoveInput) -> Result<usize, String> {
    update_index(&input.user_id, |index| {
        let mut moved = 0usize;
        let user_root = get_user_root(&input.user_id)?;
        let target_feature = sanitize_segment(&input.target_feature);
        let target_job = input.target_job_id.as_ref().map(|j| sanitize_segment(j));

        for entry in index.entries.iter_mut() {
            if !input.file_ids.iter().any(|id| id == &entry.id) {
                continue;
            }
            let old_path = resolve_entry_path(&input.user_id, entry)?;
            let rel_path = build_storage_rel_path(&target_feature, target_job.as_deref(), &entry.stored_name);
            let new_path = user_root.join(rel_path.replace('/', std::path::MAIN_SEPARATOR_STR));
            if !new_path.starts_with(&user_root) {
                return Err("Resolved target path escaped user root".to_string());
            }

            if let Some(parent) = new_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed creating target directory {}: {}", parent.display(), e))?;
            }
            std::fs::rename(&old_path, &new_path)
                .map_err(|e| format!("Failed moving {} to {}: {}", old_path.display(), new_path.display(), e))?;

            entry.feature = target_feature.clone();
            entry.job_id = input.target_job_id.clone();
            entry.relative_path = rel_path;
            entry.updated_at = now_iso_like();
            moved += 1;
        }
        Ok(moved)
    })
}

#[tauri::command]
async fn open_managed_file(input: ManagedFileOpenInput) -> Result<String, String> {
    let index = load_index(&input.user_id)?;
    let entry = index
        .entries
        .iter()
        .find(|f| f.id == input.file_id)
        .ok_or_else(|| "Managed file not found".to_string())?;
    let full_path = resolve_entry_path(&input.user_id, entry)?;
    open_path_in_os(&full_path)?;
    Ok(format!("Opened {}", full_path.display()))
}

#[tauri::command]
async fn get_managed_file_path(input: ManagedFileOpenInput) -> Result<String, String> {
    let index = load_index(&input.user_id)?;
    let entry = index
        .entries
        .iter()
        .find(|f| f.id == input.file_id)
        .ok_or_else(|| "Managed file not found".to_string())?;
    let full_path = resolve_entry_path(&input.user_id, entry)?;
    Ok(full_path.display().to_string())
}

#[tauri::command]
async fn save_managed_file_to_downloads(input: ManagedFileOpenInput) -> Result<String, String> {
    let index = load_index(&input.user_id)?;
    let entry = index
        .entries
        .iter()
        .find(|f| f.id == input.file_id)
        .ok_or_else(|| "Managed file not found".to_string())?;
    let full_path = resolve_entry_path(&input.user_id, entry)?;
    
    // Get the Downloads folder
    let downloads_dir = dirs::download_dir()
        .ok_or_else(|| "Could not find Downloads folder".to_string())?;
    
    // Get the filename from the entry
    let filename = entry.filename.clone();
    let dest_path = downloads_dir.join(&filename);
    
    // Copy the file to Downloads
    std::fs::copy(&full_path, &dest_path)
        .map_err(|e| format!("Failed to copy file to Downloads: {}", e))?;
    
    Ok(format!("Saved to:\n{}", dest_path.display()))
}

#[tauri::command]
async fn open_file_path(path: String) -> Result<String, String> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {}", path));
    }
    open_path_in_os(&file_path)?;
    Ok(format!("Opened {}", path))
}

#[tauri::command]
async fn open_managed_file_parent(input: ManagedFileOpenInput) -> Result<String, String> {
    let index = load_index(&input.user_id)?;
    let entry = index
        .entries
        .iter()
        .find(|f| f.id == input.file_id)
        .ok_or_else(|| "Managed file not found".to_string())?;
    let full_path = resolve_entry_path(&input.user_id, entry)?;
    let parent = full_path
        .parent()
        .ok_or_else(|| "Managed file parent directory not found".to_string())?;
    open_path_in_os(parent)?;
    Ok(format!("Opened {}", parent.display()))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)
            .map_err(|e| format!("Failed creating destination {}: {}", dst.display(), e))?;
    }
    for entry in std::fs::read_dir(src).map_err(|e| format!("Failed reading {}: {}", src.display(), e))? {
        let entry = entry.map_err(|e| format!("Failed reading directory entry: {}", e))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                format!(
                    "Failed copying file {} to {}: {}",
                    src_path.display(),
                    dst_path.display(),
                    e
                )
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
async fn export_managed_files_backup(input: ManagedFilesBackupInput) -> Result<String, String> {
    let user_root = get_user_root(&input.user_id)?;
    if !user_root.exists() {
        return Err("No local managed files found for this user".to_string());
    }
    let backup_root = get_app_data_root()?.join("backups").join(sanitize_segment(&input.user_id));
    let backup_dir = backup_root.join(format!("backup-{}", epoch_seconds()));
    std::fs::create_dir_all(&backup_dir)
        .map_err(|e| format!("Failed creating backup directory: {}", e))?;
    copy_dir_recursive(&user_root, &backup_dir)?;
    Ok(backup_dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn import_managed_files_backup(input: ManagedFilesImportInput) -> Result<usize, String> {
    let source = PathBuf::from(&input.backup_path);
    if !source.exists() || !source.is_dir() {
        return Err("Backup path does not exist or is not a directory".to_string());
    }
    let user_root = get_user_root(&input.user_id)?;
    std::fs::create_dir_all(&user_root)
        .map_err(|e| format!("Failed creating user root {}: {}", user_root.display(), e))?;

    let source_index_path = source.join("index").join("files-index.json");
    let source_index_content = std::fs::read_to_string(&source_index_path).map_err(|e| {
        format!(
            "Backup index not found at {}: {}",
            source_index_path.display(),
            e
        )
    })?;
    let source_index: ManagedFileIndex = serde_json::from_str(&source_index_content)
        .map_err(|e| format!("Invalid backup index: {}", e))?;

    copy_dir_recursive(&source.join("storage"), &user_root.join("storage"))?;

    update_index(&input.user_id, |dest_index| {
        let mut imported = 0usize;
        let mut projected_bytes: u64 = dest_index.entries.iter().map(|e| e.size).sum();
        for mut entry in source_index.entries {
            if dest_index.entries.len() >= MAX_MANAGED_FILES_PER_USER {
                break;
            }
            if resolve_entry_path(&input.user_id, &entry).is_err() {
                continue;
            }
            let exists = dest_index.entries.iter().any(|e| {
                e.relative_path == entry.relative_path && e.filename == entry.filename && e.feature == entry.feature
            });
            if exists {
                continue;
            }
            if projected_bytes.saturating_add(entry.size) > MAX_MANAGED_FILES_TOTAL_BYTES {
                break;
            }
            entry.id = format!("mf_import_{}_{}", epoch_seconds(), sanitize_segment(&entry.stored_name));
            entry.user_id = input.user_id.clone();
            entry.updated_at = now_iso_like();
            projected_bytes = projected_bytes.saturating_add(entry.size);
            dest_index.entries.push(entry);
            imported += 1;
        }
        Ok(imported)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_app_config_path,
            greet,
            list_files,
            write_file_async,
            read_file_async,
            read_file_base64,
            copy_file_async,
            rename_file_async,
            delete_file_async,
            create_directory_async,
            remove_directory_async,
            file_exists_async,
            get_file_metadata_async,
            run_python_script,
            run_javascript_script,
            run_bot_streaming,
            register_managed_file,
            register_managed_file_base64,
            get_managed_files,
            preview_managed_file,
            delete_managed_files,
            move_managed_files,
            open_managed_file,
            open_file_path,
            get_managed_file_path,
            save_managed_file_to_downloads,
            open_managed_file_parent,
            export_managed_files_backup,
            import_managed_files_backup,
            get_managed_files_quota,
            rebuild_managed_files_index
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

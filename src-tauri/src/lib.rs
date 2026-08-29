use serde::Serialize;
use std::path::Path;

mod native_db;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFilePayload {
    name: String,
    path: String,
    size: u64,
}

fn allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "parquet"
                    | "pq"
                    | "csv"
                    | "tsv"
                    | "json"
                    | "jsonl"
                    | "ndjson"
                    | "duckdb"
                    | "db"
                    | "ddb"
            )
        })
        .unwrap_or(false)
}

fn database_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "duckdb" | "db" | "ddb"
            )
        })
        .unwrap_or(false)
}

fn collect_database_files(directory: &Path, files: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(directory).map_err(|error| format!("无法读取目录：{error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取目录项：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取目录项类型：{error}"))?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_database_files(&path, files)?;
        } else if file_type.is_file() && database_extension(&path) {
            files.push(path.to_string_lossy().into_owned());
        }
    }
    Ok(())
}

#[tauri::command(async)]
fn list_database_files(path: String) -> Result<Vec<String>, String> {
    let directory = Path::new(&path);
    let metadata =
        std::fs::metadata(directory).map_err(|error| format!("无法读取目录信息：{error}"))?;
    if !metadata.is_dir() {
        return Err("所选路径不是目录".into());
    }
    let mut files = Vec::new();
    collect_database_files(directory, &mut files)?;
    files.sort_unstable_by_key(|item| item.to_ascii_lowercase());
    Ok(files)
}

#[tauri::command(async)]
fn get_local_file_info(path: String) -> Result<LocalFilePayload, String> {
    let file_path = Path::new(&path);
    if !allowed_extension(file_path) {
        return Err("不支持该文件格式".into());
    }
    let metadata =
        std::fs::metadata(file_path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".into());
    }
    let name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data")
        .to_owned();
    Ok(LocalFilePayload {
        name,
        path,
        size: metadata.len(),
    })
}

#[tauri::command(async)]
fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| !extension.eq_ignore_ascii_case("xlsx"))
        .unwrap_or(true)
    {
        return Err("导出文件必须使用 .xlsx 扩展名".into());
    }
    std::fs::write(file_path, data).map_err(|error| format!("无法写入 Excel 文件：{error}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(native_db::NativeAppState::default())
        .invoke_handler(tauri::generate_handler![
            get_local_file_info,
            list_database_files,
            write_binary_file,
            native_db::list_native_objects,
            native_db::list_native_object_columns,
            native_db::describe_native_object,
            native_db::execute_native_sql,
            native_db::cancel_native_sql
        ])
        .run(tauri::generate_context!())
        .expect("error while running SQL Viewer");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_supported_data_files() {
        assert!(allowed_extension(Path::new("sample.parquet")));
        assert!(allowed_extension(Path::new("sample.CSV")));
        assert!(allowed_extension(Path::new("sample.jsonl")));
        assert!(allowed_extension(Path::new("sample.duckdb")));
        assert!(!allowed_extension(Path::new("sample.xlsx")));
    }
}

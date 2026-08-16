use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalFilePayload {
    name: String,
    path: String,
    size: u64,
    data: Vec<u8>,
}

fn allowed_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "parquet" | "pq" | "csv" | "tsv" | "json" | "jsonl" | "ndjson" | "duckdb" | "db" | "ddb"
            )
        })
        .unwrap_or(false)
}

#[tauri::command(async)]
fn read_local_file(path: String) -> Result<LocalFilePayload, String> {
    let file_path = Path::new(&path);
    if !allowed_extension(file_path) {
        return Err("不支持该文件格式".into());
    }
    let metadata = std::fs::metadata(file_path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".into());
    }
    let data = std::fs::read(file_path).map_err(|error| format!("无法读取文件：{error}"))?;
    let name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("data")
        .to_owned();
    Ok(LocalFilePayload {
        name,
        path,
        size: metadata.len(),
        data,
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
        .invoke_handler(tauri::generate_handler![read_local_file, write_binary_file])
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

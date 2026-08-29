use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use duckdb::{
    types::{TimeUnit, ValueRef},
    AccessMode, Config, Connection, InterruptHandle,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::State;

const MAX_RESULT_ROWS: usize = 100_000;

#[derive(Default)]
pub struct NativeAppState {
    active_interrupt: Mutex<Option<Arc<InterruptHandle>>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSourceSpec {
    pub path: String,
    pub alias: String,
    pub format: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeObjectSpec {
    pub path: String,
    pub alias: String,
    pub format: String,
    pub schema: String,
    pub object_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeObject {
    pub database_alias: Option<String>,
    pub schema: String,
    pub name: String,
    pub kind: String,
    pub sql_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeObjectColumns {
    pub database_alias: Option<String>,
    pub schema: String,
    pub name: String,
    pub columns: Vec<NativeColumn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMetadata {
    pub columns: Vec<NativeColumn>,
    pub row_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub type_name: String,
    pub nullable: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum NativeCell {
    Null,
    Boolean(bool),
    Number(f64),
    Text(String),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeQueryResult {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<NativeCell>>,
    row_count: usize,
    elapsed_ms: f64,
    truncated: bool,
}

fn quote_identifier(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

fn quote_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn supported_format(format: &str) -> bool {
    matches!(format, "parquet" | "csv" | "json" | "duckdb")
}

fn source_path(source: &NativeSourceSpec) -> Result<PathBuf, String> {
    if !supported_format(&source.format) {
        return Err("不支持该数据格式".into());
    }
    let path = Path::new(&source.path);
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件信息：{error}"))?;
    if !metadata.is_file() {
        return Err("所选路径不是文件".into());
    }
    fs::canonicalize(path).map_err(|error| format!("无法解析文件路径：{error}"))
}

fn configured_connection() -> Result<Connection, String> {
    let temp_directory = std::env::temp_dir().join("sql-viewer-duckdb-temp");
    fs::create_dir_all(&temp_directory)
        .map_err(|error| format!("无法创建 DuckDB 临时目录：{error}"))?;
    let config = Config::default()
        .access_mode(AccessMode::Automatic)
        .map_err(|error| format!("DuckDB 配置失败：{error}"))?
        .max_memory("2GB")
        .map_err(|error| format!("DuckDB 内存配置失败：{error}"))?
        .threads(4)
        .map_err(|error| format!("DuckDB 线程配置失败：{error}"))?
        .enable_external_access(true)
        .map_err(|error| format!("DuckDB 外部文件配置失败：{error}"))?;
    let connection = Connection::open_in_memory_with_flags(config)
        .map_err(|error| format!("无法初始化 DuckDB：{error}"))?;
    connection
        .execute_batch(&format!(
            "SET temp_directory = {}; SET preserve_insertion_order = false;",
            quote_string(&temp_directory.to_string_lossy()),
        ))
        .map_err(|error| format!("DuckDB 临时空间配置失败：{error}"))?;
    Ok(connection)
}

fn file_reader(source: &NativeSourceSpec, path: &Path) -> Result<String, String> {
    let path = quote_string(&path.to_string_lossy());
    match source.format.as_str() {
        "parquet" => Ok(format!("read_parquet({path})")),
        "csv" => Ok(format!("read_csv_auto({path}, sample_size = -1)")),
        "json" => Ok(format!("read_json_auto({path})")),
        "duckdb" => Err("DuckDB 数据库不能作为文件表读取".into()),
        _ => Err("不支持该数据格式".into()),
    }
}

fn attach_database(
    connection: &Connection,
    source: &NativeSourceSpec,
    path: &Path,
) -> Result<(), String> {
    connection
        .execute_batch(&format!(
            "ATTACH {} AS {} (READ_ONLY)",
            quote_string(&path.to_string_lossy()),
            quote_identifier(&source.alias),
        ))
        .map_err(|error| format!("无法只读连接 DuckDB：{error}"))
}

fn prepare_source(
    connection: &Connection,
    source: &NativeSourceSpec,
) -> Result<(PathBuf, Option<String>), String> {
    let path = source_path(source)?;
    if source.format == "duckdb" {
        attach_database(connection, source, &path)?;
        Ok((path, None))
    } else {
        let reader = file_reader(source, &path)?;
        connection
            .execute_batch(&format!(
                "CREATE OR REPLACE VIEW {} AS SELECT * FROM {}",
                quote_identifier(&source.alias),
                reader,
            ))
            .map_err(|error| format!("无法注册数据文件：{error}"))?;
        Ok((path, Some(quote_identifier(&source.alias))))
    }
}

fn relation_for_object(source: &NativeObjectSpec) -> String {
    if source.format == "duckdb" {
        format!(
            "{}.{}.{}",
            quote_identifier(&source.alias),
            quote_identifier(&source.schema),
            quote_identifier(&source.object_name),
        )
    } else {
        quote_identifier(&source.alias)
    }
}

fn object_query(
    connection: &Connection,
    database_alias: &str,
    sql: &str,
    kind: &str,
) -> Result<Vec<NativeObject>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("读取 DuckDB 对象失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            let schema: String = row.get(0)?;
            let name: String = row.get(1)?;
            Ok(NativeObject {
                database_alias: Some(database_alias.to_owned()),
                schema: schema.clone(),
                name: name.clone(),
                kind: kind.to_owned(),
                sql_name: format!(
                    "{}.{}.{}",
                    quote_identifier(database_alias),
                    quote_identifier(&schema),
                    quote_identifier(&name),
                ),
            })
        })
        .map_err(|error| format!("读取 DuckDB 对象失败：{error}"))?;
    rows.collect::<duckdb::Result<Vec<_>>>()
        .map_err(|error| format!("读取 DuckDB 对象失败：{error}"))
}

#[tauri::command(async)]
pub fn list_native_objects(source: NativeSourceSpec) -> Result<Vec<NativeObject>, String> {
    let connection = configured_connection()?;
    let path = source_path(&source)?;
    if source.format != "duckdb" {
        file_reader(&source, &path)?;
        return Ok(vec![NativeObject {
            database_alias: None,
            schema: "main".into(),
            name: source.alias.clone(),
            kind: "FILE".into(),
            sql_name: quote_identifier(&source.alias),
        }]);
    }
    attach_database(&connection, &source, &path)?;
    let mut objects = object_query(
        &connection,
        &source.alias,
        &format!(
            "SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = {} AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name, table_name",
            quote_string(&source.alias),
        ),
        "TABLE",
    )?;
    objects.extend(object_query(
        &connection,
        &source.alias,
        &format!(
            "SELECT schema_name, view_name FROM duckdb_views() WHERE database_name = {} AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY schema_name, view_name",
            quote_string(&source.alias),
        ),
        "VIEW",
    )?);
    if objects.is_empty() {
        return Err("DuckDB 文件中没有可显示的表或视图".into());
    }
    Ok(objects)
}

fn describe_columns(connection: &Connection, relation: &str) -> Result<Vec<NativeColumn>, String> {
    let mut statement = connection
        .prepare(&format!("DESCRIBE SELECT * FROM {relation}"))
        .map_err(|error| format!("读取字段失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(NativeColumn {
                name: row.get(0)?,
                type_name: row.get(1)?,
                nullable: row.get(2)?,
            })
        })
        .map_err(|error| format!("读取字段失败：{error}"))?;
    rows.collect::<duckdb::Result<Vec<_>>>()
        .map_err(|error| format!("读取字段失败：{error}"))
}

fn describe_relation(connection: &Connection, relation: &str) -> Result<NativeMetadata, String> {
    let columns = describe_columns(connection, relation)?;
    let row_count: i64 = connection
        .query_row(&format!("SELECT count(*) FROM {relation}"), [], |row| {
            row.get(0)
        })
        .map_err(|error| format!("统计行数失败：{error}"))?;
    Ok(NativeMetadata {
        columns,
        row_count: row_count.max(0) as usize,
    })
}

fn list_attached_columns(
    connection: &Connection,
    database_alias: &str,
) -> Result<Vec<NativeObjectColumns>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_catalog = {} AND table_schema NOT IN ('information_schema', 'pg_catalog') ORDER BY table_schema, table_name, ordinal_position",
            quote_string(database_alias),
        ))
        .map_err(|error| format!("读取字段失败：{error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                NativeColumn {
                    name: row.get(2)?,
                    type_name: row.get(3)?,
                    nullable: row.get(4)?,
                },
            ))
        })
        .map_err(|error| format!("读取字段失败：{error}"))?;
    let mut grouped: Vec<NativeObjectColumns> = Vec::new();
    for row in rows {
        let (schema, name, column) = row.map_err(|error| format!("读取字段失败：{error}"))?;
        if let Some(object) = grouped
            .iter_mut()
            .find(|item| item.schema == schema && item.name == name)
        {
            object.columns.push(column);
        } else {
            grouped.push(NativeObjectColumns {
                database_alias: Some(database_alias.to_owned()),
                schema,
                name,
                columns: vec![column],
            });
        }
    }
    Ok(grouped)
}

#[tauri::command(async)]
pub fn list_native_object_columns(
    source: NativeSourceSpec,
) -> Result<Vec<NativeObjectColumns>, String> {
    let connection = configured_connection()?;
    let path = source_path(&source)?;
    if source.format == "duckdb" {
        attach_database(&connection, &source, &path)?;
        return list_attached_columns(&connection, &source.alias);
    }
    let reader = file_reader(&source, &path)?;
    let relation = quote_identifier(&source.alias);
    connection
        .execute_batch(&format!(
            "CREATE OR REPLACE VIEW {relation} AS SELECT * FROM {reader}"
        ))
        .map_err(|error| format!("无法注册数据文件：{error}"))?;
    Ok(vec![NativeObjectColumns {
        database_alias: None,
        schema: "main".into(),
        name: source.alias.clone(),
        columns: describe_columns(&connection, &relation)?,
    }])
}

#[tauri::command(async)]
pub fn describe_native_object(source: NativeObjectSpec) -> Result<NativeMetadata, String> {
    let connection = configured_connection()?;
    let basic_source = NativeSourceSpec {
        path: source.path.clone(),
        alias: source.alias.clone(),
        format: source.format.clone(),
    };
    let _ = prepare_source(&connection, &basic_source)?;
    describe_relation(&connection, &relation_for_object(&source))
}

fn date_text(days: i32) -> String {
    NaiveDate::from_ymd_opt(1970, 1, 1)
        .and_then(|date| date.checked_add_signed(Duration::days(i64::from(days))))
        .map(|date| date.to_string())
        .unwrap_or_else(|| days.to_string())
}

fn timestamp_text(unit: TimeUnit, value: i64) -> String {
    let micros = match unit {
        TimeUnit::Second => value.saturating_mul(1_000_000),
        TimeUnit::Millisecond => value.saturating_mul(1_000),
        TimeUnit::Microsecond => value,
        TimeUnit::Nanosecond => value / 1_000,
    };
    DateTime::<Utc>::from_timestamp_micros(micros)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Micros, true))
        .unwrap_or_else(|| value.to_string())
}

fn time_text(unit: TimeUnit, value: i64) -> String {
    let micros = match unit {
        TimeUnit::Second => value.saturating_mul(1_000_000),
        TimeUnit::Millisecond => value.saturating_mul(1_000),
        TimeUnit::Microsecond => value,
        TimeUnit::Nanosecond => value / 1_000,
    };
    let day = 86_400_000_000_i64;
    let normalized = micros.rem_euclid(day);
    let hours = normalized / 3_600_000_000;
    let minutes = (normalized / 60_000_000) % 60;
    let seconds = (normalized / 1_000_000) % 60;
    let fraction = normalized % 1_000_000;
    format!("{hours:02}:{minutes:02}:{seconds:02}.{fraction:06}")
}

fn integer_cell(value: i128) -> NativeCell {
    if value.unsigned_abs() <= 9_007_199_254_740_991 {
        NativeCell::Number(value as f64)
    } else {
        NativeCell::Text(value.to_string())
    }
}

fn unsigned_cell(value: u128) -> NativeCell {
    if value <= 9_007_199_254_740_991 {
        NativeCell::Number(value as f64)
    } else {
        NativeCell::Text(value.to_string())
    }
}

fn value_cell(value: ValueRef<'_>) -> NativeCell {
    match value {
        ValueRef::Null => NativeCell::Null,
        ValueRef::Boolean(value) => NativeCell::Boolean(value),
        ValueRef::TinyInt(value) => integer_cell(i128::from(value)),
        ValueRef::SmallInt(value) => integer_cell(i128::from(value)),
        ValueRef::Int(value) => integer_cell(i128::from(value)),
        ValueRef::BigInt(value) => integer_cell(i128::from(value)),
        ValueRef::HugeInt(value) => integer_cell(value),
        ValueRef::UHugeInt(value) => unsigned_cell(value),
        ValueRef::UTinyInt(value) => unsigned_cell(u128::from(value)),
        ValueRef::USmallInt(value) => unsigned_cell(u128::from(value)),
        ValueRef::UInt(value) => unsigned_cell(u128::from(value)),
        ValueRef::UBigInt(value) => unsigned_cell(u128::from(value)),
        ValueRef::Float(value) => {
            if value.is_finite() {
                NativeCell::Number(f64::from(value))
            } else {
                NativeCell::Text(value.to_string())
            }
        }
        ValueRef::Double(value) => {
            if value.is_finite() {
                NativeCell::Number(value)
            } else {
                NativeCell::Text(value.to_string())
            }
        }
        ValueRef::Decimal(value) => NativeCell::Text(value.to_string()),
        ValueRef::Text(value) => NativeCell::Text(String::from_utf8_lossy(value).into_owned()),
        ValueRef::Blob(value) | ValueRef::Geometry(value) => {
            let preview = value
                .iter()
                .take(64)
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            NativeCell::Text(if value.len() > 64 {
                format!("0x{preview}... ({} bytes)", value.len())
            } else {
                format!("0x{preview}")
            })
        }
        ValueRef::Date32(value) => NativeCell::Text(date_text(value)),
        ValueRef::Timestamp(unit, value) => NativeCell::Text(timestamp_text(unit, value)),
        ValueRef::Time64(unit, value) => NativeCell::Text(time_text(unit, value)),
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => NativeCell::Text(format!("{months} months, {days} days, {nanos} nanos")),
        ValueRef::Enum(..)
        | ValueRef::List(..)
        | ValueRef::Struct(..)
        | ValueRef::Array(..)
        | ValueRef::Map(..)
        | ValueRef::Union(..) => NativeCell::Text(format!("{:?}", value.to_owned())),
        _ => NativeCell::Text(format!("{:?}", value.to_owned())),
    }
}

fn protected_sql(sql: &str) -> Result<(String, bool), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL 不能为空".into());
    }
    let without_trailing_semicolon = trimmed.strip_suffix(';').unwrap_or(trimmed).trim_end();
    if without_trailing_semicolon.contains(';') {
        return Err("桌面查看器一次只允许执行一条 SQL".into());
    }
    let keyword = without_trailing_semicolon
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    match keyword.as_str() {
        "SELECT" | "WITH" => Ok((
            format!(
                "SELECT * FROM ({without_trailing_semicolon}) AS __sql_viewer_result LIMIT {}",
                MAX_RESULT_ROWS + 1,
            ),
            true,
        )),
        "EXPLAIN" | "SHOW" | "DESCRIBE" | "DESC" | "SUMMARIZE" => {
            Ok((without_trailing_semicolon.to_owned(), false))
        }
        _ => Err("桌面查看器仅允许 SELECT、WITH、EXPLAIN、SHOW、DESCRIBE 和 SUMMARIZE 查询".into()),
    }
}

fn run_query(connection: &Connection, sql: &str) -> Result<NativeQueryResult, String> {
    let started_at = Instant::now();
    let (sql, bounded) = protected_sql(sql)?;
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| format!("查询失败：{error}"))?;
    let mut rows = statement
        .query([])
        .map_err(|error| format!("查询失败：{error}"))?;
    let executed = rows.as_ref().ok_or_else(|| "查询结果不可用".to_owned())?;
    let columns = executed.column_names();
    let column_types = (0..executed.column_count())
        .map(|index| executed.column_type(index).to_string())
        .collect::<Vec<_>>();
    let mut values = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows
        .next()
        .map_err(|error| format!("读取查询结果失败：{error}"))?
    {
        if bounded && values.len() >= MAX_RESULT_ROWS {
            truncated = true;
            break;
        }
        let mut result_row = Vec::with_capacity(columns.len());
        for index in 0..columns.len() {
            result_row.push(value_cell(
                row.get_ref(index)
                    .map_err(|error| format!("读取查询结果失败：{error}"))?,
            ));
        }
        values.push(result_row);
    }
    Ok(NativeQueryResult {
        columns,
        column_types,
        row_count: values.len(),
        rows: values,
        elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        truncated,
    })
}

#[tauri::command(async)]
pub fn execute_native_sql(
    sql: String,
    sources: Vec<NativeSourceSpec>,
    state: State<'_, NativeAppState>,
) -> Result<NativeQueryResult, String> {
    let connection = configured_connection()?;
    let mut seen = HashSet::new();
    for source in sources {
        let key = format!("{}\0{}\0{}", source.path, source.alias, source.format);
        if !seen.insert(key) {
            continue;
        }
        prepare_source(&connection, &source)?;
    }
    let interrupt = connection.interrupt_handle();
    *state
        .active_interrupt
        .lock()
        .map_err(|_| "查询状态不可用".to_owned())? = Some(interrupt);
    let result = run_query(&connection, &sql);
    *state
        .active_interrupt
        .lock()
        .map_err(|_| "查询状态不可用".to_owned())? = None;
    result
}

#[tauri::command(async)]
pub fn cancel_native_sql(state: State<'_, NativeAppState>) -> Result<(), String> {
    let interrupt = state
        .active_interrupt
        .lock()
        .map_err(|_| "查询状态不可用".to_owned())?
        .clone();
    if let Some(interrupt) = interrupt {
        interrupt.interrupt();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sql-viewer-{name}-{}.duckdb", std::process::id()))
    }

    #[test]
    fn connects_database_by_path_and_loads_metadata_lazily() {
        let path = test_path("native");
        let _ = fs::remove_file(&path);
        let database = Connection::open(&path).unwrap();
        database
            .execute_batch(
                "CREATE TABLE orders(id INTEGER, amount DECIMAL(10, 2), created_at DATE);\
                 INSERT INTO orders VALUES (1, 12.50, DATE '2026-08-16'), (2, 30.00, DATE '2026-08-17');\
                 CREATE VIEW order_summary AS SELECT sum(amount) AS total FROM orders;",
            )
            .unwrap();
        drop(database);

        let source = NativeSourceSpec {
            path: path.to_string_lossy().into_owned(),
            alias: "jama".into(),
            format: "duckdb".into(),
        };
        let objects = list_native_objects(source.clone()).unwrap();
        assert_eq!(objects.len(), 2);
        assert!(objects
            .iter()
            .any(|object| object.name == "orders" && object.kind == "TABLE"));
        assert!(objects
            .iter()
            .any(|object| object.name == "order_summary" && object.kind == "VIEW"));

        let columns = list_native_object_columns(source.clone()).unwrap();
        let orders_columns = columns
            .iter()
            .find(|object| object.name == "orders")
            .expect("orders columns");
        assert_eq!(orders_columns.columns.len(), 3);
        assert_eq!(orders_columns.columns[0].name, "id");

        let metadata = describe_native_object(NativeObjectSpec {
            path: source.path.clone(),
            alias: source.alias.clone(),
            format: source.format.clone(),
            schema: "main".into(),
            object_name: "orders".into(),
        })
        .unwrap();
        assert_eq!(metadata.row_count, 2);
        assert_eq!(metadata.columns.len(), 3);

        let connection = configured_connection().unwrap();
        prepare_source(&connection, &source).unwrap();
        let result = run_query(
            &connection,
            "SELECT id, amount, created_at FROM \"jama\".\"main\".\"orders\" ORDER BY id",
        )
        .unwrap();
        assert_eq!(result.row_count, 2);
        assert!(!result.truncated);
        assert_eq!(result.columns, vec!["id", "amount", "created_at"]);

        drop(connection);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn protects_viewer_queries() {
        let (query, bounded) = protected_sql("SELECT * FROM range(200000);").unwrap();
        assert!(bounded);
        assert!(query.ends_with("LIMIT 100001"));
        assert!(protected_sql("DELETE FROM orders").is_err());
        assert!(protected_sql("SELECT 1; SELECT 2").is_err());
    }
}

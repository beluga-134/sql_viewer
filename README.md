# SQL Viewer

一个使用 Tauri 2、TypeScript 和 DuckDB 构建的本地数据查看器。Windows 桌面版使用原生 DuckDB 按路径查询，浏览器预览使用 DuckDB-WASM，支持同时打开多个文件、使用 SQL 联合查询，并将查询结果导出为 XLSX。

## 功能

- 打开 Parquet、CSV、TSV、JSON、JSONL、NDJSON 和 DuckDB（`.duckdb`/`.db`/`.ddb`）文件
- 每个文件注册为独立 DuckDB View，可跨文件 JOIN
- 以只读方式连接 DuckDB 数据库中的表和视图，可直接使用三段式名称查询
- 桌面版只向 Rust 后端传文件路径，不通过 IPC 复制完整数据库
- 打开 DuckDB 时只枚举表名，点击表后才读取字段和统计行数
- 原生查询限制为 2 GB 内存、4 个线程，超限工作数据写入系统临时目录
- 单次结果最多返回 100,000 行，可取消正在执行的桌面查询
- 展示字段名、DuckDB 类型、文件大小和行数
- SQL 查询与本地查询历史
- 结果表格固定表头和行号
- 导出当前完整查询结果为 XLSX
- 浏览器预览和 Windows Tauri 桌面模式

## Windows 启动

项目会优先复用相邻 `qq_codex` 项目中的 Windows Node、Rust 和 Build Tools 工具链，也支持系统已安装的 Node、Rust 与 Visual Studio Build Tools。

```batch
start.cmd
```

执行完整检查：

```batch
check.cmd
```

在 WSL 中可以运行：

```bash
./start.sh
./check.sh
```

## 浏览器预览

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:1420/`。浏览器模式通过文件选择器读取本地文件，导出时使用浏览器下载。

## SQL 示例

打开文件后会自动生成带引号的 View 名称：

```sql
SELECT *
FROM "orders"
LIMIT 500;
```

DuckDB 文件中的对象会显示为 `数据库别名.模式.表名`，查询时使用三段式名称：

```sql
SELECT *
FROM "analytics"."main"."orders"
LIMIT 500;
```

多个文件可以直接 JOIN：

```sql
SELECT a.*, b.category_name
FROM "orders" a
LEFT JOIN "categories" b ON a.category_id = b.id;
```

## 架构

- `src/duckdb.ts`：浏览器模式的 DuckDB-WASM 文件注册和查询
- `src/xlsx.ts`：ExcelJS 工作簿生成
- `src/backend.ts`：Tauri 原生查询与浏览器文件读写适配
- `src-tauri/src/native_db.rs`：原生 DuckDB 路径连接、延迟元数据、资源限制和查询取消

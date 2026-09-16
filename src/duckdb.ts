import * as duckdb from "@duckdb/duckdb-wasm";

import type {
  CellValue,
  DataSource,
  QueryResult,
  SourceColumn,
  SourceFormat,
} from "./types";

type EngineState = {
  db: duckdb.AsyncDuckDB;
  connection: duckdb.AsyncDuckDBConnection;
};

let engine: EngineState | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function readerExpression(format: SourceFormat, virtualName: string): string {
  const file = quoteString(virtualName);
  if (format === "parquet") return `read_parquet(${file})`;
  if (format === "csv") return `read_csv_auto(${file}, sample_size = -1)`;
  return `read_json_auto(${file})`;
}

function normalizeObject(value: unknown): string {
  try {
    return JSON.stringify(value, (_, nested) =>
      typeof nested === "bigint" ? nested.toString() : nested,
    );
  } catch {
    return String(value);
  }
}

type ArrowField = {
  type?: {
    scale?: number;
    toString?: () => string;
  };
};

function decimalText(value: unknown, scale: number): string {
  let raw: string;
  if (typeof value === "bigint" || typeof value === "number" || typeof value === "string") {
    raw = String(value);
  } else if (value && typeof value === "object" && typeof (value as { toJSON?: () => unknown }).toJSON === "function") {
    raw = String((value as { toJSON: () => unknown }).toJSON());
  } else {
    raw = String(value);
  }
  raw = raw.replace(/^"|"$/g, "");
  if (!/^-?\d+$/.test(raw) || scale <= 0) return raw;
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function timestampText(value: unknown, typeLabel: string): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds)) return String(value);
  const wholeMilliseconds = Math.trunc(milliseconds);
  let iso = new Date(wholeMilliseconds).toISOString();
  if (typeLabel.includes("MICROSECOND")) {
    const extraMicros = Math.round(Math.abs(milliseconds - wholeMilliseconds) * 1000);
    if (extraMicros > 0) {
      iso = iso.replace(/(\.\d{3})Z$/, `$1${String(extraMicros).padStart(3, "0")}Z`);
    }
  }
  return iso;
}

function normalizeCell(value: unknown, field?: ArrowField): CellValue {
  if (value === null || value === undefined) return null;
  const typeLabel = field?.type?.toString?.() ?? "";
  if (typeLabel.startsWith("Date")) return new Date(Number(value)).toISOString().slice(0, 10);
  if (typeLabel.startsWith("Timestamp")) return timestampText(value, typeLabel);
  if (typeLabel.startsWith("Decimal")) return decimalText(value, field?.type?.scale ?? 0);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) {
    const preview = Array.from(value.slice(0, 64), (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `0x${preview}${value.length > 64 ? `... (${value.length} bytes)` : ""}`;
  }
  if (Array.isArray(value)) return normalizeObject(value);
  if (typeof value === "object") {
    const candidate = value as { toJSON?: () => unknown; toString?: () => string };
    if (typeof candidate.toJSON === "function") {
      const json = candidate.toJSON();
      if (json !== value) return normalizeCell(json, field);
    }
    const rendered = candidate.toString?.();
    if (rendered && rendered !== "[object Object]") return rendered;
    return normalizeObject(value);
  }
  return String(value);
}

function tableToRows(table: any): Omit<QueryResult, "elapsedMs"> {
  const fields = table.schema?.fields ?? [];
  const vectors = fields.map((_: unknown, index: number) => table.getChildAt(index));
  const rows: CellValue[][] = [];
  for (let rowIndex = 0; rowIndex < table.numRows; rowIndex += 1) {
    rows.push(vectors.map((vector: any, columnIndex: number) =>
      normalizeCell(vector?.get(rowIndex), fields[columnIndex]),
    ));
  }
  return {
    columns: fields.map((field: any) => String(field.name)),
    columnTypes: fields.map((field: any) => String(field.type)),
    rows,
    rowCount: table.numRows ?? rows.length,
  };
}

async function createWorker(workerUrl: string): Promise<Worker> {
  return new Worker(workerUrl);
}

export async function initializeEngine(): Promise<void> {
  if (engine) return;
  const [mvpModule, mvpWorker] = await Promise.all([
    import("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url"),
    import("@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url"),
  ]);
  const bundles: duckdb.DuckDBBundles = {
    mvp: { mainModule: mvpModule.default, mainWorker: mvpWorker.default },
  };
  const bundle = await duckdb.selectBundle(bundles);
  if (!bundle.mainWorker) throw new Error("DuckDB Worker 不可用");
  const worker = await createWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule);
  await db.open({});
  engine = { db, connection: await db.connect() };
}

function requireEngine(): EngineState {
  if (!engine) throw new Error("DuckDB 尚未初始化");
  return engine;
}

export async function registerSource(
  source: Pick<DataSource, "alias" | "virtualName" | "format">,
  data: Uint8Array,
): Promise<{ columns: SourceColumn[]; rowCount: number }> {
  const { db, connection } = requireEngine();
  await db.registerFileBuffer(source.virtualName, data);
  try {
    await connection.query(
      `CREATE OR REPLACE VIEW ${quoteIdentifier(source.alias)} AS ` +
        `SELECT * FROM ${readerExpression(source.format, source.virtualName)}`,
    );
    const description = tableToRows(
      await connection.query(`DESCRIBE SELECT * FROM ${quoteIdentifier(source.alias)}`),
    );
    const columns = description.rows.map((row) => ({
      name: String(row[0] ?? ""),
      type: String(row[1] ?? "UNKNOWN"),
      nullable: String(row[2] ?? "YES"),
    }));
    const count = tableToRows(
      await connection.query(`SELECT count(*) AS row_count FROM ${quoteIdentifier(source.alias)}`),
    );
    return { columns, rowCount: Number(count.rows[0]?.[0] ?? 0) };
  } catch (error) {
    await db.dropFile(source.virtualName).catch(() => undefined);
    throw error;
  }
}

export type DuckDBObjectMetadata = {
  schema: string;
  name: string;
  kind: "TABLE" | "VIEW";
  sqlName: string;
  columns: SourceColumn[];
};

export async function describeDuckDBObject(
  databaseAlias: string,
  schemaName: string,
  objectName: string,
): Promise<{ columns: SourceColumn[]; rowCount: number }> {
  const { connection } = requireEngine();
  const relation = `${quoteIdentifier(databaseAlias)}.${quoteIdentifier(schemaName)}.${quoteIdentifier(objectName)}`;
  const columns = await readDuckDBColumns(connection, databaseAlias, schemaName, objectName);
  const count = tableToRows(await connection.query(`SELECT count(*) FROM ${relation}`));
  return { columns, rowCount: Number(count.rows[0]?.[0] ?? 0) };
}

async function readDuckDBColumns(
  connection: duckdb.AsyncDuckDBConnection,
  databaseAlias: string,
  schemaName?: string,
  objectName?: string,
): Promise<SourceColumn[]> {
  const predicates = [
    `database_name = ${quoteString(databaseAlias)}`,
    `schema_name NOT IN ('information_schema', 'pg_catalog')`,
  ];
  if (schemaName !== undefined) predicates.push(`schema_name = ${quoteString(schemaName)}`);
  if (objectName !== undefined) predicates.push(`table_name = ${quoteString(objectName)}`);
  return tableToRows(
    await connection.query(
      `SELECT column_name, data_type, ` +
        `CASE WHEN is_nullable THEN 'YES' ELSE 'NO' END, comment ` +
        `FROM duckdb_columns() WHERE ${predicates.join(" AND ")} ` +
        `ORDER BY schema_name, table_name, column_index`,
    ),
  ).rows.map((row) => ({
    name: String(row[0] ?? ""),
    type: String(row[1] ?? "UNKNOWN"),
    nullable: String(row[2] ?? "YES"),
    comment: row[3] === null ? null : String(row[3]),
  }));
}

export async function registerDuckDBSource(
  virtualName: string,
  databaseAlias: string,
  data: Uint8Array,
): Promise<DuckDBObjectMetadata[]> {
  const { db, connection } = requireEngine();
  await db.registerFileBuffer(virtualName, data);
  const database = quoteIdentifier(databaseAlias);
  try {
    await connection.query(`ATTACH ${quoteString(virtualName)} AS ${database} (READ_ONLY)`);
    const tables = tableToRows(
      await connection.query(
        `SELECT schema_name, table_name FROM duckdb_tables() ` +
          `WHERE database_name = ${quoteString(databaseAlias)} ` +
          `AND schema_name NOT IN ('information_schema', 'pg_catalog') ` +
          `ORDER BY schema_name, table_name`,
      ),
    );
    const views = tableToRows(
      await connection.query(
        `SELECT schema_name, view_name FROM duckdb_views() ` +
          `WHERE database_name = ${quoteString(databaseAlias)} ` +
          `AND schema_name NOT IN ('information_schema', 'pg_catalog') ` +
          `ORDER BY schema_name, view_name`,
      ),
    );
    const objects = [
      ...tables.rows.map((row) => ({ schema: String(row[0]), name: String(row[1]), kind: "TABLE" as const })),
      ...views.rows.map((row) => ({ schema: String(row[0]), name: String(row[1]), kind: "VIEW" as const })),
    ];
    const columnRows = tableToRows(
      await connection.query(
        `SELECT schema_name, table_name, column_name, data_type, ` +
          `CASE WHEN is_nullable THEN 'YES' ELSE 'NO' END, comment ` +
          `FROM duckdb_columns() ` +
          `WHERE database_name = ${quoteString(databaseAlias)} ` +
          `AND schema_name NOT IN ('information_schema', 'pg_catalog') ` +
          `ORDER BY schema_name, table_name, column_index`,
      ),
    ).rows;
    const metadata = objects.map((object) => ({
      ...object,
      sqlName: `${database}.${quoteIdentifier(object.schema)}.${quoteIdentifier(object.name)}`,
      columns: columnRows
        .filter((row) => String(row[0]) === object.schema && String(row[1]) === object.name)
        .map((row) => ({
          name: String(row[2] ?? ""),
          type: String(row[3] ?? "UNKNOWN"),
          nullable: String(row[4] ?? "YES"),
          comment: row[5] === null ? null : String(row[5]),
        })),
    }));
    if (metadata.length === 0) {
      throw new Error("DuckDB 文件中没有可显示的表或视图");
    }
    return metadata;
  } catch (error) {
    await connection.query(`DETACH ${database}`).catch(() => undefined);
    await db.dropFile(virtualName).catch(() => undefined);
    throw error;
  }
}

export async function unregisterSource(source: DataSource): Promise<void> {
  const { db, connection } = requireEngine();
  if (source.databaseAlias) {
    await connection.query(`DETACH ${quoteIdentifier(source.databaseAlias)}`);
    await db.dropFile(source.virtualName).catch(() => undefined);
    return;
  }
  await connection.query(`DROP VIEW IF EXISTS ${quoteIdentifier(source.alias)}`);
  await db.dropFile(source.virtualName).catch(() => undefined);
}

export async function executeSql(sql: string): Promise<QueryResult> {
  const { connection } = requireEngine();
  const startedAt = performance.now();
  const table = await connection.query(sql);
  return {
    ...tableToRows(table),
    elapsedMs: performance.now() - startedAt,
  };
}

export function defaultQuery(sqlName: string): string {
  return `SELECT *\nFROM ${sqlName}\nLIMIT 500;`;
}

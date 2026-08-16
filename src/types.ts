export type SourceFormat = "parquet" | "csv" | "json" | "duckdb";

export interface LocalFilePayload {
  name: string;
  path: string;
  size: number;
  data: number[];
}

export interface SourceColumn {
  name: string;
  type: string;
  nullable: string;
}

export interface DataSource {
  id: string;
  name: string;
  path: string | null;
  alias: string;
  sqlName: string;
  virtualName: string;
  format: SourceFormat;
  size: number;
  rowCount: number;
  columns: SourceColumn[];
  databaseId?: string;
  databaseAlias?: string;
  objectKind?: "TABLE" | "VIEW";
}

export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: string[];
  columnTypes: string[];
  rows: CellValue[][];
  rowCount: number;
  elapsedMs: number;
}

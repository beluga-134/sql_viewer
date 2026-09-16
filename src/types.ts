export type SourceFormat = "parquet" | "csv" | "json" | "duckdb";

export interface LocalFilePayload {
  name: string;
  path: string;
  size: number;
  data?: number[];
}

export interface SourceColumn {
  name: string;
  type: string;
  nullable: string;
  comment?: string | null;
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
  columnsLoaded?: boolean;
  metadataLoaded?: boolean;
  metadataLoading?: boolean;
  native?: boolean;
  schema?: string;
  objectName?: string;
  databaseId?: string;
  databaseAlias?: string;
  objectKind?: "TABLE" | "VIEW" | "FILE";
  projectFolderId?: string;
}

export type CellValue = string | number | boolean | null;

export interface QueryResult {
  columns: string[];
  columnTypes: string[];
  columnComments?: Array<string | null>;
  rows: CellValue[][];
  rowCount: number;
  elapsedMs: number;
  truncated?: boolean;
}

import { invoke } from "@tauri-apps/api/core";

import type { LocalFilePayload, QueryResult, SourceColumn, SourceFormat } from "./types";

export type NativeSourceSpec = {
  path: string;
  alias: string;
  format: SourceFormat;
};

export type NativeObject = {
  databaseAlias?: string;
  schema: string;
  name: string;
  kind: "TABLE" | "VIEW" | "FILE";
  sqlName: string;
};

export type NativeObjectColumns = {
  databaseAlias?: string;
  schema: string;
  name: string;
  columns: SourceColumn[];
};

export type NativeMetadata = {
  columns: SourceColumn[];
  rowCount: number;
};

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export async function chooseSourcePaths(): Promise<string[]> {
  if (!isTauriRuntime()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "数据文件",
        extensions: ["parquet", "pq", "csv", "tsv", "json", "jsonl", "ndjson", "duckdb", "db", "ddb"],
      },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function chooseDatabaseDirectory(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    directory: true,
  });
  return typeof selected === "string" ? selected : null;
}

export async function listDatabaseFiles(path: string): Promise<string[]> {
  return invoke<string[]>("list_database_files", { path });
}

export async function getLocalFileInfo(path: string): Promise<LocalFilePayload> {
  return invoke<LocalFilePayload>("get_local_file_info", { path });
}

export async function listNativeObjects(source: NativeSourceSpec): Promise<NativeObject[]> {
  return invoke<NativeObject[]>("list_native_objects", { source });
}

export async function listNativeObjectColumns(source: NativeSourceSpec): Promise<NativeObjectColumns[]> {
  return invoke<NativeObjectColumns[]>("list_native_object_columns", { source });
}

export async function describeNativeObject(
  source: NativeSourceSpec & { schema: string; objectName: string },
): Promise<NativeMetadata> {
  return invoke<NativeMetadata>("describe_native_object", {
    source: {
      ...source,
      schema: source.schema,
      objectName: source.objectName,
    },
  });
}

export async function executeNativeSql(sql: string, sources: NativeSourceSpec[]): Promise<QueryResult> {
  return invoke<QueryResult>("execute_native_sql", { sql, sources });
}

export async function cancelNativeSql(): Promise<void> {
  await invoke<void>("cancel_native_sql");
}

export async function saveWorkbook(data: Uint8Array, suggestedName: string): Promise<boolean> {
  if (!isTauriRuntime()) {
    const bytes = new Uint8Array(data);
    const blob = new Blob([bytes.buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = suggestedName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return true;
  }

  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({
    defaultPath: suggestedName,
    filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
  });
  if (!path) return false;
  await invoke<void>("write_binary_file", { path, data: Array.from(data) });
  return true;
}

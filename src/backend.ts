import { invoke } from "@tauri-apps/api/core";

import type { LocalFilePayload } from "./types";

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
        extensions: ["parquet", "pq", "csv", "tsv", "json", "jsonl", "ndjson"],
      },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

export async function readLocalFile(path: string): Promise<LocalFilePayload> {
  return invoke<LocalFilePayload>("read_local_file", { path });
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

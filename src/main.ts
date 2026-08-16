import {
  Braces,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  createIcons,
  Database,
  FileInput,
  FileSpreadsheet,
  Files,
  LoaderCircle,
  Play,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide";

import "./styles.css";
import {
  cancelNativeSql,
  chooseSourcePaths,
  describeNativeObject,
  executeNativeSql,
  getLocalFileInfo,
  isTauriRuntime,
  listNativeObjects,
  saveWorkbook,
} from "./backend";
import type { NativeSourceSpec } from "./backend";
import {
  defaultQuery,
  describeDuckDBObject,
  executeSql,
  initializeEngine,
  registerDuckDBSource,
  registerSource,
  unregisterSource,
} from "./duckdb";
import type { DataSource, QueryResult, SourceFormat } from "./types";
import { buildWorkbook } from "./xlsx";

const iconSet = {
  Braces,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clock3,
  Database,
  FileInput,
  FileSpreadsheet,
  Files,
  LoaderCircle,
  Play,
  Plus,
  Search,
  Table2,
  Trash2,
  X,
};

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

app.innerHTML = `
  <main class="app-shell">
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark"><i data-lucide="database"></i></span>
        <div><strong>SQL Viewer</strong><span>DuckDB local workspace</span></div>
      </div>
      <div class="engine-state" id="engine-state">
        <i data-lucide="loader-circle" class="spin"></i>
        <span>正在初始化 DuckDB</span>
      </div>
    </header>

    <div class="workspace">
      <aside class="source-panel" aria-label="数据源">
        <div class="panel-heading">
          <div><span>数据源</span><em id="source-count">0</em></div>
          <button class="icon-button" id="add-source" title="打开数据文件" aria-label="打开数据文件">
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="source-search">
          <i data-lucide="search"></i>
          <input id="source-search" type="search" placeholder="筛选文件" autocomplete="off" />
        </div>
        <div class="source-list" id="source-list"></div>
        <div class="schema-panel">
          <div class="schema-heading"><span>字段</span><em id="column-count">0</em></div>
          <div class="schema-list" id="schema-list"></div>
        </div>
      </aside>

      <section class="query-workspace">
        <div class="query-toolbar">
          <div class="query-actions">
            <button class="primary-button" id="run-query" disabled>
              <i data-lucide="play"></i><span>运行</span>
            </button>
            <button class="secondary-button" id="export-xlsx" disabled>
              <i data-lucide="file-spreadsheet"></i><span>导出 XLSX</span>
            </button>
            <button class="secondary-button" id="cancel-query" hidden>
              <i data-lucide="x"></i><span>取消</span>
            </button>
          </div>
          <label class="history-control">
            <i data-lucide="clock-3"></i>
            <select id="query-history" aria-label="查询历史">
              <option value="">查询历史</option>
            </select>
          </label>
        </div>

        <div class="editor-wrap">
          <div class="editor-gutter" aria-hidden="true">SQL</div>
          <textarea id="sql-editor" spellcheck="false" autocomplete="off" aria-label="SQL 编辑器">SELECT 42 AS answer;</textarea>
        </div>

        <div class="result-heading">
          <div class="result-title"><i data-lucide="table-2"></i><strong>查询结果</strong></div>
          <div class="result-meta" id="result-meta">等待查询</div>
        </div>

        <div class="result-host" id="result-host">
          <div class="empty-state" id="empty-result">
            <i data-lucide="braces"></i>
            <strong>暂无查询结果</strong>
          </div>
        </div>
      </section>
    </div>

    <footer class="status-bar">
      <span id="status-message">准备初始化</span>
      <span id="runtime-mode">${isTauriRuntime() ? "Windows Desktop" : "Browser Preview"}</span>
    </footer>
  </main>

  <input id="browser-file-input" type="file" accept=".parquet,.pq,.csv,.tsv,.json,.jsonl,.ndjson,.duckdb,.db,.ddb" multiple hidden />
  <div class="drop-overlay" id="drop-overlay" hidden>
    <div><i data-lucide="file-input"></i><strong>松开以打开文件</strong></div>
  </div>
  <div class="toast" id="toast" role="status" hidden>
    <i data-lucide="circle-check"></i><span></span><button aria-label="关闭"><i data-lucide="x"></i></button>
  </div>
`;

createIcons({ icons: iconSet });

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const sourceList = query<HTMLDivElement>("#source-list");
const schemaList = query<HTMLDivElement>("#schema-list");
const sourceSearch = query<HTMLInputElement>("#source-search");
const editor = query<HTMLTextAreaElement>("#sql-editor");
const runButton = query<HTMLButtonElement>("#run-query");
const exportButton = query<HTMLButtonElement>("#export-xlsx");
const cancelButton = query<HTMLButtonElement>("#cancel-query");
const historySelect = query<HTMLSelectElement>("#query-history");
const resultHost = query<HTMLDivElement>("#result-host");
const resultMeta = query<HTMLDivElement>("#result-meta");
const statusMessage = query<HTMLSpanElement>("#status-message");
const engineState = query<HTMLDivElement>("#engine-state");
const fileInput = query<HTMLInputElement>("#browser-file-input");
const dropOverlay = query<HTMLDivElement>("#drop-overlay");
const toast = query<HTMLDivElement>("#toast");

let sources: DataSource[] = [];
let selectedSourceId: string | null = null;
let currentResult: QueryResult | null = null;
let engineReady = false;
let busy = false;
let queryRunning = false;
let toastTimer = 0;
let cancelRequested = false;

const HISTORY_KEY = "sql-viewer.query-history.v1";
const MAX_RENDER_ROWS = 2500;

function readHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

let queryHistory = readHistory();

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function detectFormat(name: string): SourceFormat | null {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "parquet" || extension === "pq") return "parquet";
  if (extension === "csv" || extension === "tsv") return "csv";
  if (extension === "json" || extension === "jsonl" || extension === "ndjson") return "json";
  if (extension === "duckdb" || extension === "db" || extension === "ddb") return "duckdb";
  return null;
}

function sourceAlias(name: string, reserved: string[] = []): string {
  const withoutExtension = name.replace(/\.[^.]+$/, "");
  let alias = withoutExtension
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  if (!alias) alias = "data";
  if (/^\d/.test(alias)) alias = `data_${alias}`;
  const base = alias;
  let ordinal = 2;
  while (
    reserved.some((item) => item.toLowerCase() === alias.toLowerCase()) ||
    sources.some((source) =>
      source.alias.toLowerCase() === alias.toLowerCase() ||
      source.databaseAlias?.toLowerCase() === alias.toLowerCase(),
    )
  ) {
    alias = `${base}_${ordinal}`;
    ordinal += 1;
  }
  return alias;
}

function quoteAlias(alias: string): string {
  return `"${alias.replace(/"/g, '""')}"`;
}

function showToast(message: string, kind: "success" | "error" = "success"): void {
  window.clearTimeout(toastTimer);
  toast.classList.toggle("error", kind === "error");
  toast.querySelector("span")!.textContent = message;
  const icon = toast.querySelector("svg");
  if (icon) icon.outerHTML = `<i data-lucide="${kind === "error" ? "circle-alert" : "circle-check"}"></i>`;
  toast.hidden = false;
  createIcons({ icons: iconSet });
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}

function setStatus(message: string): void {
  statusMessage.textContent = message;
}

function setBusy(nextBusy: boolean, message?: string): void {
  busy = nextBusy;
  runButton.disabled = !engineReady || busy || !editor.value.trim();
  exportButton.disabled = busy || !currentResult || currentResult.columns.length === 0;
  cancelButton.hidden = !isTauriRuntime() || !queryRunning;
  if (message) setStatus(message);
  document.body.classList.toggle("busy", busy);
}

function selectedSource(): DataSource | null {
  return sources.find((source) => source.id === selectedSourceId) ?? null;
}

function renderHistory(): void {
  historySelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "查询历史";
  historySelect.append(placeholder);
  queryHistory.forEach((sql, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = sql.replace(/\s+/g, " ").slice(0, 90);
    historySelect.append(option);
  });
}

function saveHistory(sql: string): void {
  queryHistory = [sql, ...queryHistory.filter((item) => item !== sql)].slice(0, 30);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(queryHistory));
  renderHistory();
}

function renderSchema(): void {
  const source = selectedSource();
  query<HTMLElement>("#column-count").textContent = String(source?.columns.length ?? 0);
  schemaList.replaceChildren();
  if (!source) {
    const empty = document.createElement("div");
    empty.className = "schema-empty";
    empty.textContent = "未选择数据源";
    schemaList.append(empty);
    return;
  }
  if (!source.metadataLoaded) {
    const empty = document.createElement("div");
    empty.className = "schema-empty";
    empty.textContent = source.metadataLoading ? "正在加载字段" : "点击数据源加载字段和行数";
    schemaList.append(empty);
    return;
  }
  for (const column of source.columns) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "schema-row";
    row.title = `${column.name} · ${column.type}`;
    const name = document.createElement("span");
    name.textContent = column.name;
    const type = document.createElement("em");
    type.textContent = column.type;
    row.append(name, type);
    row.addEventListener("click", () => {
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const identifier = quoteAlias(column.name);
      editor.setRangeText(identifier, start, end, "end");
      editor.focus();
      setBusy(busy);
    });
    schemaList.append(row);
  }
}

function renderSources(): void {
  const filter = sourceSearch.value.trim().toLocaleLowerCase();
  const visibleSources = sources.filter((source) =>
    `${source.name} ${source.alias} ${source.path ?? ""}`.toLocaleLowerCase().includes(filter),
  );
  query<HTMLElement>("#source-count").textContent = String(sources.length);
  sourceList.replaceChildren();

  if (sources.length === 0) {
    const empty = document.createElement("button");
    empty.type = "button";
    empty.className = "source-empty";
    empty.innerHTML = `<i data-lucide="files"></i><span>打开数据文件</span>`;
    empty.addEventListener("click", () => void openSources());
    sourceList.append(empty);
    createIcons({ icons: iconSet });
    renderSchema();
    return;
  }

  for (const source of visibleSources) {
    const row = document.createElement("div");
    row.className = "source-row";
    row.classList.toggle("active", source.id === selectedSourceId);

    const select = document.createElement("button");
    select.type = "button";
    select.className = "source-select";
    select.title = source.path ?? source.name;
    select.innerHTML = `<i data-lucide="chevron-right"></i>`;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = source.alias;
    const details = document.createElement("small");
    const formatLabel = source.format === "duckdb"
      ? `DUCKDB ${source.objectKind ?? "TABLE"}`
      : source.format.toUpperCase();
    const metadata = source.metadataLoaded
      ? `${formatNumber(source.rowCount)} 行`
      : "点击加载字段";
    details.textContent = `${formatLabel} · ${metadata} · ${formatBytes(source.size)}`;
    copy.append(name, details);
    select.append(copy);
    select.addEventListener("click", () => void selectSource(source));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "source-remove";
    remove.title = "移除数据源";
    remove.setAttribute("aria-label", `移除 ${source.alias}`);
    remove.innerHTML = `<i data-lucide="trash-2"></i>`;
    remove.addEventListener("click", () => void removeSource(source));

    row.append(select, remove);
    sourceList.append(row);
  }
  createIcons({ icons: iconSet });
  renderSchema();
}

function cellText(value: QueryResult["rows"][number][number]): string {
  if (value === null) return "NULL";
  return String(value);
}

function renderResult(): void {
  resultHost.replaceChildren();
  if (!currentResult || currentResult.columns.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<i data-lucide="braces"></i><strong>暂无查询结果</strong>`;
    resultHost.append(empty);
    resultMeta.textContent = currentResult ? "查询已完成，无结果集" : "等待查询";
    createIcons({ icons: iconSet });
    exportButton.disabled = true;
    return;
  }

  const table = document.createElement("table");
  table.className = "result-table";
  const thead = document.createElement("thead");
  const headerRow = document.createElement("tr");
  const numberHeader = document.createElement("th");
  numberHeader.className = "row-number";
  numberHeader.textContent = "#";
  headerRow.append(numberHeader);
  currentResult.columns.forEach((column, index) => {
    const th = document.createElement("th");
    const name = document.createElement("strong");
    name.textContent = column;
    const type = document.createElement("span");
    type.textContent = currentResult!.columnTypes[index] ?? "";
    th.title = `${column} · ${type.textContent}`;
    th.append(name, type);
    headerRow.append(th);
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  const displayedRows = currentResult.rows.slice(0, MAX_RENDER_ROWS);
  displayedRows.forEach((row, rowIndex) => {
    const tr = document.createElement("tr");
    const rowNumber = document.createElement("th");
    rowNumber.className = "row-number";
    rowNumber.textContent = String(rowIndex + 1);
    tr.append(rowNumber);
    row.forEach((value) => {
      const td = document.createElement("td");
      td.classList.toggle("null-cell", value === null);
      const text = cellText(value);
      td.textContent = text;
      td.title = text;
      tr.append(td);
    });
    tbody.append(tr);
  });
  table.append(tbody);
  resultHost.append(table);

  const renderedSuffix = currentResult.rowCount > MAX_RENDER_ROWS
    ? ` · 屏幕显示前 ${formatNumber(MAX_RENDER_ROWS)} 行`
    : "";
  const truncatedSuffix = currentResult.truncated ? " · 已达到 100,000 行安全上限" : "";
  resultMeta.textContent = `${formatNumber(currentResult.rowCount)} 行 · ${currentResult.columns.length} 列 · ${currentResult.elapsedMs.toFixed(0)} ms${renderedSuffix}${truncatedSuffix}`;
  exportButton.disabled = busy;
}

type PendingSource = {
  name: string;
  path: string | null;
  size: number;
  data?: Uint8Array;
};

function nativeSourceSpec(source: DataSource): NativeSourceSpec {
  if (!source.path) throw new Error("桌面数据源缺少文件路径");
  return {
    path: source.path,
    alias: source.databaseAlias ?? source.alias,
    format: source.format,
  };
}

async function loadSourceMetadata(source: DataSource): Promise<void> {
  if (source.metadataLoaded || source.metadataLoading) return;
  if (!source.schema || !source.objectName) return;
  source.metadataLoading = true;
  renderSources();
  setBusy(true, `正在读取 ${source.alias} 的字段`);
  try {
    const metadata = source.native
      ? await describeNativeObject({
        ...nativeSourceSpec(source),
        schema: source.schema,
        objectName: source.objectName,
      })
      : await describeDuckDBObject(source.databaseAlias!, source.schema, source.objectName);
    source.columns = metadata.columns;
    source.rowCount = metadata.rowCount;
    source.metadataLoaded = true;
  } catch (error) {
    showToast(error instanceof Error ? error.message : "读取字段失败", "error");
  } finally {
    source.metadataLoading = false;
    renderSources();
    setBusy(false, source.metadataLoaded ? `已加载 ${source.alias} 的字段` : "读取字段失败");
  }
}

async function selectSource(source: DataSource): Promise<void> {
  if (busy) return;
  selectedSourceId = source.id;
  editor.value = defaultQuery(source.sqlName);
  renderSources();
  renderSchema();
  setBusy(false);
  editor.focus();
  await loadSourceMetadata(source);
}

async function addNativeSources(paths: string[]): Promise<void> {
  if (!engineReady || paths.length === 0) return;
  setBusy(true, `正在枚举 ${paths.length} 个数据文件`);
  let added = 0;
  for (const [index, path] of paths.entries()) {
    try {
      const info = await getLocalFileInfo(path);
      const format = detectFormat(info.name);
      if (!format) {
        showToast(`${info.name}：不支持该文件格式`, "error");
        continue;
      }
      const alias = sourceAlias(info.name, ["main", "temp"]);
      setStatus(`正在枚举 ${index + 1}/${paths.length}：${info.name}`);
      const objects = await listNativeObjects({ path: info.path, alias, format });
      const databaseId = format === "duckdb" ? crypto.randomUUID() : undefined;
      const databaseSources = objects.map((object) => ({
        id: crypto.randomUUID(),
        name: `${info.name} / ${object.schema}.${object.name}`,
        path: info.path,
        alias: format === "duckdb" ? `${alias}.${object.schema}.${object.name}` : alias,
        sqlName: object.sqlName,
        virtualName: "",
        format,
        size: info.size,
        rowCount: 0,
        columns: [],
        metadataLoaded: false,
        native: true,
        databaseId,
        databaseAlias: object.databaseAlias,
        schema: object.schema,
        objectName: object.name,
        objectKind: object.kind,
      } satisfies DataSource));
      sources.push(...databaseSources);
      selectedSourceId = databaseSources[0]?.id ?? selectedSourceId;
      added += databaseSources.length;
    } catch (error) {
      showToast(`${path}：${error instanceof Error ? error.message : "打开失败"}`, "error");
    }
  }
  if (added > 0) {
    const source = selectedSource();
    if (source) editor.value = defaultQuery(source.sqlName);
    showToast(`已枚举 ${added} 个数据源对象`);
  }
  renderSources();
  setBusy(false, added > 0 ? `已加载 ${sources.length} 个数据源对象` : "未加载数据源");
  editor.focus();
}

async function addSources(pendingSources: PendingSource[]): Promise<void> {
  if (!engineReady || pendingSources.length === 0) return;
  setBusy(true, `正在打开 ${pendingSources.length} 个文件`);
  let added = 0;
  for (const [index, pending] of pendingSources.entries()) {
    const format = detectFormat(pending.name);
    if (!format) {
      showToast(`${pending.name}：不支持该文件格式`, "error");
      continue;
    }
    const id = crypto.randomUUID();
    const extension = format === "parquet" ? "parquet" : format;
    const virtualName = `source_${id.replace(/-/g, "")}.${extension}`;
    setStatus(`正在解析 ${index + 1}/${pendingSources.length}：${pending.name}`);
    try {
      if (!pending.data) throw new Error("浏览器文件数据不可用");
      if (format === "duckdb") {
        const databaseId = id;
        const databaseAlias = sourceAlias(pending.name, ["main", "temp"]);
        const objects = await registerDuckDBSource(virtualName, databaseAlias, pending.data);
        const databaseSources = objects.map((object) => ({
          id: crypto.randomUUID(),
          name: `${pending.name} / ${object.schema}.${object.name}`,
          path: pending.path,
          alias: `${databaseAlias}.${object.schema}.${object.name}`,
          sqlName: object.sqlName,
          virtualName,
          format,
          size: pending.size,
          rowCount: 0,
          columns: [],
          metadataLoaded: false,
          databaseId,
          databaseAlias,
          schema: object.schema,
          objectName: object.name,
          objectKind: object.kind,
        } satisfies DataSource));
        sources.push(...databaseSources);
        selectedSourceId = databaseSources[0]?.id ?? null;
        added += databaseSources.length;
      } else {
        const alias = sourceAlias(pending.name);
        const source: DataSource = {
          id,
          name: pending.name,
          path: pending.path,
          alias,
          sqlName: quoteAlias(alias),
          virtualName,
          format,
          size: pending.size,
          rowCount: 0,
          columns: [],
          metadataLoaded: true,
        };
        const metadata = await registerSource(source, pending.data);
        source.columns = metadata.columns;
        source.rowCount = metadata.rowCount;
        sources.push(source);
        selectedSourceId = source.id;
        added += 1;
      }
    } catch (error) {
      showToast(`${pending.name}：${error instanceof Error ? error.message : "打开失败"}`, "error");
    }
  }
  if (added > 0) {
    const source = selectedSource();
    if (source) editor.value = defaultQuery(source.sqlName);
    showToast(`已打开 ${added} 个数据文件`);
  }
  renderSources();
  setBusy(false, added > 0 ? `已加载 ${sources.length} 个数据源` : "未加载数据源");
  editor.focus();
}

async function openSources(): Promise<void> {
  if (busy || !engineReady) return;
  if (!isTauriRuntime()) {
    fileInput.click();
    return;
  }
  try {
    const paths = await chooseSourcePaths();
    if (paths.length === 0) return;
    await addNativeSources(paths);
  } catch (error) {
    setBusy(false, "打开文件失败");
    showToast(error instanceof Error ? error.message : "打开文件失败", "error");
  }
}

async function removeSource(source: DataSource): Promise<void> {
  if (busy) return;
  setBusy(true, `正在移除 ${source.alias}`);
  try {
    const removedSelected = source.databaseId
      ? sources.some((item) => item.databaseId === source.databaseId && item.id === selectedSourceId)
      : selectedSourceId === source.id;
    if (!source.native) await unregisterSource(source);
    const removedIds = new Set(
      source.databaseId
        ? sources.filter((item) => item.databaseId === source.databaseId).map((item) => item.id)
        : [source.id],
    );
    sources = sources.filter((item) => !removedIds.has(item.id));
    if (removedSelected) {
      selectedSourceId = sources.at(-1)?.id ?? null;
      const next = selectedSource();
      if (next) editor.value = defaultQuery(next.sqlName);
    }
    renderSources();
    setBusy(false, `已移除 ${source.alias}`);
  } catch (error) {
    setBusy(false, "移除失败");
    showToast(error instanceof Error ? error.message : "移除失败", "error");
  }
}

function nativeQuerySources(): NativeSourceSpec[] {
  const unique = new Map<string, NativeSourceSpec>();
  for (const source of sources) {
    if (!source.native) continue;
    const spec = nativeSourceSpec(source);
    unique.set(`${spec.path}\0${spec.alias}\0${spec.format}`, spec);
  }
  return Array.from(unique.values());
}

async function runQuery(): Promise<void> {
  const sql = editor.value.trim();
  if (!sql || busy || !engineReady) return;
  queryRunning = true;
  setBusy(true, "正在执行查询");
  cancelRequested = false;
  try {
    currentResult = isTauriRuntime() ? await executeNativeSql(sql, nativeQuerySources()) : await executeSql(sql);
    saveHistory(sql);
    renderResult();
    queryRunning = false;
    setBusy(false, `查询完成：${formatNumber(currentResult.rowCount)} 行`);
  } catch (error) {
    currentResult = null;
    renderResult();
    const canceled = cancelRequested;
    cancelRequested = false;
    queryRunning = false;
    setBusy(false, canceled ? "查询已取消" : "查询失败");
    if (!canceled) showToast(error instanceof Error ? error.message : "查询失败", "error");
  }
}

async function exportResult(): Promise<void> {
  if (!currentResult || busy) return;
  setBusy(true, "正在生成 XLSX");
  try {
    const workbook = await buildWorkbook(currentResult);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const saved = await saveWorkbook(workbook, `query-result-${timestamp}.xlsx`);
    setBusy(false, saved ? "XLSX 已导出" : "已取消导出");
    if (saved) showToast("XLSX 导出完成");
  } catch (error) {
    setBusy(false, "XLSX 导出失败");
    showToast(error instanceof Error ? error.message : "XLSX 导出失败", "error");
  }
}

function browserFiles(files: FileList | File[]): Promise<PendingSource[]> {
  return Promise.all(
    Array.from(files).map(async (file) => ({
      name: file.name,
      path: null,
      size: file.size,
      data: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

query<HTMLButtonElement>("#add-source").addEventListener("click", () => void openSources());
runButton.addEventListener("click", () => void runQuery());
exportButton.addEventListener("click", () => void exportResult());
cancelButton.addEventListener("click", async () => {
  if (!queryRunning || !isTauriRuntime()) return;
  cancelRequested = true;
  await cancelNativeSql();
});
sourceSearch.addEventListener("input", renderSources);
editor.addEventListener("input", () => setBusy(busy));
editor.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void runQuery();
  }
  if (event.key === "Tab") {
    event.preventDefault();
    editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
  }
});
historySelect.addEventListener("change", () => {
  const index = Number(historySelect.value);
  if (Number.isInteger(index) && queryHistory[index]) {
    editor.value = queryHistory[index];
    editor.focus();
    setBusy(busy);
  }
  historySelect.value = "";
});
fileInput.addEventListener("change", async () => {
  if (fileInput.files?.length) await addSources(await browserFiles(fileInput.files));
  fileInput.value = "";
});
toast.querySelector("button")!.addEventListener("click", () => {
  toast.hidden = true;
});

async function initializeDropHandling(): Promise<void> {
  if (isTauriRuntime()) {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "enter" || event.payload.type === "over") {
        dropOverlay.hidden = false;
      } else if (event.payload.type === "drop") {
        dropOverlay.hidden = true;
        void addNativeSources(event.payload.paths);
      } else {
        dropOverlay.hidden = true;
      }
    });
    return;
  }

  window.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    dropOverlay.hidden = false;
  });
  window.addEventListener("dragleave", (event) => {
    if (event.relatedTarget === null) dropOverlay.hidden = true;
  });
  window.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropOverlay.hidden = true;
    if (event.dataTransfer?.files.length) {
      await addSources(await browserFiles(event.dataTransfer.files));
    }
  });
}

async function start(): Promise<void> {
  renderHistory();
  renderSources();
  setBusy(false, "正在初始化 DuckDB");
  try {
    if (!isTauriRuntime()) await initializeEngine();
    await initializeDropHandling();
    engineReady = true;
    engineState.classList.add("ready");
    engineState.innerHTML = `<i data-lucide="circle-check"></i><span>${isTauriRuntime() ? "原生 DuckDB 就绪" : "DuckDB-WASM 就绪"}</span>`;
    createIcons({ icons: iconSet });
    setBusy(false, "DuckDB 已就绪");
    editor.focus();
  } catch (error) {
    engineState.classList.add("failed");
    engineState.innerHTML = `<i data-lucide="circle-alert"></i><span>DuckDB 初始化失败</span>`;
    createIcons({ icons: iconSet });
    setStatus("DuckDB 初始化失败");
    showToast(error instanceof Error ? error.message : "DuckDB 初始化失败", "error");
  }
}

void start();

import type { CellValue, QueryResult } from "./types";

function excelValue(value: CellValue): string | number | boolean | null {
  if (value === null) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return value.length > 32_767 ? `${value.slice(0, 32_760)}...` : value;
}

export async function buildWorkbook(result: QueryResult): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const workbook = new Workbook();
  workbook.creator = "SQL Viewer";
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Query Result", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  worksheet.addRow(result.columns);
  for (const row of result.rows) worksheet.addRow(row.map(excelValue));

  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF27313A" } };
  header.alignment = { vertical: "middle" };
  header.height = 22;
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, result.rowCount + 1), column: Math.max(1, result.columns.length) },
  };

  worksheet.columns.forEach((column, columnIndex) => {
    let width = result.columns[columnIndex]?.length ?? 10;
    const sampleLength = Math.min(result.rows.length, 200);
    for (let rowIndex = 0; rowIndex < sampleLength; rowIndex += 1) {
      width = Math.max(width, String(result.rows[rowIndex]?.[columnIndex] ?? "").length);
    }
    column.width = Math.min(48, Math.max(10, width + 2));
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

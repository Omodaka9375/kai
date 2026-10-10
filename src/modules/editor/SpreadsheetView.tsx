/**
 * Read-only spreadsheet preview — xlsx/xlsm/xlsb/xls/ods.
 *
 * Renders the parsed cell grid (fs_parse_spreadsheet, calamine) as a
 * sticky-header HTML table. Multi-sheet workbooks get a tab strip.
 * No formulas, no editing — this is a viewer for orientation; heavy work
 * belongs in the AI tools (which read the same parsed data as text).
 */

import { native, type SpreadsheetData } from "@/modules/ai/lib/native";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

const SHEET_CELL_CAP = 500; // rows rendered per sheet before truncation notice

function colLabel(i: number): string {
  // 0 → A, 25 → Z, 26 → AA — Excel column letters.
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}

export function SpreadsheetView({ path }: { path: string }) {
  const [data, setData] = useState<SpreadsheetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setActive(0);
    native
      .parseSpreadsheet(path)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setActive(Math.min(d.activeSheet, Math.max(0, d.sheets.length - 1)));
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (error) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-xs text-destructive">
        {error}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Loading spreadsheet…
      </div>
    );
  }
  if (data.sheets.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        No sheets found.
      </div>
    );
  }

  const safeActive = Math.min(active, data.sheets.length - 1);
  const sheet = data.sheets[safeActive];
  const truncated = sheet.rows.length > SHEET_CELL_CAP;
  const rows = truncated ? sheet.rows.slice(0, SHEET_CELL_CAP) : sheet.rows;
  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {data.sheets.length > 1 && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-1.5">
          {data.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActive(i)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] whitespace-nowrap transition-colors",
                i === safeActive
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="border-collapse text-[12px]">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r border-border/60 bg-muted px-2 py-1 text-right font-normal text-muted-foreground">
                #
              </th>
              {Array.from({ length: width }, (_, c) => (
                <th
                  key={c}
                  className="min-w-16 border-b border-border/60 bg-muted px-2 py-1 text-left font-normal text-muted-foreground"
                >
                  {colLabel(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="hover:bg-accent/30">
                <td className="sticky left-0 z-10 border-r border-border/60 bg-muted px-2 py-0.5 text-right text-[10px] text-muted-foreground tabular-nums">
                  {r + 1}
                </td>
                {Array.from({ length: width }, (_, c) => {
                  const v = row[c] ?? "";
                  const numeric = v !== "" && !Number.isNaN(Number(v));
                  return (
                    <td
                      key={c}
                      className={cn(
                        "max-w-[24rem] truncate border-b border-border/40 px-2 py-0.5",
                        numeric && "text-right tabular-nums",
                      )}
                      title={v}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          <div className="px-2 py-1.5 text-[11px] text-muted-foreground">
            Showing first {SHEET_CELL_CAP} of {sheet.rows.length} rows. Ask the
            agent to read the rest.
          </div>
        )}
      </div>
    </div>
  );
}

// Crew banners: 8 rows of 16 hex digits, each a palette index (0 is blank).
export function paintAt(rows: string[], row: number, col: number, color: number): string[] {
  return rows.map((r, i) => (i === row ? r.slice(0, col) + color.toString(16) + r.slice(col + 1) : r));
}

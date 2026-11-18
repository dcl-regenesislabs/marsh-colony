// Pure text rules for the physical XP scoreboard (no engine imports, so they
// can be unit tested). The scoreboard shows the top 10: #1-5 on the left
// panel, #6-10 on the right.

export const SCOREBOARD_ROWS = 5 // rows per panel
export const SCOREBOARD_PANELS = 2
export const SCOREBOARD_TOP = SCOREBOARD_ROWS * SCOREBOARD_PANELS

// Names are cut so they never reach the XP column. Mobile renders wider.
const NAME_MAX_MOBILE = 6
const NAME_MAX_DESKTOP = 7

export function scoreboardName(name: string, mobile: boolean): string {
  return name.trim().slice(0, mobile ? NAME_MAX_MOBILE : NAME_MAX_DESKTOP)
}

/** XP as at most 5 characters, so the column width is fixed: 14944 stays
 *  14944, 123456 becomes 123K, 1250000 becomes 1.2M. */
export function scoreboardXp(xp: number): string {
  const n = Math.max(0, Math.floor(Number.isFinite(xp) ? xp : 0))
  if (n < 100_000) return String(n)
  if (n < 1_000_000) return `${Math.floor(n / 1000)}K`
  if (n >= 1_000_000_000) return `${Math.min(999, Math.floor(n / 1_000_000_000))}B`
  const m = Math.floor(n / 100_000) / 10 // one decimal, rounded down
  return m < 100 ? `${m}M` : `${Math.floor(m)}M`
}

/** The entries one panel shows: panel 0 = ranks 1-5, panel 1 = ranks 6-10. */
export function scoreboardPage<T>(entries: T[], panel: number): T[] {
  const from = panel * SCOREBOARD_ROWS
  return entries.slice(from, from + SCOREBOARD_ROWS)
}

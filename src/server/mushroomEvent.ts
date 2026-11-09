// Each date-time in MUSHROOM_EVENT_SCHEDULE opens one event (command in README).
// START_MUSHROOM_EVENT=true is the manual fallback: it opens one hour right away.
// EnvVar.get returns '' for a failed read as well as a missing key, so an empty
// value keeps the last state; "off" / "false" are the explicit ways to clear.

import { EnvVar, Storage } from '@dcl/sdk/server'
import type { MushroomEventSchedule } from '../shared/happyHour'

const ENV_KEY = 'MUSHROOM_EVENT_SCHEDULE'
const MANUAL_ENV_KEY = 'START_MUSHROOM_EVENT'
// Same record the old flag-only version wrote, so a manual hour in progress
// survives this deploy and server restarts don't re-arm it.
const MANUAL_KEY = 'mushroomEvent'
type ManualState = { enabled: boolean; startedAt: number }
const POLL_MS = 5000
const ENTRY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/

function parseSchedule(raw: string): { starts: number[]; invalid: string[] } {
  const starts: number[] = []
  const invalid: string[] = []
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    const match = ENTRY.exec(entry.toUpperCase())
    const time = match ? Date.parse(`${match[1]}${match[2] ?? ':00'}${match[3] ?? 'Z'}`) : NaN
    if (Number.isFinite(time)) starts.push(time)
    else invalid.push(entry)
  }
  return { starts: starts.sort((a, b) => a - b), invalid }
}

export function createMushroomEventController(deps: {
  schedule: () => Promise<string>
  manualFlag: () => Promise<string>
  readManual: () => Promise<ManualState | null>
  writeManual: (value: ManualState) => Promise<boolean>
  now: () => number
}) {
  let scheduled: number[] | null = null
  let manual: ManualState | null = null
  let manualLoaded = false
  let lastRaw = ''

  // Storage is read once per process and written only when the flag flips,
  // not on every poll.
  async function refreshManual(): Promise<void> {
    const flag = (await deps.manualFlag()).trim().toLowerCase()
    if (!manualLoaded) {
      manual = await deps.readManual()
      manualLoaded = true
    }
    if (flag !== 'true' && flag !== 'false') return
    const enabled = flag === 'true'
    if (manual && manual.enabled === enabled && Number.isFinite(manual.startedAt)) return
    const next = { enabled, startedAt: enabled ? deps.now() : 0 }
    if (!await deps.writeManual(next)) throw new Error('Could not persist manual mushroom event')
    manual = next
    if (enabled) console.log('[Server] Mushroom event started manually', new Date(next.startedAt).toISOString())
    else console.log('[Server] Manual mushroom event disabled; ready for next true')
  }

  async function refreshSchedule(): Promise<void> {
    const raw = (await deps.schedule()).trim()
    if (!raw || raw === lastRaw) return
    lastRaw = raw
    if (raw.toLowerCase() === 'off') {
      scheduled = []
      console.log('[Server] Mushroom event schedule cleared')
      return
    }
    const { starts, invalid } = parseSchedule(raw)
    if (invalid.length) console.log('[Server] Mushroom event schedule: ignored', invalid.join(', '))
    if (!starts.length) return
    scheduled = starts
    // The storage CLI is write-only, so this log is the only confirmation.
    console.log('[Server] Mushroom event schedule (UTC):', starts.map(t => new Date(t).toISOString()).join(', '))
  }

  let pending: Promise<void> | null = null
  let nextPoll = 0
  return {
    /** Every start, scheduled or manual. happyHourWindow picks the live one. */
    state: (): MushroomEventSchedule | null => {
      const manualStart = manual?.enabled && manual.startedAt > 0 ? [manual.startedAt] : []
      if (!scheduled && !manualStart.length) return null
      return [...(scheduled ?? []), ...manualStart].sort((a, b) => a - b)
    },
    refresh(): Promise<void> {
      if (pending) return pending
      if (deps.now() < nextPoll) return Promise.resolve()
      pending = (async () => {
        // One source failing must not block the other.
        try {
          await refreshSchedule()
        } catch (error) {
          console.log('[Server] Mushroom event schedule refresh failed', error)
        }
        try {
          await refreshManual()
        } catch (error) {
          // Never invent a start time on a failed read/write; keep the last known hour.
          console.log('[Server] Manual mushroom event refresh failed', error)
        } finally {
          nextPoll = deps.now() + POLL_MS
          pending = null
        }
      })()
      return pending
    }
  }
}

export const mushroomEvent = createMushroomEventController({
  schedule: () => EnvVar.get(ENV_KEY),
  manualFlag: () => EnvVar.get(MANUAL_ENV_KEY),
  readManual: () => Storage.get<ManualState>(MANUAL_KEY, { fresh: true }),
  writeManual: (value) => Storage.set(MANUAL_KEY, value),
  now: () => Date.now()
})

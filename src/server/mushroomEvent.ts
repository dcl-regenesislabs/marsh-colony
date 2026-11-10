// Each date-time in MUSHROOM_EVENT_SCHEDULE opens one event (runbook in README).
// START_MUSHROOM_EVENT=true is the manual fallback: it opens one hour right away.
// EnvVar.get returns '' for a failed read as well as a missing key, so an empty
// value keeps the last state; "off" / "false" are the explicit ways to clear.

import { EnvVar, Storage } from '@dcl/sdk/server'
import { HAPPY_HOUR, happyHourWindow, type MushroomEventSchedule } from '../shared/happyHour'

const ENV_KEY = 'MUSHROOM_EVENT_SCHEDULE'
const MANUAL_ENV_KEY = 'START_MUSHROOM_EVENT'
// Same record the old flag-only version wrote, so a manual hour in progress
// survives this deploy and server restarts don't re-arm it.
const MANUAL_KEY = 'mushroomEvent'
type ManualState = { enabled: boolean; startedAt: number }
const POLL_MS = 5000
// The fallback is rarely used, so its env read runs less often (each read is a
// signed request, and the runtime caps concurrent requests).
const MANUAL_POLL_MS = 30000
const HOUR_MS = HAPPY_HOUR.durationMinutes * 60000
// Starts older than this can't affect the current hour; dropping them keeps the
// list small for happyHourWindow, which runs on every snapshot.
const KEEP_PAST_MS = 24 * 60 * 60000
const MAX_ENTRIES = 50
const ENTRY = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?(Z|[+-]\d{2}:\d{2})?$/
const iso = (t: number): string => new Date(t).toISOString()

function parseSchedule(raw: string): { starts: number[]; invalid: string[]; overlapping: string[] } {
  const parsed: number[] = []
  const invalid: string[] = []
  for (const entry of raw.split(/[,\s]+/).filter(Boolean)) {
    const match = ENTRY.exec(entry.toUpperCase())
    const time = match ? Date.parse(`${match[1]}${match[2] ?? ':00'}${match[3] ?? 'Z'}`) : NaN
    if (Number.isFinite(time)) parsed.push(time)
    else invalid.push(entry)
  }
  // An entry less than an hour after the previous one would restart the event
  // (and every pick cooldown). Usually the same hour written twice, e.g. in two
  // time zones, so it is dropped and reported.
  const starts: number[] = []
  const overlapping: string[] = []
  for (const time of parsed.sort((a, b) => a - b)) {
    const previous = starts[starts.length - 1]
    if (previous !== undefined && time < previous + HOUR_MS) overlapping.push(`${iso(time)} (inside the ${iso(previous)} hour)`)
    else starts.push(time)
  }
  return { starts, invalid, overlapping }
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
  let nextManualPoll = 0

  function starts(): MushroomEventSchedule | null {
    const manualStart = manual?.enabled && manual.startedAt > 0 ? [manual.startedAt] : []
    if (!scheduled && !manualStart.length) return null
    return [...(scheduled ?? []), ...manualStart].sort((a, b) => a - b)
  }

  // Storage is read once per process and written only when the flag flips,
  // not on every poll.
  async function refreshManual(): Promise<void> {
    if (deps.now() < nextManualPoll) return
    nextManualPoll = deps.now() + MANUAL_POLL_MS
    const flag = (await deps.manualFlag()).trim().toLowerCase()
    if (!manualLoaded) {
      manual = await deps.readManual()
      manualLoaded = true
    }
    if (flag !== 'true' && flag !== 'false') return
    const enabled = flag === 'true'
    if (manual && manual.enabled === enabled && Number.isFinite(manual.startedAt)) return
    // Flipping to true while an event is running joins that hour instead of
    // restarting it, so nobody gets their mushrooms back.
    const running = enabled ? happyHourWindow(deps.now(), starts()) : null
    const next = { enabled, startedAt: enabled ? running?.wave ?? deps.now() : 0 }
    if (!await deps.writeManual(next)) throw new Error('Could not persist manual mushroom event')
    manual = next
    if (running) console.log('[Server] Mushroom event already running since', iso(running.wave), '- manual start keeps that hour')
    else if (enabled) console.log('[Server] Mushroom event started manually', iso(next.startedAt))
    else console.log('[Server] Manual mushroom event disabled; ready for next true')
  }

  async function refreshSchedule(): Promise<void> {
    const raw = (await deps.schedule()).trim()
    if (raw && raw !== lastRaw) {
      lastRaw = raw
      const tokens = raw.split(/[,\s]+/).filter(Boolean)
      // "off" anywhere in the value cancels, so "off," or "off off" can't
      // silently leave the schedule running.
      if (tokens.some((token) => token.toLowerCase() === 'off')) {
        scheduled = []
        console.log('[Server] Mushroom event schedule cleared (an event started manually keeps running until START_MUSHROOM_EVENT is false)')
      } else {
        const { starts, invalid, overlapping } = parseSchedule(raw)
        if (invalid.length) console.log('[Server] Mushroom event schedule: ignored', invalid.join(', '))
        if (overlapping.length) console.log('[Server] Mushroom event schedule: ignored overlapping', overlapping.join(', '))
        if (!starts.length) {
          // The storage CLI is write-only, so the log is the only feedback.
          const kept = scheduled?.length ? scheduled.map(iso).join(', ') : 'none'
          console.log('[Server] Mushroom event schedule unchanged; no valid entries. Still scheduled (UTC):', kept)
        } else {
          if (starts.length > MAX_ENTRIES) {
            console.log(`[Server] Mushroom event schedule: only the first ${MAX_ENTRIES} entries are used`)
          }
          scheduled = starts.slice(0, MAX_ENTRIES)
          console.log('[Server] Mushroom event schedule (UTC):', scheduled.map(iso).join(', '))
        }
      }
    }
    if (scheduled) scheduled = scheduled.filter((start) => start + KEEP_PAST_MS > deps.now())
  }

  let pending: Promise<void> | null = null
  let nextPoll = 0
  return {
    /** Every start, scheduled or manual. happyHourWindow picks the live one. */
    state: starts,
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

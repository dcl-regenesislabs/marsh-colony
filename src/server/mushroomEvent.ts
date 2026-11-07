// Each date-time in MUSHROOM_EVENT_SCHEDULE opens one event (command in README).
// EnvVar.get returns '' for a failed read as well as a missing key, so an empty
// value keeps the last schedule; "off" is the explicit way to clear it.

import { EnvVar } from '@dcl/sdk/server'
import type { MushroomEventSchedule } from '../shared/happyHour'

const ENV_KEY = 'MUSHROOM_EVENT_SCHEDULE'
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
  now: () => number
}) {
  let state: MushroomEventSchedule | null = null
  let lastRaw = ''
  let pending: Promise<void> | null = null
  let nextPoll = 0
  return {
    state: () => state,
    refresh(): Promise<void> {
      if (pending) return pending
      if (deps.now() < nextPoll) return Promise.resolve()
      pending = (async () => {
        try {
          const raw = (await deps.schedule()).trim()
          if (!raw || raw === lastRaw) return
          lastRaw = raw
          if (raw.toLowerCase() === 'off') {
            state = []
            console.log('[Server] Mushroom event schedule cleared')
            return
          }
          const { starts, invalid } = parseSchedule(raw)
          if (invalid.length) console.log('[Server] Mushroom event schedule: ignored', invalid.join(', '))
          if (!starts.length) return
          state = starts
          // The storage CLI is write-only, so this log is the only confirmation.
          console.log('[Server] Mushroom event schedule (UTC):', starts.map(t => new Date(t).toISOString()).join(', '))
        } catch (error) {
          console.log('[Server] Mushroom event schedule refresh failed', error)
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
  now: () => Date.now()
})

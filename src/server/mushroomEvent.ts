import { EnvVar, Storage } from '@dcl/sdk/server'
import type { MushroomEventState } from '../shared/happyHour'

const KEY = 'mushroomEvent'
const POLL_MS = 5000

/** Read live environment changes; persist the shared clock before exposing it. */
export function createMushroomEventController(deps: {
  flag: () => Promise<string>
  read: () => Promise<MushroomEventState | null>
  write: (value: MushroomEventState) => Promise<boolean>
  now: () => number
}) {
  let state: MushroomEventState | null = null
  let pending: Promise<void> | null = null
  let nextPoll = 0
  return {
    state: () => state,
    refresh(): Promise<void> {
      if (pending) return pending
      if (deps.now() < nextPoll) return Promise.resolve()
      pending = (async () => {
        try {
          const flag = (await deps.flag()).trim().toLowerCase()
          const stored = await deps.read()
          // EnvVar.get returns an empty string on HTTP errors as well as a
          // missing key. It must not cancel/rearm an existing activation.
          if (flag !== 'true' && flag !== 'false') { state = stored; return }
          const enabled = flag === 'true'
          if (stored && stored.enabled === enabled && Number.isFinite(stored.startedAt)) {
            state = stored
          } else {
            const next = { enabled, startedAt: enabled ? deps.now() : 0 }
            if (!await deps.write(next)) throw new Error('Could not persist mushroom event clock')
            state = next
            if (enabled) console.log('[Server] Mushroom event started', next.startedAt)
            else console.log('[Server] Mushroom event disabled; ready for next true')
          }
        } catch (error) {
          // Never invent a start time on a failed read/write; keep the last known hour.
          console.log('[Server] Mushroom event refresh failed', error)
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
  flag: () => EnvVar.get('START_MUSHROOM_EVENT'),
  read: () => Storage.get<MushroomEventState>(KEY, { fresh: true }),
  write: (value) => Storage.set(KEY, value),
  now: () => Date.now()
})

// Resolves the analytics master switch from the ANALYTICS_ENABLED env var at
// RUNTIME, so it can be flipped without a redeploy (or even a restart):
//
//   npx sdk-commands storage env set ANALYTICS_ENABLED --value true    # (or false)
//
// EnvVar.get reads the server-side Storage service live on every call, so we
// re-read on a short TTL and the change is picked up within REFRESH_MS.
// Server-only: EnvVar throws off-server, so this module is never imported client-side.
//
// IMPORTANT — EnvVar.get does NOT reject on a failed read: the SDK logs and
// returns '' (same as a genuinely unset var). We can't tell "unset" from
// "transient failure" apart, so an EMPTY result KEEPS the current value instead
// of resetting to the config default — otherwise a blip would silently flip
// analytics off for a whole TTL. The config default only seeds the value before
// the first successful read. To disable analytics, set ANALYTICS_ENABLED to
// "false" explicitly — do NOT delete the var (a delete reads as empty = keep).

import { EnvVar } from '@dcl/sdk/server'
import * as C from '../shared/config'
import { setAnalyticsEnabled } from '../shared/analytics'

const ENV_KEY = 'ANALYTICS_ENABLED'
const REFRESH_MS = 60_000

let enabled = C.ANALYTICS_ENABLED
let lastFetch = 0
let inFlight = false
let loggedOnce = false // so the first resolved value is always logged (env is write-only — no `env get`)

// Resolves on the FIRST completed env read, so callers can await a real value
// before emitting the event new-user/retention metrics are built on (otherwise
// the first player — the one who boots the server — races the boot read and the
// fallback `false` drops their `session started`).
let markReady: () => void = () => {}
const ready: Promise<void> = new Promise((resolve) => {
  markReady = resolve
})
/** Await the first env resolution (already-resolved after that, so it's instant). */
export function analyticsReady(): Promise<void> {
  return ready
}

/** Parse the env value. Returns null for unset/blank (caller then keeps the
 *  current value — see the file header). */
function parse(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}

/** Re-read the env var if the cache is stale (older than REFRESH_MS). Fire-and-
 *  forget: it never blocks, and an empty/failed read keeps the last known value.
 *  Safe to call on a hot path — the TTL + in-flight guards make it cheap. */
export function refreshAnalyticsEnabled(): void {
  const now = Date.now()
  if (inFlight || now - lastFetch < REFRESH_MS) return
  inFlight = true
  void EnvVar.get(ENV_KEY)
    .then((raw) => {
      // Empty (unset OR failed read) -> keep the current value, never reset.
      const parsed = parse(raw)
      const next = parsed === null ? enabled : parsed
      // Log the first resolution and every later change — the only way to confirm
      // the env value, since the storage CLI is write-only (no `env get`/`env list`).
      if (!loggedOnce || next !== enabled) {
        console.log(`[analytics] enabled=${next} (env ANALYTICS_ENABLED="${raw}", was ${enabled})`)
        loggedOnce = true
      }
      enabled = next
      setAnalyticsEnabled(enabled)
    })
    .catch((e) => {
      console.log('[analytics] env read failed, keeping', enabled, e)
    })
    .finally(() => {
      // Stamp the TTL from completion (not before the call), so a slow read
      // doesn't shorten the next window; then mark the first resolution done.
      lastFetch = Date.now()
      inFlight = false
      markReady()
    })
}

/** The last resolved value — stamped into each client snapshot so the client
 *  gates its own events on the same switch (it can't read the env var itself). */
export function analyticsEnabledNow(): boolean {
  return enabled
}

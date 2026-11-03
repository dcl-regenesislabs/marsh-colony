// Resolves the analytics master switch from the ANALYTICS_ENABLED env var at
// RUNTIME, so it can be flipped without a redeploy (or even a restart):
//
//   npx sdk-commands storage env set ANALYTICS_ENABLED --value true    # (or false)
//
// EnvVar.get reads the server-side Storage service live on every call, so we
// re-read on a short TTL and the change is picked up within REFRESH_MS. An
// unset/blank value falls back to the config default (C.ANALYTICS_ENABLED).
// Server-only: EnvVar throws off-server, so this module is never imported client-side.

import { EnvVar } from '@dcl/sdk/server'
import * as C from '../shared/config'
import { setAnalyticsEnabled } from '../shared/analytics'

const ENV_KEY = 'ANALYTICS_ENABLED'
const REFRESH_MS = 60_000

let enabled = C.ANALYTICS_ENABLED
let lastFetch = 0
let inFlight = false
let loggedOnce = false // so the first resolved value is always logged (env is write-only — no `env get`)

/** Parse the env value. Returns null for unset/blank so the caller can fall
 *  back to the config default rather than reading "" as false. */
function parse(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  return v === 'true' || v === '1' || v === 'on' || v === 'yes'
}

/** Re-read the env var if the cache is stale (older than REFRESH_MS). Fire-and-
 *  forget: it never blocks, and on error it keeps the last known value. Safe to
 *  call on a hot path — the TTL + in-flight guards make it cheap. */
export function refreshAnalyticsEnabled(): void {
  const now = Date.now()
  if (inFlight || now - lastFetch < REFRESH_MS) return
  inFlight = true
  lastFetch = now
  void EnvVar.get(ENV_KEY)
    .then((raw) => {
      const next = parse(raw) ?? C.ANALYTICS_ENABLED
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
      inFlight = false
    })
}

/** The last resolved value — stamped into each client snapshot so the client
 *  gates its own events on the same switch (it can't read the env var itself). */
export function analyticsEnabledNow(): boolean {
  return enabled
}

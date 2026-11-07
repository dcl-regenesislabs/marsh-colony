// Resolves whether the first-session TUTORIAL is enabled, from the TUTORIAL_ENABLED
// env var at RUNTIME (same storage toggle as ANALYTICS_ENABLED). Lets a test world
// skip the ~15-min guided onboarding so players drop straight into the normal game:
//
//   npx sdk-commands storage env set TUTORIAL_ENABLED --value false   # disable
//
// Server-only (EnvVar throws off-server). DEFAULT IS ON: an empty/unset value keeps
// the current value, which starts at `true` — so PRODUCTION never needs to set
// anything, and a transient read failure can't silently turn the tutorial off. Only
// an explicit "false"/"0"/"off"/"no" disables it; set it back to "true" (or delete
// the var and restart) to re-enable. Read once per new player in state.ts newPlayer().

import { EnvVar } from '@dcl/sdk/server'

const ENV_KEY = 'TUTORIAL_ENABLED'
const REFRESH_MS = 60_000

let enabled = true // default ON (prod-safe)
let lastFetch = 0
let inFlight = false
let loggedOnce = false // so the first resolved value is always logged (env is write-only)

/** Parse the env value. Returns null for unset/blank (caller keeps the current
 *  value). Default-on, so only explicit falsy words disable; anything else enables. */
function parse(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === '') return null
  return !(v === 'false' || v === '0' || v === 'off' || v === 'no')
}

/** Re-read the env var if the cache is stale (older than REFRESH_MS). Fire-and-
 *  forget: it never blocks, and an empty/failed read keeps the last known value. */
export function refreshTutorialEnabled(): void {
  const now = Date.now()
  if (inFlight || now - lastFetch < REFRESH_MS) return
  inFlight = true
  void EnvVar.get(ENV_KEY)
    .then((raw) => {
      const parsed = parse(raw)
      const next = parsed === null ? enabled : parsed
      if (!loggedOnce || next !== enabled) {
        console.log(`[tutorial] enabled=${next} (env TUTORIAL_ENABLED="${raw}", was ${enabled})`)
        loggedOnce = true
      }
      enabled = next
    })
    .catch((e) => {
      console.log('[tutorial] env read failed, keeping', enabled, e)
    })
    .finally(() => {
      lastFetch = Date.now()
      inFlight = false
    })
}

/** The last resolved value — read when a brand-new player is created. */
export function tutorialEnabledNow(): boolean {
  return enabled
}

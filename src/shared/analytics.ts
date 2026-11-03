// Single analytics choke point. NOTHING else in the codebase talks to PostHog
// directly — swap providers here and nowhere else. Fire-and-forget: tracking
// must never block, slow, or crash gameplay. Any failure is swallowed.
//
// Uses `signedFetch` (~system/SignedFetch) instead of the global `fetch`: the
// authoritative-server (hammurabi) runtime does NOT expose `fetch`, but it does
// expose signedFetch (it's what Storage/EnvVar use under the hood). signedFetch
// also exists client-side, so this one path works in both runtimes. PostHog
// ignores the extra DCL signature headers and just reads the JSON body.
//
// See dev-docs/posthog-analytics-integration.md.

import { signedFetch } from '~system/SignedFetch'
import * as C from './config'

// Runtime master switch, read by trackEvent() below instead of the compile-time
// C.ANALYTICS_ENABLED const — so analytics can be flipped WITHOUT a redeploy.
// It starts at the config default (the fallback) and is overridden at runtime:
//   • server-side, from the ANALYTICS_ENABLED env var (see server/analyticsConfig.ts)
//   • client-side, from the value the server sends in the state snapshot
// EnvVar is server-only, so the client can't read it directly — hence the relay.
let analyticsEnabled = C.ANALYTICS_ENABLED

/** Set the runtime master switch. Called by the server (from env) and by the
 *  client (from the snapshot the server sends). */
export function setAnalyticsEnabled(enabled: boolean): void {
  analyticsEnabled = enabled
}

/** Current runtime master switch — what the server stamps into the snapshot. */
export function analyticsEnabledNow(): boolean {
  return analyticsEnabled
}

/**
 * Emit one analytics event. `distinctId` is the player's wallet (identity that
 * ties sessions together for retention). Adding a future event is just another
 * trackEvent(...) call — no new plumbing.
 */
export function trackEvent(name: string, distinctId: string, properties: Record<string, any> = {}): void {
  if (!analyticsEnabled) return
  if (!distinctId) return // no wallet -> no usable identity, skip

  try {
    const body = JSON.stringify({
      api_key: C.POSTHOG_PROJECT_API_KEY,
      event: name,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: { game: C.GAME_ID, $lib: 'dcl-sdk7-custom', ...properties }
    })

    // Fire-and-forget: never await into gameplay. Silent on success; only logs
    // if the request is rejected or errors, so problems still leave a trace.
    void signedFetch({
      url: `https://${C.POSTHOG_HOST}/i/v0/e/`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body
      }
    })
      .then((res) => {
        // Silent on success — only a rejection leaves a trace, so this stays quiet
        // under load (15+ concurrent players send many events). Confirm delivery in
        // PostHog's Live events, not the server log.
        if (!res.ok) console.log(`[analytics] ${name} rejected -> ${res.status}`)
      })
      .catch((e) => {
        console.log(`[analytics] ${name} failed:`, e)
      })
  } catch (e) {
    // analytics must never break the game
    console.log('[analytics] threw:', e)
  }
}

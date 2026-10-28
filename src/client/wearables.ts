// Client-side wearable claim. The server owns WHO earned a wearable, but the
// actual mint happens here: it POSTs to the Rewards dispenser with the player's
// wallet as beneficiary, so it has to run in the client's runtime. The server
// asks us to claim ('claimWearable') and we report the outcome ('wearableClaimed').
//
// The dispenser is a non-captcha "super key" campaign: the campaign_key IS the
// authorization, so the request must go UNSIGNED (plain fetch). A signedFetch
// would attach the player's session metadata (realm/origin), which the Rewards
// API then validates and rejects from a preview realm ("Invalid metadata
// content") — so unsigned is what makes this work in preview, not just deployed.

import { signedFetch } from '~system/SignedFetch'
import * as C from '../shared/config'
import { actions, clientState, resolveMyAddress } from './state'

// Don't fire the same claim twice concurrently (the server may ask more than
// once across a session). Cleared on failure so a later session can retry.
const claiming = new Set<string>()

type ClaimResponse = { ok: boolean; status: number; body: string }

/** POST the claim UNSIGNED (plain fetch). The dispenser's super key is the whole
 *  authorization, so we must NOT sign: signedFetch attaches the player's session
 *  metadata (realm, origin), which the Rewards API validates and rejects when it
 *  comes from a preview realm ("Invalid metadata content"). Only if this runtime
 *  has no global fetch do we fall back to signedFetch. A returned non-2xx is used
 *  as-is (it carries the real campaign error); we fall back only when fetch throws. */
async function postClaim(url: string, body: string): Promise<ClaimResponse> {
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }
  if (typeof fetch === 'function') {
    try {
      const r = await fetch(url, init)
      return { ok: r.ok, status: r.status, body: await r.text() }
    } catch (e) {
      console.log('[Client] wearable plain fetch unavailable, signing instead', e)
    }
  }
  const r = await signedFetch({ url, init })
  return { ok: r.ok, status: r.status, body: r.body ?? '' }
}

export async function claimWearable(wearableId: string): Promise<void> {
  if (claiming.has(wearableId)) return
  const w = C.arkWearableById(wearableId)
  if (!w || !w.urn || !w.campaignId || !w.campaignKey) return // not claimable yet

  const beneficiary = resolveMyAddress()
  if (!beneficiary) return // no wallet resolved yet; the server asks again next session

  claiming.add(wearableId)
  try {
    const url = `${C.ARK_REWARDS_API}/${w.campaignId}/rewards`
    const payload = JSON.stringify({ campaign_key: w.campaignKey, beneficiary, catalyst: C.ARK_REWARDS_CATALYST })
    const res = await postClaim(url, payload)
    const body = res.body
    // 2xx with a non-empty `data` array means the campaign assigned the wearable.
    // A 4xx that says the player already has it is also "done" — report ok so the
    // server stops asking. Anything else stays pending for a future session.
    let ok = false
    if (res.ok) {
      const parsed = JSON.parse(body) as { data?: unknown[] }
      ok = Array.isArray(parsed.data) && parsed.data.length > 0
    } else if (/already|assigned|duplicate/i.test(body)) {
      ok = true
    }
    if (ok) {
      console.log(`[Client] wearable ${wearableId} claimed`)
      // Celebrate it — shownAt 0 so the overlay waits until the player closes any
      // open UI (e.g. the Ark thanks panel at tutorial end) before appearing.
      clientState.wearableReward = { wearableId, shownAt: 0 }
    } else {
      console.log(`[Client] wearable ${wearableId} claim not confirmed -> ${res.status} ${body.slice(0, 200)}`)
    }
    actions.wearableClaimed(wearableId, ok, ok ? '' : `${res.status}: ${body.slice(0, 300)}`)
  } catch (e) {
    console.log('[Client] wearable claim failed', wearableId, e)
    actions.wearableClaimed(wearableId, false, `threw: ${String(e).slice(0, 300)}`)
  } finally {
    claiming.delete(wearableId)
  }
}

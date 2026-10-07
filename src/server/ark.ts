// The Ark community goal (issue #248), server side. Owns the scene-wide record:
// the current event's counter + donors, the all-time donor ranking and the last
// few launches (so donors who were away still get their launch cinematic and
// reward). Per-player bits (launchSeen, wearable grants) live on PlayerData.
//
// Kept in memory, hydrated once from Storage, and persisted on every change —
// donations are rare, discrete events, so a write each is well within budget.

import { Storage } from '@dcl/sdk/server'
import * as C from '../shared/config'
import type { ArkLaunchView, ArkLeaderboard, ArkPlayerData, ArkStatus, PlayerData } from '../shared/types'

const ARK_KEY = 'ark-v1'
const TOTALS_MAX = 500 // cap the all-time ranking record so it can't grow unbounded

export type ArkLaunchRecord = { eventId: number; launchedAt: number; donors: Record<string, number> }
type ArkWorld = {
  eventId: number
  donated: number
  donors: Record<string, number> // this event: address -> pets donated
  totals: Record<string, { name: string; count: number }> // every event, for the ranking
  launches: ArkLaunchRecord[] // newest last, capped at ARK_LAUNCH_HISTORY
}

let world: ArkWorld | null = null

function emptyWorld(): ArkWorld {
  return { eventId: 1, donated: 0, donors: {}, totals: {}, launches: [] }
}

/** Hydrate the record once. Every handler that reads/writes it awaits this
 *  first, then works synchronously so two donations can't interleave. */
export async function ensureArkLoaded(): Promise<void> {
  if (world) return
  let stored: ArkWorld | null = null
  try {
    stored = await Storage.get<ArkWorld>(ARK_KEY)
  } catch (e) {
    console.log('[Server] ark load failed', e)
  }
  // Another handler may have finished loading while we awaited.
  if (world) return
  world = { ...emptyWorld(), ...(stored ?? {}) }
  // The first Ark build stored only `{ total }` under this key: carry that count
  // into the current event (short of the goal, so a real donation launches it).
  const legacyTotal = (stored as { total?: number } | null)?.total
  if (typeof legacyTotal === 'number' && typeof (stored as Partial<ArkWorld>).donated !== 'number') {
    world.donated = Math.max(0, Math.min(legacyTotal, C.ARK_GOAL - 1))
  }
}

async function saveArk(): Promise<void> {
  if (!world) return
  try {
    const ok = await Storage.set(ARK_KEY, world)
    if (!ok) console.log('[Server] ark save did not persist')
  } catch (e) {
    console.log('[Server] ark save failed', e)
  }
}

export function arkStatus(): ArkStatus {
  return { eventId: world?.eventId ?? 1, donated: world?.donated ?? 0, goal: C.ARK_GOAL }
}

/** Count one donated pet toward the current event. When it completes the goal,
 *  the launch is recorded and the next event starts immediately; the finished
 *  launch is returned so the caller can reward donors and play it for everyone. */
export async function recordArkDonation(address: string, name: string): Promise<ArkLaunchRecord | null> {
  await ensureArkLoaded()
  const w = world!
  const key = address.toLowerCase()
  w.donors[key] = (w.donors[key] ?? 0) + 1
  const total = w.totals[key] ?? { name, count: 0 }
  w.totals[key] = { name, count: total.count + 1 }
  w.donated += 1
  let launch: ArkLaunchRecord | null = null
  if (w.donated >= C.ARK_GOAL) {
    launch = { eventId: w.eventId, launchedAt: Date.now(), donors: w.donors }
    w.launches.push(launch)
    if (w.launches.length > C.ARK_LAUNCH_HISTORY) w.launches.splice(0, w.launches.length - C.ARK_LAUNCH_HISTORY)
    w.eventId += 1
    w.donated = 0
    w.donors = {}
  }
  trimTotals(w)
  await saveArk()
  return launch
}

function trimTotals(w: ArkWorld): void {
  const keys = Object.keys(w.totals)
  if (keys.length <= TOTALS_MAX) return
  keys.sort((a, b) => w.totals[b].count - w.totals[a].count)
  for (const k of keys.slice(TOTALS_MAX)) delete w.totals[k]
}

export function launchViewFor(launch: ArkLaunchRecord, address: string): ArkLaunchView {
  return {
    eventId: launch.eventId,
    launchedAt: launch.launchedAt,
    donatedByMe: launch.donors[address.toLowerCase()] ?? 0,
    wearableId: C.arkLaunchWearable(launch.eventId).id
  }
}

function arkData(p: PlayerData): ArkPlayerData {
  if (!p.ark) p.ark = { launchSeen: 0, grants: [] }
  return p.ark
}

/** Launches this player donated to but hasn't watched yet — replayed first
 *  thing when they come back (see the client's arkCinematics.ts). */
export function unseenArkLaunchesFor(p: PlayerData): ArkLaunchView[] {
  if (!world) return []
  const seen = arkData(p).launchSeen
  const key = p.address.toLowerCase()
  return world.launches.filter((l) => l.eventId > seen && (l.donors[key] ?? 0) > 0).map((l) => launchViewFor(l, key))
}

/** The player watched these launches; stop replaying them. `eventId` comes from
 *  the client, so it is capped at the last launch that really happened — an
 *  inflated value would otherwise mute every future launch for that player. */
export function ackArkLaunch(p: PlayerData, eventId: number): void {
  if (!world || !Number.isFinite(eventId)) return
  const lastLaunched = world.eventId - 1
  const seen = Math.min(Math.floor(eventId), lastLaunched)
  const ark = arkData(p)
  if (seen > ark.launchSeen) ark.launchSeen = seen
}

export function arkLeaderboardFor(address: string): ArkLeaderboard {
  const key = address.toLowerCase()
  const all = Object.entries(world?.totals ?? {})
    .map(([addr, t]) => ({ address: addr, name: t.name, count: t.count }))
    .sort((a, b) => b.count - a.count)
  const myIdx = all.findIndex((r) => r.address === key)
  return {
    rows: all.slice(0, C.ARK_LEADERBOARD_SIZE),
    me: myIdx === -1 ? null : { rank: myIdx + 1, count: all[myIdx].count }
  }
}

// ---------------------------------------------------------------------------
// Wearable rewards. Entitlements are recorded on the player right away; actual
// delivery goes through deliverWearable(), which is a stub until the Rewards
// campaigns exist. Undelivered grants are retried every time the player loads.
// ---------------------------------------------------------------------------

/** TODO(Ark rewards): send the wearable through the Rewards campaign. Return
 *  true only once delivery is confirmed — anything else is retried later. */
async function deliverWearable(address: string, wearable: C.ArkWearable): Promise<boolean> {
  if (!wearable.urn) return false // no campaign wired yet: keep it pending
  console.log('[Server] ark wearable delivery not wired yet', address, wearable.id)
  return false
}

function addGrant(p: PlayerData, key: string, wearableId: string): void {
  const ark = arkData(p)
  if (ark.grants.some((g) => g.key === key)) return
  ark.grants.push({ key, wearableId, delivered: false, at: Date.now() })
}

/** Record the first-donation wearable for this player. */
export function grantFirstDonationWearable(p: PlayerData): void {
  addGrant(p, 'first', C.ARK_FIRST_DONATION_WEARABLE.id)
}

/** Make sure every remembered launch this player donated to has its grant —
 *  covers donors who were offline when their launch happened. */
export function reconcileArkGrants(p: PlayerData): void {
  if (!world) return
  const key = p.address.toLowerCase()
  for (const l of world.launches) {
    if ((l.donors[key] ?? 0) > 0) addGrant(p, `launch:${l.eventId}`, C.arkLaunchWearable(l.eventId).id)
  }
}

/** Try to deliver every pending grant. Returns true if anything changed, so
 *  the caller knows to persist the player. */
export async function deliverPendingWearables(p: PlayerData): Promise<boolean> {
  let changed = false
  for (const g of arkData(p).grants) {
    if (g.delivered) continue
    const wearable = C.arkWearableById(g.wearableId)
    if (!wearable) continue
    if (await deliverWearable(p.address, wearable)) {
      g.delivered = true
      changed = true
    }
  }
  return changed
}

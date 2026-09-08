// Headless authoritative server. Owns all game state, validates actions,
// runs decay, persists to Storage, and broadcasts presence for social render.

import { engine, PlayerIdentityData } from '@dcl/sdk/ecs'
import { room } from '../shared/messages'
import type { CareAction, PlayerData, PresenceEntry } from '../shared/types'
import * as S from './state'
import { trackEvent } from '../shared/analytics'

const TICK_INTERVAL = 5 // seconds between decay/persist passes
const SNAPSHOT_INTERVAL = 3 // seconds between owner snapshot pushes
// Session-duration guards (see the departure sweep below).
const MAX_SESSION_SECONDS = 14400 // 4h ceiling on a reported session (matches cozy-farm) — caps a stuck clock
const DEPART_GRACE_MS = 10000 // don't call a departure until the session is this old (~2 ticks): the identity entity can lag the first requestState, and departing early would emit a premature `session ended` + a duplicate `session started`

// Track which addresses are currently connected (seen via PlayerIdentityData).
const connected = new Set<string>()
// address -> ms timestamp when their session started, so we can report the
// session's duration in the `session ended` event when they disconnect.
const sessionStart = new Map<string, number>()

function forwardNotes(address: string, notes: S.Notify[]): void {
  for (const n of notes) {
    room.send('notify', { kind: n.kind, message: n.message }, { to: [address] })
  }
}

function pushSnapshot(p: PlayerData): void {
  room.send('stateSnapshot', { json: JSON.stringify(S.snapshotFor(p)) }, { to: [p.address] })
}

/** The shared colony population: every pet raised across the colony. */
function broadcastColony(): void {
  let population = 0
  for (const p of S.allCached()) population += p.pets.length
  room.send('colony', { population })
}

function broadcastPresence(): void {
  const entries: PresenceEntry[] = []
  for (const p of S.allCached()) {
    const e = S.presenceFor(p)
    if (e) entries.push(e)
  }
  room.send('presence', { json: JSON.stringify(entries) })
}

export function server(): void {
  console.log('[Server] MyDearPet authoritative server starting')

  // -- Message handlers -----------------------------------------------------
  room.onMessage('requestState', async (data, ctx) => {
    if (!ctx) return
    console.log('[Server] requestState from', ctx.from)
    S.setPlayerName(ctx.from, data.guestName) // remember the name for the leaderboard
    // requestState repeats every ~2s; the first one this lifetime marks a fresh
    // scene entry -> emit exactly one `session started`. Mark `connected` BEFORE
    // the await so two near-simultaneous first requests don't both fire.
    const firstThisSession = !connected.has(ctx.from)
    connected.add(ctx.from)
    const p = await S.loadPlayer(ctx.from)
    if (firstThisSession) {
      sessionStart.set(ctx.from, Date.now()) // start the clock for session-duration
      trackEvent('session started', ctx.from, { is_new_user: S.isFreshPlayer(ctx.from) })
    }
    pushSnapshot(p)
    broadcastPresence()
    broadcastColony() // a player joined -> their pets count toward the colony
  })

  // Coins leaderboard — computed on demand (when the client opens the panel) and
  // sent only to the requester, so it's fresh without spamming every client. Rate-
  // limited per sender so a client can't spam the sort+stringify.
  const lastLeaderReq = new Map<string, number>()
  room.onMessage('requestLeaderboard', async (_data, ctx) => {
    if (!ctx) return
    const now = Date.now()
    if (now - (lastLeaderReq.get(ctx.from) ?? 0) < 2000) return
    lastLeaderReq.set(ctx.from, now)
    await S.loadPlayer(ctx.from) // cache + tick the requester so their own row is current
    room.send('leaderboard', { json: JSON.stringify(await S.leaderboard()) }, { to: [ctx.from] })
  })

  room.onMessage('adopt', async (data, ctx) => {
    if (!ctx) return
    console.log('[Server] adopt from', ctx.from, data.species)
    const p = await S.loadPlayer(ctx.from)
    const notes = S.adopt(p, data.species, data.name)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('keepPet', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.keepPet(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
    broadcastPresence()
    broadcastColony() // one more pet in the colony
  })

  room.onMessage('discardPet', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.discardPet(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('careAction', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.careAction(p, data.action as CareAction, data.onBed)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('feedResult', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.feedFromMinigame(p, data.caught)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('petSelf', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    S.petSelf(p)
    pushSnapshot(p)
  })

  room.onMessage('petOther', async (data, ctx) => {
    if (!ctx) return
    const giver = await S.loadPlayer(ctx.from)
    const target = S.getCached(data.targetAddress) ?? (await S.loadPlayer(data.targetAddress))
    const notes = S.petOther(giver, target)
    await S.savePlayer(giver.address)
    await S.savePlayer(target.address)
    forwardNotes(giver.address, notes)
    pushSnapshot(giver)
    pushSnapshot(target)
  })

  room.onMessage('buyItem', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.buyItem(p, data.tier)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('useItem', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.useItem(p, data.tier)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('switchPet', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.switchPet(p, data.petId)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
    broadcastPresence()
  })

  room.onMessage('buySlot', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.buySlot(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('buyPotion', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.buyPotion(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('spin', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const { notes, reward, index } = S.spin(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    if (reward) room.send('spinResult', { json: JSON.stringify(reward), index }, { to: [ctx.from] })
    pushSnapshot(p)
  })

  room.onMessage('breed', async (data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const { notes, rarity, species, name } = S.breed(p, data.partnerPetId, data.name, data.usePotion)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    // The offspring is an egg (hatchling) now — the client carries + hatches it,
    // and it only joins the colony once kept (keepPet broadcasts then).
    if (rarity) room.send('breedResult', { rarity, species: species ?? '', name: name ?? '' }, { to: [ctx.from] })
    pushSnapshot(p)
  })

  room.onMessage('debugGrowAdult', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const notes = S.debugGrowAdult(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
    broadcastPresence() // its size/level changed — mirror it for everyone
  })

  room.onMessage('claimDaily', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const { notes } = S.claimDailyReward(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    pushSnapshot(p)
  })

  room.onMessage('openMeteor', async (_data, ctx) => {
    if (!ctx) return
    const p = await S.loadPlayer(ctx.from)
    const { notes, reward, index } = S.openMeteorReward(p)
    await S.savePlayer(ctx.from)
    forwardNotes(ctx.from, notes)
    if (reward) room.send('meteorResult', { json: JSON.stringify(reward), index }, { to: [ctx.from] })
    pushSnapshot(p)
  })

  room.onMessage('setFollow', (data, ctx) => {
    if (!ctx) return
    S.setFollowState(ctx.from, data.following)
    broadcastPresence() // push the new follow/stay state to everyone right away
  })

  room.onMessage('proposeSwap', async (data, ctx) => {
    if (!ctx) return
    const from = await S.loadPlayer(ctx.from)
    const target = S.getCached(data.targetAddress) ?? (await S.loadPlayer(data.targetAddress))
    const { notes, offeredPet, wantedPet } = S.proposeSwap(from, target)
    forwardNotes(ctx.from, notes)
    if (offeredPet && wantedPet) {
      const payload = {
        fromAddress: from.address,
        fromName: data.fromName || from.address.slice(0, 6),
        offeredPet,
        wantedPetName: wantedPet.name
      }
      room.send('swapOffer', { json: JSON.stringify(payload) }, { to: [target.address] })
      forwardNotes(ctx.from, [{ kind: 'swap', message: `Offer sent — waiting for ${target.address.slice(0, 6)}…` }])
    }
  })

  room.onMessage('respondSwap', async (data, ctx) => {
    if (!ctx) return
    const target = await S.loadPlayer(ctx.from)
    const offer = S.getPendingSwap(ctx.from)
    const proposer = offer ? S.getCached(offer.from) ?? (await S.loadPlayer(offer.from)) : null
    const { notes, proposerNote, swapped } = S.respondSwap(target, proposer, data.accept)
    forwardNotes(ctx.from, notes)
    if (proposerNote && proposer) {
      room.send('swapResult', { accepted: swapped, message: proposerNote.message }, { to: [proposer.address] })
    }
    if (swapped && proposer) {
      await S.savePlayer(proposer.address)
      await S.savePlayer(target.address)
      pushSnapshot(proposer)
      pushSnapshot(target)
      broadcastPresence() // both active pets changed -> update the world render
    } else {
      pushSnapshot(target)
    }
  })

  // -- Periodic decay / persist / presence loop -----------------------------
  let tickAcc = 0
  let snapAcc = 0
  engine.addSystem((dt: number) => {
    tickAcc += dt
    snapAcc += dt

    if (tickAcc >= TICK_INTERVAL) {
      tickAcc = 0
      for (const p of S.allCached()) {
        S.tickPlayer(p)
        void S.savePlayer(p.address)
      }
      broadcastPresence()
      broadcastColony()

      // Departures: anyone we marked `connected` who no longer has a
      // PlayerIdentityData entity has left the scene -> emit `session ended`
      // with how long they stayed, keyed by the SAME wallet (addr, the ctx.from
      // stored in `connected`) as `session started`, so PostHog can pair them.
      // NB: this measures per-VISIT — the identity entity vanishes on parcel exit
      // — which for our dashboard counts as one session. Detected within one
      // TICK_INTERVAL of the disconnect.
      const present = new Set<string>()
      for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
        void entity
        present.add(identity.address.toLowerCase()) // case-insensitive vs connected (ctx.from) — a case skew would else "depart" everyone every tick
      }
      const nowMs = Date.now()
      for (const addr of [...connected]) {
        if (present.has(addr.toLowerCase())) continue
        const start = sessionStart.get(addr)
        // First-tick grace: a just-joined player's identity entity can lag their
        // first requestState by a tick — don't treat that as a departure.
        if (start && nowMs - start < DEPART_GRACE_MS) continue
        // Report duration only when we have a start (a missing clock is skipped,
        // not reported as 0s — which would read as an instant session), capped so
        // a stuck clock can't post an absurd number.
        const props = start ? { duration_seconds: Math.min(Math.round((nowMs - start) / 1000), MAX_SESSION_SECONDS) } : {}
        trackEvent('session ended', addr, props)
        connected.delete(addr)
        sessionStart.delete(addr)
      }
    }

    if (snapAcc >= SNAPSHOT_INTERVAL) {
      snapAcc = 0
      // Refresh the HUD of connected owners with current decayed values.
      for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
        void entity
        const p = S.getCached(identity.address)
        if (p) pushSnapshot(p)
      }
    }
  })

  console.log('[Server] handlers + decay loop registered')
}

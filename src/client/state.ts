// Client-side mirror of server state, for the UI and pet rendering to read.
// The server is authoritative; this is just the latest snapshot we received.

import { getPlayer } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import type { CareAction, LeaderboardEntry, PetData, PlayerData, PlayerSnapshot, PresenceEntry, SwapOfferPayload } from '../shared/types'
import { levelForXp, NEW_PET_STATS, SERVER_TIMEOUT_MS, SIZE_BASE, SIZE_MAX, slotPrice, speciesLabel, xpForLevel, type SpinReward } from '../shared/config'

export type DialogState = {
  open: boolean
  npcName: string
  pages: string[]
  page: number
  finalLabel: string
  onDone: (() => void) | null
  // Show the "Adopt" button art on the final page (only the Caretaker intro,
  // whose CTA is adopting). Everything else uses the neutral "Next" art.
  adoptCta: boolean
}

export const clientState: {
  myAddress: string
  player: PlayerData | null
  activePet: PetData | null
  presence: PresenceEntry[]
  // UI flags
  followEnabled: boolean
  // Toast queue: pushToast() enqueues a message here; Toasts() (ui.tsx) shows
  // one at a time from `currentToast`, advancing the queue as each expires —
  // multiple toasts no longer stack/overlap on screen.
  toasts: string[]
  currentToast: { message: string; until: number } | null
  // Contextual guidance hint (one shown at a time), persistent until its action
  // is done. See showHint/clearHint. null = nothing showing.
  hint: { id: string; message: string } | null
  // Gamified "+XP +coins" reward popup after a care action. Auto-expires.
  reward: { xp: number; coins: number; until: number } | null
  lastSpin: { reward: SpinReward; index: number; at: number } | null
  dialog: DialogState
  introShown: boolean
  // Whether the pet control panel (stats + care) is open. Closed by default so
  // it doesn't cover the screen; opens by clicking the pet, closes with the X.
  petPanelOpen: boolean
  // Read-only "passport" for another player's pet: address of whose pet is
  // being viewed, or null when closed. Opened by clicking a remote pet.
  viewingPetAddress: string | null
  // An incoming pet-swap offer awaiting our Accept/Decline, or null. Set by the
  // `swapOffer` server message; drives the SwapOfferPanel modal.
  incomingSwap: SwapOfferPayload | null
  // ms timestamp of the last "Give a treat" click — the server silently drops
  // petOther on cooldown (no notify), so this drives a local disable/toast
  // instead of the button looking dead on a fast second click.
  lastTreatSentAt: number
  // Hold-to-pet gesture: active while the overlay is up; progress 0..1 fills
  // while the pointer is held and ebbs back when released.
  petting: { active: boolean; progress: number; celebrationUntil: number }
  // Carrying an egg home: on adoption the egg is attached to the avatar and the
  // player must walk it home (`atHome` true within HOME_RADIUS) to hatch it.
  carryEgg: { active: boolean; species: string; name: string; atHome: boolean }
  // Carrying the pet to the bath: the pet is held in the player's hands; walk it
  // to the tub (`atStation` true when close) and place it there to bathe it.
  carryPet: { active: boolean; atStation: boolean }
  // Feed errand (feed.ts): the guide arrow is up and the player is walking to
  // the tree, where the feeding minigame takes over. Like the carry flows this
  // OWNS the moment — no other care action can start until it resolves or the
  // player cancels it with BACK. `petId` is the pet Feed was pressed for, so the
  // errand can drop itself if the player switches pets mid-walk.
  feedTask: { active: boolean; petId: string }
  // Hatch gesture: rubbing/tapping the egg fills this progress, then it hatches.
  // Reuses the petting gesture input.
  hatch: { active: boolean; progress: number }
  // Feed tree minigame (fruitGame.ts): 'arrival' tracks the zoom-in cinematic,
  // 'intro' is the freeze+emote reveal beat where the player waits (parked)
  // until they tap Start, 'countdown' is the 3-2-1 after Start, 'catching' is
  // the timed fruit-catching phase the HUD counter/timer reads from, 'feeding'
  // is the short pet-eating cinematic, and 'results' is the post-round reveal
  // (count-up + feed bar) before the player taps Exit. catchFlashUntil
  // (Date.now() ms) briefly pulses the counter each time a fruit is caught;
  // countdownAt/resultsAt (Date.now() ms) mark the animated phases.
  feedGame: {
    active: boolean
    phase: 'arrival' | 'intro' | 'countdown' | 'catching' | 'feeding' | 'results'
    caught: number
    timeLeft: number
    catchFlashUntil: number
    countdownAt: number
    resultsAt: number
    petSitPos: { x: number; y: number; z: number } | null
    petSitLook: { x: number; y: number; z: number } | null
    hungerStart: number
    hungerTarget: number
  }
  // Fetch (Play) mode: `active` shows the centered Fetch button and hides the
  // panel; `busy` is true from the moment the ball is thrown until the pet drops
  // it back (the Fetch button is disabled while busy). Holding the Throw button
  // ramps `charge` 0→1 (`charging` true meanwhile) — that charge scales the
  // throw's distance/arc/flight-time on release (play.ts's beginThrow).
  fetch: { active: boolean; busy: boolean; charging: boolean; charge: number }
  // Optimistic adoption: render the new pet instantly while the server catches
  // up, so adoption never feels like "nothing happened" if a message is slow.
  pendingPet: PetData | null
  pendingUntil: number
  // 7-day login streak (client-owned so it works without the server).
  streak: { count: number; lastDay: number; claimedDay: number }
  // ms timestamp of the last message received from the authoritative server
  // (0 = never heard from it). Drives the connection indicator.
  lastServerMsgAt: number
  // True once the FIRST stateSnapshot has been received — the loading gate
  // (ui.tsx Root) blocks all UI/input until this flips, so nothing starts
  // before the server has answered with our persisted state.
  serverReady: boolean
  // Shared Mars colony population, broadcast by the server (same for everyone).
  colonyPopulation: number
  // Coins leaderboard, refreshed each time the panel opens (requestLeaderboard).
  leaderboard: LeaderboardEntry[]
  // Compact food-pile calibration panel. It freezes only the final Feed beat.
  debugFruitPilePanelOpen: boolean
} = {
  myAddress: '',
  player: null,
  activePet: null,
  presence: [],
  followEnabled: true,
  toasts: [],
  currentToast: null,
  hint: null,
  reward: null,
  lastSpin: null,
  dialog: { open: false, npcName: '', pages: [], page: 0, finalLabel: 'Got it!', onDone: null, adoptCta: false },
  introShown: false,
  petPanelOpen: false,
  viewingPetAddress: null,
  incomingSwap: null,
  lastTreatSentAt: 0,
  petting: { active: false, progress: 0, celebrationUntil: 0 },
  carryEgg: { active: false, species: '', name: '', atHome: false },
  carryPet: { active: false, atStation: false },
  feedTask: { active: false, petId: '' },
  hatch: { active: false, progress: 0 },
  feedGame: { active: false, phase: 'arrival', caught: 0, timeLeft: 0, catchFlashUntil: 0, countdownAt: 0, resultsAt: 0, petSitPos: null, petSitLook: null, hungerStart: 0, hungerTarget: 0 },
  fetch: { active: false, busy: false, charging: false, charge: 0 },
  pendingPet: null,
  pendingUntil: 0,
  streak: { count: 1, lastDay: 0, claimedDay: 0 },
  lastServerMsgAt: 0,
  serverReady: false,
  colonyPopulation: 0,
  leaderboard: [],
  debugFruitPilePanelOpen: false
}

/** Stamp that the server just talked to us. Called from every server handler. */
export function markServerAlive(): void {
  clientState.lastServerMsgAt = Date.now()
}

/**
 * True while a freshly hatched pet is still awaiting the player's Keep/Discard
 * decision. During this window the hatchling IS the active pet but isn't in a slot
 * yet, so opening its panel or running care/interactions on it bugs out — every
 * interaction entry point and the panel gate on this. Single source of truth.
 */
export function hasPendingHatchling(): boolean {
  return !!clientState.player?.hatchling
}

/**
 * True while the authoritative server has answered recently. False means we're
 * running on the local simulation only — progress won't persist.
 */
export function serverConnected(): boolean {
  if (clientState.lastServerMsgAt === 0) return false // never heard from it
  return Date.now() - clientState.lastServerMsgAt < SERVER_TIMEOUT_MS
}

/** Open a multi-page NPC dialog. Advancing past the last page closes it. */
export function openDialog(npcName: string, pages: string[], finalLabel = 'Got it!', onDone?: () => void, adoptCta = false): void {
  clientState.dialog = { open: true, npcName, pages, page: 0, finalLabel, onDone: onDone ?? null, adoptCta }
}

export function advanceDialog(): void {
  const d = clientState.dialog
  if (!d.open) return
  if (d.page < d.pages.length - 1) {
    d.page += 1
    return
  }
  d.open = false
  const cb = d.onDone
  d.onDone = null
  if (cb) cb()
}

export function closeDialog(): void {
  clientState.dialog.open = false
  clientState.dialog.onDone = null
}

export function applySnapshot(snap: PlayerSnapshot): void {
  clientState.player = snap.player
  if (snap.activePet) {
    // Server confirmed a pet — authoritative wins, clear any optimistic state.
    clientState.activePet = snap.activePet
    clientState.pendingPet = null
  } else if (clientState.pendingPet && Date.now() < clientState.pendingUntil) {
    // Server hasn't caught up yet — keep showing the optimistic hatchling.
    clientState.activePet = clientState.pendingPet
    if (clientState.player) clientState.player.hatchling = clientState.pendingPet
  } else {
    clientState.activePet = snap.activePet
    clientState.pendingPet = null
  }
}

/** Build a local placeholder pet for optimistic rendering. */
function makeLocalPet(species: string, name: string): PetData {
  const t = Date.now()
  return {
    id: `local_${t}`,
    species,
    name: name || speciesLabel(species),
    rarity: 'common',
    hunger: NEW_PET_STATS.hunger,
    hygiene: NEW_PET_STATS.hygiene,
    energy: NEW_PET_STATS.energy,
    happiness: NEW_PET_STATS.happiness,
    petXp: 0,
    petLevel: 1,
    size: SIZE_BASE,
    careCount: 0,
    generation: 0,
    sleeping: false,
    sleepOnBed: false,
    sleepLockUntil: 0,
    bornAt: t,
    lastUpdated: t
  }
}

/** Make a stored pet the active one locally (and tell the server). */
export function switchActivePet(petId: string): void {
  const p = clientState.player
  if (!p) return
  const pet = p.pets.find((x) => x.id === petId)
  if (!pet) return
  // Don't swap the active pet out from under a running flow. The localPet entity
  // is REUSED across the switch, so the newcomer would inherit a carry/errand it
  // never started (see pet.ts reanchorLocalPet). Both entry points — the roster
  // panel and clicking a stored pet in the world — funnel through here, so this
  // is the one gate that covers them all. Sleeping / plain care actions are NOT
  // blocked: reanchorLocalPet re-places the pet cleanly for those.
  const s = clientState
  if (
    hasPendingHatchling() ||
    s.hatch.active ||
    s.carryEgg.active ||
    s.carryPet.active ||
    s.petting.active ||
    s.fetch.active ||
    s.feedGame.active ||
    s.feedTask.active
  ) {
    pushToast('Finish what your pet is doing first!')
    return
  }
  p.activePetId = petId
  clientState.activePet = pet
  actions.switchPet(petId)
}

/** Adopt/hatch: the pet becomes an unplaced "hatchling" (rendered immediately,
 *  optimistic). The player later keeps it (into a slot) or discards it. */
export function adoptPet(species: string, name: string): void {
  const pet = makeLocalPet(species, name)
  clientState.pendingPet = pet
  clientState.pendingUntil = Date.now() + 12000
  clientState.activePet = pet
  if (clientState.player) clientState.player.hatchling = pet
  actions.adopt(species, name)
}

/** Keep the hatchling: place it in a slot, make it active (optimistic + server). */
export function keepHatchling(): void {
  const p = clientState.player
  if (!p || !p.hatchling) return
  const pet = p.hatchling
  p.hatchling = null
  if (!p.pets.find((x) => x.id === pet.id)) p.pets = [...p.pets, pet]
  p.activePetId = pet.id
  clientState.activePet = pet
  clientState.pendingPet = null
  // First pet ever born -> nudge the player to interact with it.
  if (p.pets.length === 1) showHint('firstPet', 'Click on your pet to complete some necessities and gain XP and coins!')
  actions.keepPet()
}

/** Discard the hatchling: it goes back to the Care Center — nothing kept. */
export function discardHatchling(): void {
  const p = clientState.player
  if (!p || !p.hatchling) return
  p.hatchling = null
  clientState.pendingPet = null
  clientState.activePet = p.pets.find((x) => x.id === p.activePetId) ?? null
  actions.discardPet()
}

export function applyPresence(entries: PresenceEntry[]): void {
  clientState.presence = entries
}

export function presenceFor(address: string): PresenceEntry | undefined {
  return clientState.presence.find((e) => e.address.toLowerCase() === address.toLowerCase())
}

export function pushToast(message: string): void {
  clientState.toasts.push(message)
  if (clientState.toasts.length > 6) clientState.toasts.shift()
}

// ---------------------------------------------------------------------------
// Contextual hints — one-time guidance ("go explore the meteorite", "click your
// pet", ...). Each id fires at most once, and stays up until its action clears
// it. Kept separate from toasts (transient) since hints persist.
// ---------------------------------------------------------------------------
const shownHints = new Set<string>()
export function showHint(id: string, message: string): void {
  if (shownHints.has(id)) return
  shownHints.add(id)
  clientState.hint = { id, message }
}
/** Clear the current hint (optionally only if it matches `id`). */
export function clearHint(id?: string): void {
  if (!clientState.hint) return
  if (id && clientState.hint.id !== id) return
  clientState.hint = null
}

/** Flash a gamified "+XP +coins" reward popup (after a care action). */
export function showReward(xp: number, coins: number): void {
  clientState.reward = { xp, coins, until: Date.now() + 1800 }
}

export function resolveMyAddress(): string {
  if (clientState.myAddress) return clientState.myAddress
  const p = getPlayer()
  clientState.myAddress = p?.userId ?? ''
  return clientState.myAddress
}

// ---- send helpers (thin wrappers over the room) ----
export const actions = {
  requestState(): void {
    const p = getPlayer()
    console.log('[Client] -> requestState')
    room.send('requestState', { guestName: p?.name ?? 'Guest' })
  },
  requestLeaderboard(): void {
    room.send('requestLeaderboard', {})
  },
  adopt(species: string, name: string): void {
    console.log('[Client] -> adopt', species, name)
    room.send('adopt', { species, name })
  },
  care(action: CareAction, onBed = false): void {
    room.send('careAction', { action, onBed })
  },
  feedResult(caught: number): void {
    room.send('feedResult', { caught })
  },
  keepPet(): void {
    room.send('keepPet', {})
  },
  discardPet(): void {
    room.send('discardPet', {})
  },
  petSelf(): void {
    room.send('petSelf', {})
  },
  petOther(targetAddress: string): void {
    room.send('petOther', { targetAddress })
  },
  proposeSwap(targetAddress: string, fromName: string): void {
    room.send('proposeSwap', { targetAddress, fromName })
  },
  respondSwap(accept: boolean): void {
    room.send('respondSwap', { accept })
  },
  buyItem(tier: number): void {
    room.send('buyItem', { tier })
  },
  useItem(tier: number): void {
    room.send('useItem', { tier })
  },
  switchPet(petId: string): void {
    room.send('switchPet', { petId })
  },
  buySlot(): void {
    room.send('buySlot', {})
  },
  buyPotion(): void {
    room.send('buyPotion', {})
  },
  spin(): void {
    room.send('spin', {})
  },
  setFollow(following: boolean): void {
    room.send('setFollow', { following })
  },
  openMeteor(): void {
    room.send('openMeteor', {})
  },
  claimDaily(): void {
    room.send('claimDaily', {})
  },
  breed(partnerPetId: string, name = '', usePotion = false): void {
    room.send('breed', { partnerPetId, name, usePotion })
  },
  debugGrowAdult(): void {
    room.send('debugGrowAdult', {})
  }
}

/** DEBUG/testing: grow the active pet to Adult + Lv5 instantly (optimistic +
 *  server). Bound to a hotkey in input.ts so breeding can be tested fast. */
export function debugGrowAdultLocal(): void {
  const pet = clientState.activePet
  if (!pet) return
  pet.careCount = Math.max(pet.careCount, 70)
  pet.size = SIZE_MAX
  pet.petXp = Math.max(pet.petXp, xpForLevel(5))
  pet.petLevel = levelForXp(pet.petXp)
  if (clientState.player) clientState.player.currency = Math.max(clientState.player.currency, slotPrice(clientState.player.petSlots))
  actions.debugGrowAdult()
}

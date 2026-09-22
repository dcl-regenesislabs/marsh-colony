// Client-side mirror of server state, for the UI and pet rendering to read.
// The server is authoritative; this is just the latest snapshot we received.

import { getPlayer } from '@dcl/sdk/players'
import { room } from '../shared/messages'
import type { CareAction, LeaderboardEntry, PetData, PlayerData, PlayerSnapshot, PresenceEntry, SwapOfferPayload } from '../shared/types'
import { levelForXp, NEW_PET_STATS, SERVER_TIMEOUT_MS, SIZE_BASE, SIZE_MAX, slotPrice, speciesLabel, xpForLevel, type SpinReward } from '../shared/config'

const OPTIMISTIC_PET_TIMEOUT_MS = 12000

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
  // Fired with the new page index each time the player taps Next to a later
  // page (not on close — that's onDone). Lets a cinematic change shots per page.
  onPage: ((page: number) => void) | null
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
  // multiple toasts no longer stack/overlap on screen. `kind` (server notify
  // kind, or 'info' for local ones) drives the accent color; `shownAt` marks
  // when the current toast started so the render can drive its slide/fade.
  toasts: { message: string; kind: string }[]
  currentToast: { message: string; kind: string; shownAt: number; until: number } | null
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
  // ms timestamp this player's OWN pet was last treated by someone else (set
  // from the 'treated' notify — see server/state.ts petOther). Drives
  // petEmotes.ts's heart reaction.
  lastTreatedAt: number
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
  // Sickness errand (sicknessErrand.ts): after catching a poisonous fruit in
  // the Feed minigame and clearing the sickness-explainer dialog, the guide
  // arrow is up and the player is walking to the Caretaker, who hands off into
  // the Pepito chase on arrival. Same "owns the moment" shape as feedTask.
  sicknessErrand: { active: boolean; petId: string }
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
    hungerTarget: number
    // Driven by fruitGame's tick while the final eat beat plays. Keeping it in
    // state makes the HUD fill continuous and tied to the cinematic clock.
    hungerFillProgress: number
    // Sticky for the whole round: true once ANY poisonous fruit has been
    // caught this game (see fruitGame.ts's FruitRuntime.poison). Sent with
    // the feedResult message — server/state.ts's feedFromMinigame sets
    // pet.sick from it.
    poisoned: boolean
  }
  // Bubble-bath minigame (see client/bathGame.ts). `popped` counts popped
  // bubbles, `timeLeft` the popping-phase clock; popFlashUntil (Date.now() ms)
  // pulses the counter on a pop, countdownAt/resultsAt anchor those animations.
  bathGame: {
    active: boolean
    phase: 'intro' | 'countdown' | 'popping' | 'results'
    popped: number
    timeLeft: number
    popFlashUntil: number
    countdownAt: number
    resultsAt: number
  }
  // Fetch (Play) mode: `active` shows the centered Fetch button and hides the
  // panel; `busy` is true from the moment the ball is thrown until the pet drops
  // it back (the Fetch button is disabled while busy). Holding the Throw button
  // ramps `charge` 0→1 (`charging` true meanwhile) — that charge scales the
  // throw's distance/arc/flight-time on release (play.ts's beginThrow).
  fetch: { active: boolean; busy: boolean; charging: boolean; charge: number }
  // Pepito chase minigame (pepitoChase.ts), reached from the sickness errand
  // once the player reaches the Caretaker. 'steal' is the frozen cinematic
  // where Pepito swipes the cure; 'circling' is the live charge/throw phase
  // (Pepito flies its circle high above the Care Center); 'hit' is the beat
  // where Pepito flees and the cure falls where it was hit; 'pickup' is the
  // walk to the landed cure (guide arrow + floor marker); 'results' is the
  // reward card before Exit. charge/charging mirror `fetch`'s
  // own charge-meter shape (same Throw-button mechanic); `busy` is true while
  // a rock is in flight (mirrors fetch.busy).
  pepitoChase: {
    active: boolean
    phase: 'steal' | 'circling' | 'hit' | 'pickup' | 'results'
    charging: boolean
    charge: number
    busy: boolean
  }
  // Optimistic adoption: render the new pet instantly while the server catches
  // up, so adoption never feels like "nothing happened" if a message is slow.
  pendingPet: PetData | null
  pendingUntil: number
  // Keep/Discard is optimistic too. Pin the decided hatchling briefly so a
  // late pre-decision snapshot cannot reopen its choice UI, while still
  // accepting unrelated/new hatchlings and eventually reconciling a rejection.
  pendingHatchlingDecision: { pet: PetData; action: 'keep' | 'discard'; until: number } | null
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
} = {
  myAddress: '',
  player: null,
  activePet: null,
  presence: [],
  followEnabled: true,
  toasts: [],
  currentToast: null,
  reward: null,
  lastSpin: null,
  dialog: { open: false, npcName: '', pages: [], page: 0, finalLabel: 'Got it!', onDone: null, adoptCta: false, onPage: null },
  introShown: false,
  petPanelOpen: false,
  viewingPetAddress: null,
  incomingSwap: null,
  lastTreatSentAt: 0,
  lastTreatedAt: 0,
  petting: { active: false, progress: 0, celebrationUntil: 0 },
  carryEgg: { active: false, species: '', name: '', atHome: false },
  carryPet: { active: false, atStation: false },
  feedTask: { active: false, petId: '' },
  sicknessErrand: { active: false, petId: '' },
  hatch: { active: false, progress: 0 },
  feedGame: { active: false, phase: 'arrival', caught: 0, timeLeft: 0, catchFlashUntil: 0, countdownAt: 0, resultsAt: 0, petSitPos: null, petSitLook: null, hungerTarget: 0, hungerFillProgress: 0, poisoned: false },
  bathGame: { active: false, phase: 'intro', popped: 0, timeLeft: 0, popFlashUntil: 0, countdownAt: 0, resultsAt: 0 },
  fetch: { active: false, busy: false, charging: false, charge: 0 },
  pepitoChase: { active: false, phase: 'steal', charging: false, charge: 0, busy: false },
  pendingPet: null,
  pendingUntil: 0,
  pendingHatchlingDecision: null,
  streak: { count: 1, lastDay: 0, claimedDay: 0 },
  lastServerMsgAt: 0,
  serverReady: false,
  colonyPopulation: 0,
  leaderboard: []
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
export function openDialog(
  npcName: string,
  pages: string[],
  finalLabel = 'Got it!',
  onDone?: () => void,
  adoptCta = false,
  onPage?: (page: number) => void
): void {
  clientState.dialog = { open: true, npcName, pages, page: 0, finalLabel, onDone: onDone ?? null, adoptCta, onPage: onPage ?? null }
}

export function advanceDialog(): void {
  const d = clientState.dialog
  if (!d.open) return
  if (d.page < d.pages.length - 1) {
    d.page += 1
    if (d.onPage) d.onPage(d.page)
    return
  }
  d.open = false
  const cb = d.onDone
  d.onDone = null
  d.onPage = null
  if (cb) cb()
}

export function closeDialog(): void {
  clientState.dialog.open = false
  clientState.dialog.onDone = null
  clientState.dialog.onPage = null
}

export function applySnapshot(snap: PlayerSnapshot): void {
  const decision = clientState.pendingHatchlingDecision
  const staleDecisionSnapshot =
    !!decision && Date.now() < decision.until && snap.player.hatchling?.id === decision.pet.id
  // A matching hatchling is a late pre-decision snapshot. All of its other
  // fields remain authoritative; only the resolved hatchling field is kept
  // optimistic. A different hatchling, or one after the grace period, wins.
  if (decision && !staleDecisionSnapshot) clientState.pendingHatchlingDecision = null
  clientState.player = snap.player
  if (staleDecisionSnapshot) {
    clientState.player.hatchling = null
    if (decision.action === 'keep') {
      if (!clientState.player.pets.some((pet) => pet.id === decision.pet.id)) clientState.player.pets = [...clientState.player.pets, decision.pet]
      clientState.player.activePetId = decision.pet.id
      clientState.activePet = decision.pet
    } else {
      clientState.activePet = clientState.player.pets.find((pet) => pet.id === clientState.player?.activePetId) ?? null
    }
  } else if (snap.activePet) {
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
    sick: false,
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
    s.bathGame.active ||
    s.feedTask.active ||
    s.sicknessErrand.active ||
    s.pepitoChase.active
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
  clientState.pendingUntil = Date.now() + OPTIMISTIC_PET_TIMEOUT_MS
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
  clientState.pendingHatchlingDecision = { pet, action: 'keep', until: Date.now() + OPTIMISTIC_PET_TIMEOUT_MS }
  // First pet ever born -> nudge the player to interact with it.
  if (p.pets.length === 1) showHint('firstPet', 'Click on your pet to complete some necessities and gain XP and coins!')
  actions.keepPet()
}

/** Discard the hatchling: it goes back to the Care Center — nothing kept. */
export function discardHatchling(): void {
  const p = clientState.player
  if (!p || !p.hatchling) return
  const pet = p.hatchling
  p.hatchling = null
  clientState.pendingPet = null
  clientState.activePet = p.pets.find((x) => x.id === p.activePetId) ?? null
  clientState.pendingHatchlingDecision = { pet, action: 'discard', until: Date.now() + OPTIMISTIC_PET_TIMEOUT_MS }
  actions.discardPet()
}

export function applyPresence(entries: PresenceEntry[]): void {
  clientState.presence = entries
}

export function presenceFor(address: string): PresenceEntry | undefined {
  return clientState.presence.find((e) => e.address.toLowerCase() === address.toLowerCase())
}

export function pushToast(message: string, kind: string = 'info'): void {
  clientState.toasts.push({ message, kind })
  if (clientState.toasts.length > 6) clientState.toasts.shift()
}

// ---------------------------------------------------------------------------
// Contextual hints — one-time guidance ("go explore the meteorite", "click your
// pet", ...). Each id fires at most once, then rides the normal toast pipeline
// (slides in from the right, holds, retracts) instead of a persistent banner.
// `kind` picks the toast accent (see Toasts in ui.tsx).
// ---------------------------------------------------------------------------
const shownHints = new Set<string>()
export function showHint(id: string, message: string, kind: string = 'info'): void {
  if (shownHints.has(id)) return
  shownHints.add(id)
  pushToast(message, kind)
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
  feedResult(caught: number, poisoned: boolean): void {
    room.send('feedResult', { caught, poisoned })
  },
  cureSickness(): void {
    room.send('cureSickness', {})
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
  debugGrowAdult(): void {
    room.send('debugGrowAdult', {})
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
  setCarried(carried: boolean): void {
    room.send('setCarried', { carried })
  },
  openMeteor(): void {
    room.send('openMeteor', {})
  },
  claimDaily(): void {
    room.send('claimDaily', {})
  },
  breed(partnerPetId: string, name = '', usePotion = false): void {
    room.send('breed', { partnerPetId, name, usePotion })
  }
}

/** DEBUG cheat: optimistically grow the active pet to Adult + Lv5 locally (so the
 *  HUD updates instantly), then tell the server, which persists it and re-broadcasts
 *  the authoritative snapshot. Mirrors server/state.ts debugGrowAdult(). */
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

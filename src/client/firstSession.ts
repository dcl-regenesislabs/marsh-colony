// Custom first session — the guided first visit that walks a brand-new player
// from adopting their first pet to hatching their first hybrid
// (dev-docs/first-session-tutorial.md, plan in
// dev-docs/first-session-implementation-plan.md).
//
// It is NOT a resumable tutorial: it only runs during the very first visit
// (the server sets PlayerSnapshot.firstSession), and the next visit is the
// normal game wherever this one stopped. Every hook this module adds to the
// game must go through firstSessionActive(), which is false for every
// returning player — so for them the game behaves exactly as before.
//
// The Caretaker is the only voice that teaches. In person he uses the normal
// dialog; between those moments his current instruction rides a one-line
// objective bar on the HUD (FirstSessionBar in ui.tsx), with nudges that
// escalate the longer the player sits on it (see NUDGE_*).

import { engine, Transform } from '@dcl/sdk/ecs'
import { clientState, actions } from './state'
import { PLAY_MIN_ENERGY } from '../shared/config'
import { showArrowTo, hideArrow, getLocalPet, getEggPending } from './pet'
import { objectPosition } from './objects'
import { EntityNames } from '../../assets/scene/entity-names'
import { dailyClaimable } from './sim'
import { slotPrice } from '../shared/config'

export function firstSessionActive(): boolean {
  return clientState.firstSession
}

// ---------------------------------------------------------------------------
// Steps. Client-only and never saved: they just follow what the player does.
// ---------------------------------------------------------------------------
export type FirstSessionStep =
  | 'intro' // Caretaker intro → adopt → carry the egg → hatch → keep (existing flow)
  | 'meet' // breathing beat: the pet greets you, nothing asked
  | 'feed' // "Feed your pet": tap it, choose Feed
  | 'feeding' // the Feed errand / minigame owns the screen; the first round ends with poison
  | 'sick' // sickness arc: Caretaker, Care Center, Pepito, rock throw, cure (existing flows guide it)
  | 'cured' // breathing beat: the cured pet dances (cureCelebration), nothing asked
  | 'bath' // chapter 3 starts: the chase left it muddy
  | 'play' // fetch until it is worn out (the server tires it if the player stalls)
  | 'rest' // let it sleep on the bed
  | 'slot' // chapter 4: while it naps, unlock slot 2 in My Pets
  | 'adopt2' // go to the Caretaker and adopt a second egg
  | 'hatch2' // collect the egg, carry it home, hatch, keep (existing flows guide it)
  | 'freeTime' // ~30 s to enjoy the new pet (the meteor gets a mention if it is down)
  | 'switch' // chapter 5 starts (Phase 6 continues here)

/** Chapter shown on the bar ("Chapter 1/6"), per step. */
const CHAPTER: Record<FirstSessionStep, number> = {
  intro: 1,
  meet: 1,
  feed: 2,
  feeding: 2,
  sick: 2,
  cured: 2,
  bath: 3,
  play: 3,
  rest: 3,
  slot: 4,
  adopt2: 4,
  hatch2: 4,
  freeTime: 4,
  switch: 5
}
export const FIRST_SESSION_CHAPTERS = 6

/** What the Caretaker asks for while the step is waiting on the player. */
const OBJECTIVE: Partial<Record<FirstSessionStep, string>> = {
  feed: 'Your pet is hungry! Tap it and choose Feed.',
  bath: "It's covered in mud from the chase! Tap it and choose Bath.",
  play: "It's feeling better. Let's play! Tap it and choose Play.",
  rest: "It's worn out. Let it rest on the bed. Tap it and choose Sleep.",
  adopt2: 'Your new slot is ready. Come see me and adopt a second egg!',
  switch: 'Open My Pets and pick your first pet again. I have something for it!'
}

/** Objectives whose wording depends on the moment. */
function objectiveFor(s: FirstSessionStep): string {
  const p = clientState.player
  if (s === 'slot' && p) {
    const price = slotPrice(p.petSlots)
    return p.currency >= price
      ? 'While it naps, open My Pets and unlock a new slot.'
      : `A new slot costs ${price} coins. Yours are piling up while your pet is happy!`
  }
  if (s === 'freeTime') {
    return dailyClaimable() ? 'A meteor fell nearby! Go take a look while they get to know each other.' : ''
  }
  return OBJECTIVE[s] ?? ''
}

/** Free time with the new pet before the Caretaker calls you back. */
const FREE_TIME_SECONDS = 30

/** The pet-panel button each step asks for (arrow to the pet, then this pulses). */
export type FirstSessionPulse = 'feed' | 'bath' | 'play' | 'sleep' | 'myPets'
const BUTTON: Partial<Record<FirstSessionStep, FirstSessionPulse>> = {
  feed: 'feed',
  bath: 'bath',
  play: 'play',
  rest: 'sleep',
  slot: 'myPets',
  switch: 'myPets'
}
/** Steps whose UI target pulses as soon as the objective is up (no pet to point at). */
const PULSE_AT_ONCE: Partial<Record<FirstSessionStep, boolean>> = { slot: true, switch: true }
/** Steps that point the guide arrow at the Caretaker instead of the pet. */
const TO_CARETAKER: Partial<Record<FirstSessionStep, boolean>> = { adopt2: true }

/** Fetch rounds, or seconds, in 'play' before the server tires the pet itself. */
const PLAY_FALLBACK_ROUNDS = 4
const PLAY_FALLBACK_SECONDS = 120

/** Breathing room after a reward before the next instruction shows up. */
const BREATHE_SECONDS = 10

// Escalating nudges, counted from when the objective appears (which is itself
// after the breathing beat, so these land at ~10 / 25 / 60 s of the spec).
/** Point at the target: the guide arrow, or a pulse on the right button. */
const NUDGE_POINT_SECONDS = 15
/** The Caretaker repeats himself: the bar throbs and his line comes back as a toast. */
const NUDGE_REPEAT_SECONDS = 50

// ---------------------------------------------------------------------------
// State read by the UI
// ---------------------------------------------------------------------------
export const firstSessionHud = {
  /** Objective line, or '' when the bar should be hidden. */
  text: '',
  chapter: 1,
  /** Seconds the current objective has been up (drives the fade-in). */
  shownFor: 0,
  /** The Caretaker is repeating himself: the bar throbs. */
  emphasize: false,
  /** Pet-panel button to pulse, if any. */
  pulse: null as FirstSessionPulse | null
}

let step: FirstSessionStep = 'intro'
/** The first Feed round's forced poison has been handed out (once per visit). */
let poisonTaken = false
/** Seconds the Feed flow has been over while still in 'feeding'. */
let feedOverFor = 0

/** First session only, once: the Feed round being submitted must end with the
 *  pet poisoned (fruitGame.ts). Returns false for everyone else. */
export function takeFirstSessionPoison(): boolean {
  if (!firstSessionActive() || poisonTaken) return false
  poisonTaken = true
  return true
}
/** Counter values when the current step started, to spot the new action. */
let bathsAtStart = 0
let playsAtStart = 0
/** Seconds spent in 'play'; and whether the tire fallback was already asked for. */
let playTime = 0
/** Seconds of free time left. */
let freeLeft = 0
let tireAsked = false
let breatheLeft = 0
let objectiveTime = 0
let repeated = false
let arrowUp = false

export function firstSessionStep(): FirstSessionStep {
  return step
}

function goTo(next: FirstSessionStep, breathe = 0): void {
  step = next
  breatheLeft = breathe
  resetNudges()
  const c = clientState.player?.counters ?? {}
  bathsAtStart = c['bathCount'] ?? 0
  playsAtStart = c['playCount'] ?? 0
  playTime = 0
  // TODO(analytics): report `first_session_step` to PostHog here.
  console.log('[FirstSession] step ->', next)
}

/** Any progress on the objective restarts the nudge ladder. */
function resetNudges(): void {
  objectiveTime = 0
  repeated = false
  setArrow(false)
}

function setArrow(on: boolean): void {
  if (on === arrowUp) return
  arrowUp = on
  clientState.firstSessionArrow = on
  if (!on) hideArrow('firstSession')
}

// ---------------------------------------------------------------------------
// Step transitions — each one watches the real game state, nothing is faked.
// ---------------------------------------------------------------------------
let lastPanelOpen = false

function advance(dt: number): void {
  const p = clientState.player
  switch (step) {
    case 'intro':
      // The first pet has been kept: it is in the roster and nothing is pending.
      if (p && p.pets.length > 0 && !p.hatchling && clientState.activePet && !clientState.hatch.active) {
        goTo('meet', BREATHE_SECONDS)
      }
      return
    case 'meet':
      if (breatheLeft <= 0) goTo('feed')
      return
    case 'feed':
      if (clientState.feedTask.active || clientState.feedGame.active) goTo('feeding')
      return
    case 'feeding': {
      if (clientState.activePet?.sick) {
        goTo('sick')
        return
      }
      // The round is over but no sickness came back (e.g. nothing caught, so
      // nothing was eaten): don't strand the player, move on to chapter 3.
      const feedOver = !clientState.feedTask.active && !clientState.feedGame.active
      feedOverFor = feedOver ? feedOverFor + dt : 0
      if (feedOver && feedOverFor > 3 && !clientState.sicknessErrand.active) goTo('bath', BREATHE_SECONDS)
      return
    }
    case 'sick':
      // Cured: the server cleared the flag (the dance and the gift come with it).
      if (clientState.activePet && !clientState.activePet.sick && !clientState.sicknessErrand.active && !clientState.dialog.open) {
        goTo('cured', BREATHE_SECONDS)
      }
      return
    case 'cured':
      if (breatheLeft <= 0) goTo('bath')
      return
    case 'bath':
      if ((p?.counters['bathCount'] ?? 0) > bathsAtStart) goTo('play', 6)
      return
    case 'play': {
      const pet = clientState.activePet
      if (pet && pet.energy < PLAY_MIN_ENERGY) {
        goTo('rest')
        return
      }
      if (breatheLeft <= 0) playTime += dt
      const rounds = (p?.counters['playCount'] ?? 0) - playsAtStart
      // Fallback: it has played enough (or the player stalls). The server takes
      // its energy down once, then the step above moves on to 'rest'.
      if (!tireAsked && !clientState.fetch.active && (rounds >= PLAY_FALLBACK_ROUNDS || playTime >= PLAY_FALLBACK_SECONDS)) {
        tireAsked = true
        actions.firstSessionTire()
      }
      return
    }
    case 'rest':
      if (clientState.activePet?.sleeping) goTo('slot', BREATHE_SECONDS)
      return
    case 'slot':
      if (p && p.pets.length < p.petSlots) goTo('adopt2')
      return
    case 'adopt2':
      // Adopt! confirmed: the existing pickup/carry/hatch flows take it from here.
      if (getEggPending() || clientState.carryEgg.active || p?.hatchling) goTo('hatch2')
      return
    case 'hatch2': {
      if (!p) return
      const eggFlow = getEggPending() || clientState.carryEgg.active || clientState.hatch.active || !!p.hatchling
      if (eggFlow) return
      if (p.pets.length >= 2) {
        freeLeft = FREE_TIME_SECONDS
        goTo('freeTime', BREATHE_SECONDS)
      } else if (p.pets.length < p.petSlots) {
        goTo('adopt2') // cancelled or discarded: the slot is still free, adopt again
      }
      return
    }
    case 'freeTime':
      if (breatheLeft <= 0 && !clientState.fetch.active) freeLeft -= dt
      if (freeLeft <= 0) goTo('switch')
      return
    case 'switch':
      return
  }
}

function firstSessionSystem(dt: number): void {
  if (!firstSessionActive()) return
  if (breatheLeft > 0) breatheLeft -= dt
  advance(dt)

  const objective = breatheLeft > 0 ? '' : objectiveFor(step)
  // The Caretaker talking in person, or a panel taking the screen, pauses the clock.
  const paused = clientState.dialog.open || clientState.fetch.active
  if (objective && !paused) objectiveTime += dt

  // Opening the pet panel is progress toward "choose Feed": restart the ladder
  // so the pulse moves from the pet (arrow) to the button.
  const panelOpen = clientState.petPanelOpen
  if (panelOpen !== lastPanelOpen) {
    lastPanelOpen = panelOpen
    if (objective) resetNudges()
  }

  firstSessionHud.text = objective
  firstSessionHud.chapter = CHAPTER[step]
  firstSessionHud.shownFor = objectiveTime
  firstSessionHud.emphasize = !!objective && objectiveTime >= NUDGE_REPEAT_SECONDS
  const button = objective ? BUTTON[step] : undefined
  const due = objectiveTime >= NUDGE_POINT_SECONDS
  if (button === 'myPets') {
    // A HUD target, nothing in the world: pulse My Pets (and its Unlock card) right away.
    firstSessionHud.pulse = PULSE_AT_ONCE[step] || due ? button : null
    setArrow(false)
  } else if (objective && TO_CARETAKER[step]) {
    firstSessionHud.pulse = null
    setArrow(due)
    if (due) showArrowTo(objectPosition(EntityNames.Caretaker_glb), 'firstSession')
  } else {
    firstSessionHud.pulse = button && due && panelOpen ? button : null
    // Point at the pet until its panel is open; the step's button pulses after that.
    const wantArrow = !!button && due && !panelOpen
    setArrow(wantArrow)
    if (wantArrow) {
      const pet = getLocalPet()
      if (pet !== null && Transform.has(pet)) showArrowTo(Transform.get(pet).position, 'firstSession')
    }
  }

  if (objective && step !== 'freeTime' && !repeated && objectiveTime >= NUDGE_REPEAT_SECONDS) {
    repeated = true
    clientState.toasts.push({ message: `Caretaker: ${objective}`, kind: 'info' })
  }
}

export function setupFirstSession(): void {
  engine.addSystem(firstSessionSystem, undefined, 'first-session')
}

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
import { showArrowTo, hideArrow, getLocalPet } from './pet'

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
  | 'egg2' // chapter 4: a second egg (Phase 5 continues here)

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
  egg2: 4
}
export const FIRST_SESSION_CHAPTERS = 6

/** What the Caretaker asks for while the step is waiting on the player. */
const OBJECTIVE: Partial<Record<FirstSessionStep, string>> = {
  feed: 'Your pet is hungry! Tap it and choose Feed.',
  bath: "It's covered in mud from the chase! Tap it and choose Bath.",
  play: "It's feeling better. Let's play! Tap it and choose Play.",
  rest: "It's worn out. Let it rest on the bed. Tap it and choose Sleep.",
  egg2: 'While it naps, open My Pets and buy a new slot. Then come see me for a second egg.'
}

/** The pet-panel button each step asks for (arrow to the pet, then this pulses). */
export type FirstSessionPulse = 'feed' | 'bath' | 'play' | 'sleep'
const BUTTON: Partial<Record<FirstSessionStep, FirstSessionPulse>> = {
  feed: 'feed',
  bath: 'bath',
  play: 'play',
  rest: 'sleep'
}

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
      if (clientState.activePet?.sleeping) goTo('egg2', BREATHE_SECONDS)
      return
    case 'egg2':
      return
  }
}

function firstSessionSystem(dt: number): void {
  if (!firstSessionActive()) return
  if (breatheLeft > 0) breatheLeft -= dt
  advance(dt)

  const objective = breatheLeft > 0 ? '' : OBJECTIVE[step] ?? ''
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
  const pointing = !!button && objectiveTime >= NUDGE_POINT_SECONDS
  firstSessionHud.pulse = pointing && panelOpen ? button! : null

  // Point at the pet until its panel is open; the step's button pulses after that.
  const wantArrow = pointing && !panelOpen
  setArrow(wantArrow)
  if (wantArrow) {
    const pet = getLocalPet()
    if (pet !== null && Transform.has(pet)) showArrowTo(Transform.get(pet).position, 'firstSession')
  }

  if (objective && !repeated && objectiveTime >= NUDGE_REPEAT_SECONDS) {
    repeated = true
    clientState.toasts.push({ message: `Caretaker: ${objective}`, kind: 'info' })
  }
}

export function setupFirstSession(): void {
  engine.addSystem(firstSessionSystem, undefined, 'first-session')
}

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
import { clientState } from './state'
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
  | 'feeding' // the Feed errand / minigame owns the screen (Phase 3 continues here)

/** Chapter shown on the bar ("Chapter 1/6"), per step. */
const CHAPTER: Record<FirstSessionStep, number> = {
  intro: 1,
  meet: 1,
  feed: 2,
  feeding: 2
}
export const FIRST_SESSION_CHAPTERS = 6

/** What the Caretaker asks for while the step is waiting on the player. */
const OBJECTIVE: Partial<Record<FirstSessionStep, string>> = {
  feed: 'Your pet is hungry! Tap it and choose Feed.'
}

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
  /** Pulse the Feed button in the pet panel. */
  pulseFeed: false
}

let step: FirstSessionStep = 'intro'
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

function advance(): void {
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
    case 'feeding':
      return
  }
}

function firstSessionSystem(dt: number): void {
  if (!firstSessionActive()) return
  if (breatheLeft > 0) breatheLeft -= dt
  advance()

  const objective = breatheLeft > 0 ? '' : OBJECTIVE[step] ?? ''
  // The Caretaker talking in person, or a panel taking the screen, pauses the clock.
  const paused = clientState.dialog.open
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
  firstSessionHud.pulseFeed = step === 'feed' && panelOpen && objectiveTime >= NUDGE_POINT_SECONDS

  // Point at the pet until its panel is open; the Feed button pulses after that.
  const wantArrow = step === 'feed' && !panelOpen && objectiveTime >= NUDGE_POINT_SECONDS
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

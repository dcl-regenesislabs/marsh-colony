// First-pet guided tutorial (issue #243, Phase 1 of #249's broader onboarding
// vision — see the plan). Runs once, only for a player's first-ever pet,
// picked up right after keepHatchling(): the server flips
// player.tutorialStep from -1 to 0 in keepPet() (server/state.ts), and this
// module's system notices and drives the rest client-side.
//
// One step at a time, sequential: the pet states a need (petSay), the
// matching PetPanel care button pulses, the player taps it (or reaches the
// same action via a world hotspot — see isStepDone's phase-independent
// completion below), the pet confirms, and once the underlying minigame/care
// action actually completes the tutorial advances to the next step.
//
// A freshly-kept pet's hygiene/energy/happiness sit far above
// PET_SPEECH_NEED_THRESHOLD for the whole session (NEW_PET_STATS + the slow
// DECAY_PER_SEC rates), so Dirty/Sad/Tired never occur organically here —
// every step's need line and highlight fire regardless of the pet's real
// stat state. This is a scripted sequence, not the organic nagger.

import { engine } from '@dcl/sdk/ecs'
import * as C from '../shared/config'
import { actions, clientState } from './state'
import { petSay, hidePetSpeech } from './speech'
import { setBathExitListener } from './bathGame'

export type TutorialStepId = 'feed' | 'bathe' | 'play' | 'sleep'

interface TutorialStep {
  id: TutorialStepId
  needLine: string
  highlightButtonId: string
  confirmLine: string
}

function needLineFor(id: string): string {
  return C.PET_SPEECH_LINES.find((l) => l.id === id)?.text ?? ''
}

// confirmLine copy: #243 only gives verbatim text for Feed. The other three
// are placeholder copy in the same voice, pending a content pass — not a
// mechanism blocker.
const TUTORIAL_STEPS: TutorialStep[] = [
  { id: 'feed', needLine: needLineFor('hungry'), highlightButtonId: 'care_feed', confirmLine: 'Go to the tree to get me some food!' },
  { id: 'bathe', needLine: needLineFor('dirty'), highlightButtonId: 'care_bath', confirmLine: "Ooh, let's go get clean!" },
  { id: 'play', needLine: needLineFor('bored'), highlightButtonId: 'care_play', confirmLine: "Let's play fetch!" },
  { id: 'sleep', needLine: needLineFor('sleepy'), highlightButtonId: 'care_sleep', confirmLine: 'Tuck me in!' }
]
const TUTORIAL_HOLD_SECONDS = 9999 // scripted line: waits on the player, not a timer

/** PetPanel (ui.tsx) reads this to decide which care button (if any) pulses. */
export function tutorialHighlightId(): string | null {
  if (!clientState.tutorial.active) return null
  return TUTORIAL_STEPS[clientState.tutorial.stepIndex]?.highlightButtonId ?? null
}

function enterStep(index: number): void {
  const step = TUTORIAL_STEPS[index]
  if (!step) return
  clientState.tutorial = { active: true, stepIndex: index, phase: 'need' }
  clientState.petPanelOpen = true // the highlighted button has to actually be on screen
  resetEdgeTrackers()
  petSay(step.needLine, TUTORIAL_HOLD_SECONDS)
}

/** Called from each care button's onClick in ui.tsx, right after its own
 *  action. No-ops outside the matching step/phase. */
export function tutorialNotifyAction(stepId: TutorialStepId): void {
  const t = clientState.tutorial
  if (!t.active || t.phase !== 'need') return
  const step = TUTORIAL_STEPS[t.stepIndex]
  if (!step || step.id !== stepId) return
  t.phase = 'action'
  petSay(step.confirmLine, TUTORIAL_HOLD_SECONDS)
}

// ---------------------------------------------------------------------------
// Completion — edge-detects the real signal each minigame/care action already
// exposes when it finishes. Runs independent of `phase`: a player who
// triggers the action via a world hotspot (PetFeeder_glb/PetBed_glb, wired in
// input.ts) instead of the pulsing panel button still completes the step —
// just without seeing the confirm line — rather than soft-locking.
// ---------------------------------------------------------------------------
let prevFeedGameActive = false
let prevFetchBusy = false
let prevSleeping = false
let bathJustFinished = false

function resetEdgeTrackers(): void {
  prevFeedGameActive = clientState.feedGame.active
  prevFetchBusy = clientState.fetch.busy
  prevSleeping = !!clientState.activePet?.sleeping
  bathJustFinished = false
}

function isStepDone(id: TutorialStepId): boolean {
  switch (id) {
    case 'feed': {
      const done = prevFeedGameActive && !clientState.feedGame.active
      prevFeedGameActive = clientState.feedGame.active
      return done
    }
    case 'bathe': {
      if (!bathJustFinished) return false
      bathJustFinished = false
      return true
    }
    case 'play': {
      const done = prevFetchBusy && !clientState.fetch.busy
      prevFetchBusy = clientState.fetch.busy
      return done
    }
    case 'sleep': {
      const nowSleeping = !!clientState.activePet?.sleeping
      const done = !prevSleeping && nowSleeping
      prevSleeping = nowSleeping
      return done
    }
  }
}

function completeStep(): void {
  const finished = clientState.tutorial.stepIndex
  actions.tutorialStepDone(finished) // optimistic — same pattern as every other care action
  const next = finished + 1
  if (next >= TUTORIAL_STEPS.length) {
    clientState.tutorial.active = false
    hidePetSpeech()
    return
  }
  enterStep(next)
}

function tick(): void {
  const serverStep = clientState.player?.tutorialStep ?? -1
  // Pickup covers BOTH the fresh-start case (server just flipped -1 -> 0) and
  // reconnect-mid-tutorial (a snapshot arrives with e.g. tutorialStep === 2) —
  // same path, resuming at the step boundary (not sub-phase; see the plan).
  if (!clientState.tutorial.active && serverStep >= 0 && serverStep < TUTORIAL_STEPS.length) {
    enterStep(serverStep)
  }
  if (!clientState.tutorial.active) return
  const step = TUTORIAL_STEPS[clientState.tutorial.stepIndex]
  if (step && isStepDone(step.id)) completeStep()
}

export function setupTutorial(): void {
  setBathExitListener(() => {
    bathJustFinished = true
  })
  engine.addSystem(tick)
}

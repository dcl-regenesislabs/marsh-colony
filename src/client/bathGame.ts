// Bubble-Bath minigame (PROTOTYPE). When the pet is placed in the tub
// (pet.ts placePetAtStation), a swarm of light-blue bubbles rises up the screen
// at irregular speeds and drifts sideways; the player pops them by tapping. Pop
// enough within the time limit and the pet counts as clean.
//
// UI-only: the bubbles are react-ecs circles drawn by BathGameOverlay (ui.tsx),
// which reads the bubble list (getBubbles) + clientState.bathGame that this
// module's tick() mutates each frame. Mirrors the feed minigame's phase machine
// (fruitGame.ts) but without the 3D fruit pool — no cinematic camera, no input
// lock (kept intentionally simple for the prototype).

import { engine } from '@dcl/sdk/ecs'
import { actions, clientState, pushToast } from './state'
import { applyCareLocal } from './sim'
import { finishBath } from './pet'

export const BATH_DURATION_S = 16 // seconds of the timed popping phase
export const BUBBLE_GOAL = 12 // pops needed for the pet to count as clean
export const BATH_COUNTDOWN_S = 3 // 3-2-1 before popping starts
const MAX_BUBBLES = 9 // bubbles alive on screen at once
const SPAWN_STAGGER_S = 0.22 // min gap between spawns so they don't appear in clumps
export const BUBBLE_POP_FRAMES = 6 // frames in the pop-splash sprite sheet (one horizontal row)
export const BUBBLE_POP_MS = 340 // total pop-splash duration (~57 ms/frame)

export interface Bubble {
  id: number
  x: number // 0..1 screen-width fraction (center); updated each frame from the wobble
  y: number // 0..1 screen-height fraction (center); 1 = bottom, rises toward 0
  r: number // radius, virtual px (pre-S)
  baseX: number // wobble centre
  speed: number // upward fraction/sec (varied per bubble)
  wobbleAmp: number // horizontal drift amplitude (fraction)
  wobbleFreq: number // drift rate (rad/sec)
  wobblePhase: number
}

/** A transient pop-splash at a popped bubble's spot, animated through the sprite sheet. */
export interface PopFx {
  id: number
  x: number // 0..1 screen fraction (center), captured from the bubble when it popped
  y: number
  r: number // the popped bubble's radius (pre-S) — sizes the splash
  startAt: number // Date.now() ms
}

type Phase = 'idle' | 'intro' | 'countdown' | 'popping' | 'results'
let phase: Phase = 'idle'
let clock = 0
let spawnAcc = 0
let nextId = 1
let bubbles: Bubble[] = []
let pops: PopFx[] = []

/** The live bubble list, read by BathGameOverlay each render. */
export function getBubbles(): Bubble[] {
  return bubbles
}

/** Active pop-splash effects, read by BathGameOverlay each render. */
export function getPops(): PopFx[] {
  return pops
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo)
}

/** (Re)randomise a bubble's motion and park it just below the bottom edge. Keeps
 *  the same id so react-ecs keys stay stable across a recycle/pop. */
function resetBubble(b: Bubble): void {
  b.baseX = rand(0.12, 0.88)
  b.x = b.baseX
  b.y = rand(1.05, 1.28) // staggered starts below the screen
  b.r = rand(30, 56) // varied sizes
  b.speed = rand(0.1, 0.28) // varied rise speed -> crosses in ~4-10s
  b.wobbleAmp = rand(0.02, 0.09)
  b.wobbleFreq = rand(1.4, 4.2)
  b.wobblePhase = rand(0, Math.PI * 2)
}

function makeBubble(): Bubble {
  const b: Bubble = { id: nextId++, x: 0, y: 0, r: 0, baseX: 0, speed: 0, wobbleAmp: 0, wobbleFreq: 0, wobblePhase: 0 }
  resetBubble(b)
  return b
}

/** Launch the bath minigame — called after the pet is placed in the tub. */
export function startBathGame(): void {
  if (phase !== 'idle') return
  bubbles = []
  pops = []
  spawnAcc = 0
  clock = 0
  clientState.bathGame = { active: true, phase: 'intro', popped: 0, timeLeft: BATH_DURATION_S, popFlashUntil: 0, countdownAt: 0, resultsAt: 0 }
  phase = 'intro'
  for (let i = 0; i < 5; i++) bubbles.push(makeBubble()) // a few already drifting behind the intro
}

/** Start button -> 3-2-1 countdown, then the timed popping phase. */
export function startBathCountdown(): void {
  if (phase !== 'intro') return
  phase = 'countdown'
  clientState.bathGame.phase = 'countdown'
  clientState.bathGame.countdownAt = Date.now()
}

function beginPopping(): void {
  phase = 'popping'
  clientState.bathGame.phase = 'popping'
  clientState.bathGame.timeLeft = BATH_DURATION_S
}

/** Pop a bubble (overlay onMouseDown). Scores it and sends a fresh one up. */
export function popBubble(id: number): void {
  if (phase !== 'popping') return
  const b = bubbles.find((x) => x.id === id)
  if (!b) return
  pops.push({ id: nextId++, x: b.x, y: b.y, r: b.r, startAt: Date.now() }) // splash where it burst
  resetBubble(b) // burst -> a new bubble rises in its place
  clientState.bathGame.popped += 1
  clientState.bathGame.popFlashUntil = Date.now() + 300
  if (clientState.bathGame.popped >= BUBBLE_GOAL) applyBathResults() // clean early -> straight to results
}

function applyBathResults(): void {
  if (phase === 'results' || phase === 'idle') return
  phase = 'results'
  clientState.bathGame.phase = 'results'
  clientState.bathGame.resultsAt = Date.now()
  bubbles = []
  // Only a clean-enough scrub actually bathes the pet. Gate the server call on the
  // optimistic mirror accepting it (energy/lock rules) so we never tell the server
  // to clean when our own sim just refused — matches input.ts's care path.
  if (clientState.bathGame.popped >= BUBBLE_GOAL && applyCareLocal('clean', false)) {
    actions.care('clean', false) // server is authoritative
  }
}

/** Results "Done/Close" button — leave the minigame. */
export function exitBathResults(): void {
  clientState.bathGame.active = false
  phase = 'idle'
  bubbles = []
  pops = []
  // Play the win splash + hop-out only if the pet actually came out clean.
  finishBath(clientState.bathGame.popped >= BUBBLE_GOAL)
}

/** BACK button — bail out mid-game (no clean applied). */
export function cancelBathGame(): void {
  if (phase === 'idle') return
  clientState.bathGame.active = false
  phase = 'idle'
  bubbles = []
  pops = []
  pushToast('Bath cancelled') // BACK: acknowledge like every other step of the carry flow
}

function tick(dt: number): void {
  const now = Date.now()
  if (pops.length) pops = pops.filter((p) => now - p.startAt < BUBBLE_POP_MS) // retire finished splashes
  if (phase === 'idle') return
  clock += dt
  const st = clientState.bathGame

  if (phase === 'countdown' && Date.now() - st.countdownAt >= BATH_COUNTDOWN_S * 1000) beginPopping()

  if (phase === 'popping') {
    st.timeLeft -= dt
    if (st.timeLeft <= 0) {
      st.timeLeft = 0
      applyBathResults()
      return
    }
  }

  // Bubbles drift/rise during intro, countdown and popping (ambient before, live during).
  if (phase !== 'results') {
    spawnAcc += dt
    if (bubbles.length < MAX_BUBBLES && spawnAcc >= SPAWN_STAGGER_S) {
      spawnAcc = 0
      bubbles.push(makeBubble())
    }
    for (const b of bubbles) {
      b.y -= b.speed * dt
      b.x = Math.max(0.05, Math.min(0.95, b.baseX + b.wobbleAmp * Math.sin(clock * b.wobbleFreq + b.wobblePhase)))
      if (b.y < -0.12) resetBubble(b) // slipped past the top unpopped — recycle from the bottom (no penalty)
    }
  }
}

/** Register the per-frame bath tick. Self-gates on phase, like the feed game. */
export function setupBathGame(): void {
  engine.addSystem(tick)
}

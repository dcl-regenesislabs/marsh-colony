// World-space speech bubble for the pet ("globito de diálogo").
//
// Why 3D and not a UI panel: the bubble has to LOOK like it comes out of the
// pet — it follows the pet's head, has a tail pointing down at it, and stays
// legible from any angle because the root billboards toward the camera.
//
// Layout is computed here, not by the renderer: the text is word-wrapped by us
// into lines, each line is measured with a per-character width table, and the
// panel is sized from that measurement + padding. That's what guarantees the
// text is centered and never spills outside the bubble — the bubble is built
// AROUND the text instead of hoping the text fits a fixed box.
//
// Mobile: the bubble is scaled up (small screen, thumb-distance viewing) and it
// also grows with camera distance so it keeps roughly the same on-screen size
// whether you're standing next to the pet or across the plaza.

import {
  engine,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
  Billboard,
  BillboardMode,
  MeshRenderer,
  Material
} from '@dcl/sdk/ecs'
import { Vector3, Color4 } from '@dcl/sdk/math'
import * as C from '../shared/config'
import type { PetData, StatKey } from '../shared/types'
import { clientState } from './state'
import { getLocalPet, isBusy, petIsPresent, suppressPetTags } from './pet'
import { petOverheadTuning } from './petOverheadCalibration'
import { mobile } from './ui/theme'

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------
// TextShape's fontSize is ~10 units per world metre of line height (the pet name
// tag in pet.ts uses 2.2 next to 0.22 m icons and matches them). The per-character
// widths below are calibrated against the same ratio the official NPC toolkit
// bubbles use (~0.057 m per character at fontSize 1). Everything is in world
// metres at scale 1; the root's scale then handles distance + mobile.
const M_PER_FONT = 0.1
const FONT_SIZE = 1.8
const LINE_H = FONT_SIZE * M_PER_FONT * 1.22
/** Text is wrapped to at most this wide; the bubble grows around whatever fits. */
const MAX_TEXT_W = 1.6
const MIN_TEXT_W = 0.6

// Custom cloud bubble art (hand-drawn: scalloped outline + a tail at the bottom,
// white opaque interior on transparent). Organic edges rule out 9-slicing, so it
// renders as ONE stretched plane — clouds tolerate stretch well, and the tail is
// baked in (no separate tail planes anymore).
const BUBBLE_SRC = 'assets/images/bubble.png'
// The writable belly is only part of the PNG's bounding box: the scalloped rim
// eats the sides, and the tail eats the bottom. Grow the plane so the wrapped
// text fits INSIDE that belly, and lift the text up so it clears the tail.
const INTERIOR_W = 0.6 // text width uses ~60% of the plane width
const INTERIOR_H = 0.46 // text height uses ~46% of the plane height
const TEXT_RISE = 0.1 // lift the text this fraction of the plane height (clear the tail)
const MIN_PLANE_W = 1.0
const MIN_PLANE_H = 0.9

// Depth order: the camera sits on the -Z side of a billboarded entity, so a
// smaller z is closer to the viewer. The cloud sits behind the text.
const Z_BODY = 0.02
const Z_TEXT = -0.05

const COL_TEXT = Color4.create(0.18, 0.14, 0.12, 1)

// Pop animation + how the bubble sits above the pet.
const IN_TIME = 0.22
const OUT_TIME = 0.14
/** Clearance above the pet's origin before the tail tip (mirrors pet.ts's tag height). */
const HEAD_CLEAR = 0.35
const HEAD_SIZE_MULT = 1.85
/** Extra lift so the bubble clears the name tag + mood icons on a real pet. */
const TAG_CLEAR = 0.5
/**
 * What the bubble does about the pet's own indicators (name + mood icons), which
 * live in the same airspace above its head.
 *
 * true  — hide them while a line is on screen and restore them after, so the
 *         bubble takes their place instead of stacking on top of them.
 * false — leave them up and clear them by TAG_CLEAR, i.e. bubble above tag.
 *
 * Hiding is why TAG_CLEAR drops out of the position below while this is true:
 * with the tag gone there's nothing left to clear, and keeping the offset would
 * float the bubble over an empty gap.
 */
const HIDE_TAG_WHILE_SPEAKING = true
/** Screen-size compensation: at this distance the bubble renders at base size. */
const REF_DISTANCE = 6
const MAX_DISTANCE_SCALE = 1.8
const MOBILE_SCALE = 1.35
// Horizontal placement. The bubble billboards (rotates to face the camera), so
// offsetting the ROOT in world-X only lines the tail up from one angle. Instead we
// slide the PLANE sideways in its OWN local X until the baked tail tip sits
// centered under the root (the pet's head) — then it points at the pet from every
// angle, with the cloud body floating off to that side. This fraction of the plane
// width, and the vertical nudge below, were dialed in live over a test bubble.
const bubbleXFrac = 0.284
// Extra vertical nudge (world metres, scaled with the bubble). Negative lowers it.
const bubbleYOffset = -0.7

// ---------------------------------------------------------------------------
// Text measuring / wrapping
// ---------------------------------------------------------------------------
/** Advance width of a character, as a fraction of the font size (sans-serif approximation). */
function charEm(c: string): number {
  if (c === ' ') return 0.3
  if ('iljI.,:;!|\'`'.indexOf(c) >= 0) return 0.3
  if ('ft()[]{}-"r'.indexOf(c) >= 0) return 0.37
  if ('mwMW@'.indexOf(c) >= 0) return 0.92
  if (c >= 'A' && c <= 'Z') return 0.66
  if (c >= '0' && c <= '9') return 0.58
  return 0.55
}

/** Width of a line in world metres. The 1.06 factor is headroom over the estimate. */
function measure(line: string): number {
  let em = 0
  for (const ch of line) em += charEm(ch)
  return em * FONT_SIZE * M_PER_FONT * 1.06
}

/** Split a single word that is wider than the budget on its own. */
function breakWord(word: string): string[] {
  const out: string[] = []
  let cur = ''
  for (const ch of word) {
    if (cur && measure(cur + ch) > MAX_TEXT_W) {
      out.push(cur)
      cur = ch
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

/** Greedy word wrap to MAX_TEXT_W. Returns the lines and the widest line's width. */
function wrap(text: string): { lines: string[]; width: number } {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const lines: string[] = []
  let cur = ''
  for (const word of words) {
    for (const piece of measure(word) > MAX_TEXT_W ? breakWord(word) : [word]) {
      const cand = cur ? `${cur} ${piece}` : piece
      if (cur && measure(cand) > MAX_TEXT_W) {
        lines.push(cur)
        cur = piece
      } else {
        cur = cand
      }
    }
  }
  if (cur) lines.push(cur)
  if (lines.length === 0) lines.push('')
  let width = MIN_TEXT_W
  for (const l of lines) width = Math.max(width, measure(l))
  return { lines, width: Math.min(width, MAX_TEXT_W) }
}

// ---------------------------------------------------------------------------
// Bubble entities
// ---------------------------------------------------------------------------
type Bubble = { root: Entity; img: Entity; label: Entity; w: number; h: number }

let bubble: Bubble | null = null

function ensureBubble(): Bubble {
  if (bubble) return bubble
  const root = engine.addEntity()
  Transform.create(root, { position: Vector3.create(0, -100, 0), scale: Vector3.Zero() })
  Billboard.create(root, { billboardMode: BillboardMode.BM_Y })

  // One textured plane IS the whole cloud (outline + white fill + tail, all in
  // the PNG). Basic (unlit) material so it stays bright/readable through the
  // scene's night cycle without depending on lighting; alphaTest keeps the
  // transparent scalloped border crisp.
  const img = engine.addEntity()
  Transform.create(img, { position: Vector3.create(0, 0, Z_BODY), parent: root })
  MeshRenderer.setPlane(img)
  Material.setBasicMaterial(img, {
    texture: Material.Texture.Common({ src: BUBBLE_SRC }),
    // The unlit material reads alpha from alphaTexture, NOT the color texture's
    // own alpha — without this the transparent PNG surround renders solid black.
    alphaTexture: Material.Texture.Common({ src: BUBBLE_SRC }),
    alphaTest: 0.5
  })

  const label = engine.addEntity()
  Transform.create(label, { position: Vector3.create(0, 0, Z_TEXT), parent: root })
  TextShape.create(label, {
    text: '',
    fontSize: FONT_SIZE,
    textColor: COL_TEXT,
    textAlign: TextAlignMode.TAM_MIDDLE_CENTER,
    // Wrapping is OFF on purpose: we already inserted the line breaks, and the
    // box is given slack so the renderer never re-wraps or clips our layout.
    textWrapping: false,
    width: 1,
    height: 1
  })

  bubble = { root, img, label, w: 1, h: 1 }
  return bubble
}

/** Resize every piece of the bubble around a freshly wrapped text. */
function layout(b: Bubble, text: string): void {
  const { lines, width } = wrap(text)
  const textW = width
  const textH = lines.length * LINE_H
  // Grow the cloud so the text fits inside the writable belly (the scalloped rim
  // and the tail take up the rest of the PNG's bounding box).
  const w = Math.max(textW / INTERIOR_W, MIN_PLANE_W)
  const h = Math.max(textH / INTERIOR_H, MIN_PLANE_H)
  b.w = w
  b.h = h
  Transform.getMutable(b.img).scale = Vector3.create(w, h, 1)

  const t = TextShape.getMutable(b.label)
  t.text = lines.join('\n')
  // Slack around the measured block: centered alignment keeps it on the origin.
  t.width = textW + 0.6
  t.height = textH + 0.4
  // Slide the cloud + its text sideways so the tail centers under the root, and
  // lift the text into the belly, clear of the tail baked into the PNG's bottom.
  reapplyX(b)
}

/** Position the cloud + text in the root's local X so the tail centers under it. */
function reapplyX(b: Bubble): void {
  Transform.getMutable(b.img).position = Vector3.create(bubbleXFrac * b.w, 0, Z_BODY)
  Transform.getMutable(b.label).position = Vector3.create(bubbleXFrac * b.w, b.h * TEXT_RISE, Z_TEXT)
}

// ---------------------------------------------------------------------------
// Show / hide state machine
// ---------------------------------------------------------------------------
type Phase = 'hidden' | 'in' | 'hold' | 'out'
let phase: Phase = 'hidden'
let phaseT = 0
let holdFor = 0
let pending: { text: string; seconds: number } | null = null

/** Ease-out-back, for the little pop when the bubble appears. */
function pop(x: number): number {
  const c = 1.9
  const p = x - 1
  return 1 + (c + 1) * p * p * p + c * p * p
}

/** Say something over the pet. Replaces whatever is showing. */
export function petSay(text: string, seconds = C.PET_SPEECH_HOLD_SECONDS): void {
  // The feed game owns the pet from the approach through its final eating shot.
  // Drop new requests here as well as hiding an already-visible bubble in update.
  if (clientState.feedGame.active) return
  pending = { text, seconds }
  if (phase === 'hidden') return
  phase = 'out' // let the current line pop away first
  phaseT = 0
}

/** Hide the bubble now (e.g. the pet went away). */
export function hidePetSpeech(): void {
  pending = null
  if (phase === 'hidden') return
  phase = 'out'
  phaseT = 0
}

/** True while a message is on screen (or animating in/out). */
export function isPetSpeaking(): boolean {
  return phase !== 'hidden' || pending !== null
}

/** Which pet the bubble hangs over, and how big it is. Null whenever there is
 *  nothing to speak from — no active pet, or one that's carried / still inside
 *  its egg, which is exactly when petIsPresent() goes false. */
function anchor(): { pos: Vector3; growthSize: number; renderScale: number; species: string; hasTag: boolean } | null {
  const pet = getLocalPet()
  const data = clientState.activePet
  if (pet === null || !data || !petIsPresent()) return null
  return {
    pos: Transform.get(pet).position,
    growthSize: data.size,
    renderScale: C.stageScaleFor(data.size) * C.scaleForSpecies(data.species),
    species: data.species,
    hasTag: true
  }
}

function cameraDistance(pos: Vector3): number {
  const cam = Transform.getOrNull(engine.CameraEntity)
  if (!cam) return REF_DISTANCE
  return Vector3.distance(cam.position, pos)
}

// Only touched on a change, not every frame — setTagVisible would be a no-op
// anyway, but this also keeps the call out of the hot path.
let tagsHidden = false
function hideTags(on: boolean): void {
  const want = on && HIDE_TAG_WHILE_SPEAKING
  if (want === tagsHidden) return
  tagsHidden = want
  suppressPetTags(want)
}

function update(dt: number): void {
  const b = ensureBubble()

  // A bubble can already be on screen when the feed minigame starts. Collapse it
  // immediately rather than letting its out animation overlap the cinematic.
  if (clientState.feedGame.active) {
    pending = null
    phase = 'hidden'
    phaseT = 0
    TextShape.getMutable(b.label).text = ''
    Transform.getMutable(b.root).scale = Vector3.Zero()
    hideTags(false)
    return
  }

  const a = anchor()

  // No pet to speak from — collapse instantly, don't leave a bubble floating.
  if (!a) {
    hideTags(false) // never strand a pet's indicators hidden
    if (phase !== 'hidden') {
      phase = 'hidden'
      TextShape.getMutable(b.label).text = ''
      Transform.getMutable(b.root).scale = Vector3.Zero()
    }
    return
  }

  phaseT += dt
  if (phase === 'hidden' && pending) {
    layout(b, pending.text)
    holdFor = pending.seconds
    pending = null
    phase = 'in'
    phaseT = 0
  } else if (phase === 'in' && phaseT >= IN_TIME) {
    phase = 'hold'
    phaseT = 0
  } else if (phase === 'hold' && phaseT >= holdFor) {
    phase = 'out'
    phaseT = 0
  } else if (phase === 'out' && phaseT >= OUT_TIME) {
    phase = 'hidden'
    phaseT = 0
    TextShape.getMutable(b.label).text = ''
  }

  if (phase === 'hidden') {
    hideTags(false) // line's gone — put the name and mood icons back
    Transform.getMutable(b.root).scale = Vector3.Zero()
    return
  }
  hideTags(true) // a line is up (or animating) — the bubble owns this space

  // Pop in / shrink out.
  let anim = 1
  if (phase === 'in') anim = pop(Math.min(1, phaseT / IN_TIME))
  else if (phase === 'out') anim = Math.max(0, 1 - phaseT / OUT_TIME)

  // Keep a roughly constant on-screen size, bigger on phones.
  const dist = cameraDistance(a.pos)
  const distScale = Math.max(1, Math.min(MAX_DISTANCE_SCALE, dist / REF_DISTANCE))
  const scale = (mobile() ? MOBILE_SCALE : 1) * distScale * anim

  // The tail tip (baked into the PNG's bottom edge) clears the pet's head — plus
  // its name tag, when that's still showing.
  const tune = petOverheadTuning(a.species, a.growthSize)
  const tagClear = a.hasTag && !HIDE_TAG_WHILE_SPEAKING ? TAG_CLEAR : 0
  const tailTip = a.pos.y + HEAD_CLEAR + HEAD_SIZE_MULT * a.renderScale + tune.nameLift + tagClear + tune.bubbleLift
  const t = Transform.getMutable(b.root)
  // Root sits exactly over the pet; the tail is centered under it by the local-X
  // slide in reapplyX(), so it points at the pet from any camera angle.
  t.position = Vector3.create(a.pos.x, tailTip + (b.h / 2 + bubbleYOffset) * scale, a.pos.z)
  t.scale = Vector3.create(scale, scale, scale)
}

// ---------------------------------------------------------------------------
// What the pet asks for
// ---------------------------------------------------------------------------
// The pet speaks because it NEEDS something, never on a timer: every stat below
// PET_SPEECH_NEED_THRESHOLD is a candidate and the lowest one wins, so the most
// urgent need is the one that gets voiced. Feeding it pushes hunger back over
// the line and the nagging stops on its own — no acknowledgement to wire up.

const NEED_LINE = new Map<string, C.PetSpeechLine>()
for (const line of C.PET_SPEECH_LINES) NEED_LINE.set(line.need, line)

const NEEDS: StatKey[] = ['hunger', 'hygiene', 'energy', 'happiness']

/** The line this pet most wants to say right now, or null if it's content. */
function neededLine(pet: PetData): C.PetSpeechLine | null {
  // Exhaustion outranks the lowest-stat rule. Once energy is under
  // PLAY_MIN_ENERGY the pet can't play at all, and sleep is the only thing that
  // fixes it, so "take me to bed" is the useful nudge even when (say) hunger
  // happens to be a few points lower. Everything else still resolves by
  // urgency below.
  if (pet.energy < C.PLAY_MIN_ENERGY) return C.PET_SPEECH_EXHAUSTED_LINE
  let worst: StatKey | null = null
  for (const k of NEEDS) {
    if (pet[k] > C.PET_SPEECH_NEED_THRESHOLD) continue
    if (worst === null || pet[k] < pet[worst]) worst = k
  }
  if (worst === null) return null
  return NEED_LINE.get(worst) ?? null
}

// Silence bookkeeping. `sinceLine` is time since the last line finished (the
// gap between messages); `saidAt` remembers when each id was last used so the
// same nag can't loop while a stat sits below the threshold.
let sinceLine = 0
let clock = 0
const saidAt = new Map<string, number>()

/**
 * Moments the pet keeps quiet through: a gesture or cinematic already owns the
 * screen (hatching, carrying the egg home, carrying the pet to the bath, the
 * petting overlay, Fetch), an NPC is talking, or the pet is already on its way
 * to do the very thing it would be asking for.
 */
function momentIsTaken(): boolean {
  return (
    clientState.hatch.active ||
    clientState.carryEgg.active ||
    clientState.carryPet.active ||
    clientState.petting.active ||
    clientState.fetch.active ||
    clientState.feedGame.active ||
    clientState.dialog.open ||
    isBusy()
  )
}

function driveSpeech(dt: number): void {
  clock += dt

  const pet = clientState.activePet
  // Nothing to say for a pet that isn't there, or one that's asleep — waking it
  // to complain about being sleepy would be its own kind of absurd.
  if (!pet || !petIsPresent() || pet.sleeping || momentIsTaken()) {
    sinceLine = 0
    return
  }

  // A hatchling the player hasn't accepted yet: the Keep/Discard modal owns this
  // beat. Staying quiet here is what makes the FIRST thing the pet ever says
  // land right after it's accepted — "I'm hungry", because NEW_PET_STATS starts
  // it below the threshold on purpose.
  const hatchlingId = clientState.player?.hatchling?.id
  if (hatchlingId !== undefined && pet.id === hatchlingId) {
    sinceLine = 0
    return
  }

  if (isPetSpeaking()) {
    sinceLine = 0 // the gap is silence AFTER a line, not time spent talking
    return
  }
  sinceLine += dt
  if (sinceLine < C.PET_SPEECH_GAP_SECONDS) return

  let line = neededLine(pet)
  if (line === null) {
    // Content pet: it only asks for attention, and rarely.
    if (C.PET_SPEECH_IDLE_SECONDS <= 0) return
    line = NEED_LINE.get('love') ?? null
    if (line === null) return
    if (clock - (saidAt.get(line.id) ?? -Infinity) < C.PET_SPEECH_IDLE_SECONDS) return
  } else if (clock - (saidAt.get(line.id) ?? -Infinity) < C.PET_SPEECH_REPEAT_SECONDS) {
    return
  }

  saidAt.set(line.id, clock)
  sinceLine = 0
  petSay(line.text)
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
export function setupPetSpeech(): void {
  ensureBubble()
  engine.addSystem((dt: number) => {
    update(dt)
    driveSpeech(dt)
  })
}

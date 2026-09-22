// Client-side pet rendering, follow / wander navigation, and animation.
// Pets are animated through LOGICAL clips: idle, walk, run, eat, dance,
// gesture-positive, gesture-negative, sleep. Each species maps those onto its
// own GLB clip names (config.clipForSpecies) — the aliens use the logical names
// verbatim, the Sprout family uses Sprout_Idle / Sprout_Walk / ... We pick idle
// when still, walk/run when moving, and a specific clip during care
// interactions. The pet is owned + animated locally for smooth feel;
// authoritative stats come from the server snapshot.

import {
  engine,
  Entity,
  Transform,
  GltfContainer,
  ColliderLayer,
  Animator,
  TextShape,
  Billboard,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  VisibilityComponent,
  pointerEventsSystem,
  inputSystem,
  InputAction,
  PlayerIdentityData,
  PrimaryPointerInfo,
  UiCanvasInformation,
  VirtualCamera,
  MainCamera,
  InputModifier,
  AvatarAttach,
  AvatarAnchorPointType
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'
import * as C from '../shared/config'
import {
  clipForSpecies,
  clipsForSpecies,
  modelForSpecies,
  petStage,
  scaleForSpecies,
  speciesLabel,
  stageScaleFor,
  yawOffsetForSpecies,
  type PetClip
} from '../shared/config'
import type { PetData } from '../shared/types'
import { clientState, actions, adoptPet, openDialog, pushToast, switchActivePet, showHint, hasPendingHatchling } from './state'
import { startBathGame } from './bathGame'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { objectPosition } from './objects'
import { navStepToward, zoneOf, nearWall, pointInsideAnyBuilding, nudgeOutsideBuildings } from './nav'
import { applyCreatureSkin } from './creatureSkins'
import { mobile } from './ui/theme'
import { triggerHoldEmote, stopHoldEmote } from './holdEmote'
import { petOverheadTuning } from './petOverheadCalibration'
import { isInsidePrivateAvatarArea } from './privacyAreas'

type Mode = 'follow' | 'goto' | 'interact' | 'wander' | 'bathhop' | 'asleep'

let localPet: Entity | null = null
let localSpecies = ''
let localSkinKey = '' // species|rarity of the skin currently applied to localPet
// A carry pick-up / put-down reparents localPet, and DCL reloads the GLTF instance
// a few frames later — that reload DROPS the runtime skin override, so the held pet
// renders textureless. GltfContainerLoadingState is NO help here: the GLB is already
// cached, so a reparent re-instantiates the mesh without an asset load, and the
// state never leaves FINISHED — there's no engine signal for when the reload lands.
// So we re-assert the skin EVERY frame over a short budget after each reparent, so
// it re-lands the instant the reload finishes (no delay). Not throttled: this is one
// LOCAL pet, once per bath — the GltfNodeModifiers writes are client-side CRDT on a
// single entity and never networked, so their cost is negligible next to the UX hit
// a throttle's delay would add.
let reskinTicks = 0 // frames left to keep re-asserting the skin after a reparent
const RESKIN_TICKS = 150 // ~2.5 s of coverage @60fps for the async reparent-reload (covers slow devices)
// Which pet the localPet entity currently stands for. The entity is REUSED when
// the roster switches, so this is the only way to notice "same entity, different
// pet" and re-place it (see ensureLocalPet / settlePromotedPet).
let localPetId = ''
let mode: Mode = 'follow'
let target = Vector3.create(199.2, 0, 231.8)
let onArrive: (() => void) | null = null
let interactTimer = 0
let interactClip: PetClip = 'idle'
// Feed owns the pet until its explicit Exit. The results card can outlive the
// timed hunger-fill, so a duration alone must never make the eat loop fall
// back to idle underneath that card.
let eatCinematicActive = false
let eatPlaybackSpeed = 1
const curClip = new Map<Entity, string>() // entity -> the GLB clip name currently playing
const entitySpecies = new Map<Entity, string>() // entity -> species, so setClip can resolve its clip names
const lastLogicalClip = new Map<Entity, PetClip>() // entity -> the LOGICAL clip last requested via setClip (curClip stores the resolved GLB name instead)
// See restartMoveClip() below.
let moveClipRestartPending = false

// Bath exit hop — placePetAtStation teleports the pet straight into the tub, which
// sits above/inside walled geometry. Walking straight out afterward (normal 'follow'
// stepToward) would clip through the tub's rim, so we set this flag to detour through
// a short hop (horizontal step + vertical arc) instead of returning to follow/wander directly.
let justBathed = false
let bathHopT = 0 // seconds remaining in the hop; >0 while mode === 'bathhop'
let bathHopFrom = Vector3.Zero()
let bathSplashT = 0
let bathSplashFrom = Vector3.Zero()
const BATH_HOP_DURATION = 0.45 // seconds
const BATH_HOP_DISTANCE = 1.2 // metres covered horizontally while hopping out
const BATH_HOP_HEIGHT = 0.6 // metres, peak arc height
const BATH_SPLASH_HEIGHT = 0.08
const BATH_SPLASH_SECONDS = 2.5 // short win-celebration splash before the hop-out (NOT the whole minigame)
// The petting camera tracks this raised focus point instead of the pet's feet,
// keeping the happy reaction centered rather than looking down at the ground.
const PETTING_CAMERA_LOOK_LIFT = 0.55

// How far above PET_BASE_Y the pet rests while asleep, so it lies on TOP of
// the PetBed's cushion instead of at ground level (sinking a bit below the
// bed's visible surface). Tune this to match the actual model — the sleep
// clip plays with the pet lifted by exactly this much.
const SLEEP_BED_LIFT = 0.15

// Wander state (used while the pet is dismissed / told to stay).
let wanderHome = Vector3.create(199.2, 0, 231.8)
let wanderTarget: Vector3 | null = null
let wanderPause = 0

const remotePets = new Map<string, Entity>()
const remoteSpecies = new Map<string, string>()
const remoteSkinKey = new Map<string, string>() // addr -> species|rarity of the applied skin
const remoteCarried = new Map<string, Entity>() // addr -> anchor attached to that owner's avatar
const hiddenRemotePets = new Set<string>()

// Floating tag above each pet: just its name. A billboard root faces the
// camera. The pet's OWNER additionally sees a row of 4 mood icons (hunger /
// hygiene / energy / happiness) above the name — everyone else only sees the
// name, so `makeTag(showStats)` skips creating the icon entities entirely for
// tags that belong to other players' pets.
// Tag height above the pet = a small base clearance + a term that scales with the
// fixed display size of its growth stage. The model only changes at stage
// thresholds, so the tag must do the same.
const TAG_HEIGHT = 1.0 // initial placeholder (updateTag recomputes per-frame)
// Exported: petEmotes.ts's floating emote stacks above this same tag and needs
// the identical math to clear it — a local copy would silently drift from this
// one the next time either gets retuned.
export const TAG_MIN = 0.35
export const TAG_SIZE_MULT = 1.85

// Mood icons are cropped from a 4-column (hunger/hygiene/energy/happiness) x
// 3-row (bad/mid/good) spritesheet. The icons are NOT evenly spaced quarters/
// thirds of the sheet — these pixel bounds were measured from the image's
// alpha channel so each crop is centered on its icon with no clipping.
const MOOD_ICON_SRC = 'assets/images/petmoods.png'
const MOOD_IMG_W = 1024
const MOOD_IMG_H = 1024
// [x0,x1] per stat column: hunger, hygiene, energy, happiness.
const MOOD_STAT_COL_PX: [number, number][] = [
  [16, 236],
  [312, 484],
  [574, 750],
  [807, 1007]
]
// [y0,y1] per state row: bad (red), mid (yellow), good (green).
const MOOD_STATE_ROW_PX: [number, number][] = [
  [143, 369],
  [411, 619],
  [663, 880]
]
const MOOD_ICON_SIZE = 0.22 // fixed plane height; width is derived per crop (see moodIconScale) so nothing stretches
const MOOD_ICON_STEP = 0.26
const MOOD_ICON_Y = 0.42
// Fixed roll: 90 left (counter-clockwise) plus another 180 on top.
const MOOD_ICON_TILT_DEG = 270

/**
 * Plane scale reproducing the true width:height ratio of the [stat, state] crop
 * at a fixed height, with a NEGATIVE width to mirror the art. A UV-coordinate
 * swap was tried instead (avoids flipping mesh winding) but combined with the
 * 270° roll it visibly rotated the icons wrong — confirmed on-device — so back
 * to the negative-scale mirror, which was confirmed correct.
 */
function moodIconScale(stat: number, state: number): Vector3 {
  const [x0, x1] = MOOD_STAT_COL_PX[stat]
  const [y0, y1] = MOOD_STATE_ROW_PX[state]
  return Vector3.create(-MOOD_ICON_SIZE * ((x1 - x0) / (y1 - y0)), MOOD_ICON_SIZE, 1)
}

/** UVs (front+back face, 8 vertex pairs) cropping the icon at [stat, state] of the mood spritesheet. */
function moodUvs(stat: number, state: number): number[] {
  const [x0, x1] = MOOD_STAT_COL_PX[stat]
  const [y0, y1] = MOOD_STATE_ROW_PX[state]
  const uL = x0 / MOOD_IMG_W
  const uR = x1 / MOOD_IMG_W
  // V is bottom-up (GL convention) while our y0/y1 are top-down image pixels.
  const vLo = 1 - y1 / MOOD_IMG_H
  const vHi = 1 - y0 / MOOD_IMG_H
  const face = [uL, vLo, uR, vLo, uR, vHi, uL, vHi]
  return [...face, ...face]
}

/** 0 (bad/red) / 1 (mid/yellow) / 2 (good/green) column for a 0-100 stat value. */
function moodCol(v: number): number {
  if (v < 34) return 0
  if (v < 67) return 1
  return 2
}

/** A pet's floating indicators: the name label plus (for owned pets) the row of
 *  4 mood icons. `hidden` is the tag's CURRENT on-screen state — updateTag skips
 *  rewriting text/icons while it's true, so a hidden tag stays hidden. */
type HealthTag = { root: Entity; label: Entity; icons: Entity[]; name: string; iconCol: number[]; hidden: boolean }

// The player's NON-active stored pets roam the care area on their own.
type Roamer = { entity: Entity; species: string; tag: HealthTag; home: Vector3; target: Vector3 | null; pause: number }
const inactivePets = new Map<string, Roamer>()
// Creatures whose pet left the roster (traded away) or whose owner has no active
// pet: parked off-map + hidden instead of engine.removeEntity'd, because
// destroying a skinned creature fires Unity's ResetMaterialSystem (desktop
// crash). Keyed by pet id so a returning pet re-shows its ORIGINAL entity (no
// second entity, no re-skin) rather than leaking one and building another.
const retiredPets = new Map<string, Entity>()

// Each owned pet gets its OWN home slot so up-to-4 pets never pile up on the same
// spot. Slots are spread across the care area (objects sit ~x195-214, z235-249);
// a stored pet roams a little around its slot, and the active pet parks on its
// slot while you carry/hatch a new egg so the newborn won't overlap it.
const PET_SLOT_HOMES: Vector3[] = [
  Vector3.create(200, C.PET_BASE_Y, 239),
  Vector3.create(206, C.PET_BASE_Y, 239),
  Vector3.create(200, C.PET_BASE_Y, 245),
  Vector3.create(206, C.PET_BASE_Y, 245)
]
function slotHome(index: number): Vector3 {
  const s = PET_SLOT_HOMES[((index % PET_SLOT_HOMES.length) + PET_SLOT_HOMES.length) % PET_SLOT_HOMES.length]
  // Keep resting slots out of the buildings — the pet lives in the open.
  return nudgeOutsideBuildings(Vector3.create(s.x, s.y, s.z))
}
/** Index of the currently-shown active pet within the roster (-1 if none). */
function activePetSlotIndex(): number {
  const p = clientState.player
  const id = clientState.activePet?.id
  return p && id ? p.pets.findIndex((x) => x.id === id) : -1
}

// Where a freshly-spawned pet first appears: just outside the home dome, in the
// play area right where the player spawns (scene.json SpawnArea1) — NOT at the dome
// centre. This keeps the pet clear of the walls on load and next to the player, so
// a follow never begins with a wall between them (no beeline through the dome).
// nudgeOutsideBuildings is a belt-and-braces guarantee it stays outside any ring.
const HOME_BASE = Vector3.create(204, C.PET_BASE_Y, 240)
function homeSpawnPos(): Vector3 {
  return nudgeOutsideBuildings(HOME_BASE)
}

/** How much the PetBed (and its cushion height) scales for a given pet: the
 *  composite bed is sized for a JUNIOR (factor 1), and GROWS in the same
 *  proportion the pet does for Teenager/Adult. Shared by the bed's own scaling
 *  (updateSleepBedScale) and the pet's rest lift below, so pet + bed + cushion
 *  stay in sync. */
function sleepBedFactor(pet: PetData): number {
  return stageScaleFor(pet.size) / stageScaleFor(C.SIZE_BASE)
}

/** Where a sleeping pet belongs: on the PetBed's cushion when it dozed off in
 *  bed, otherwise lifted in place at `fallback` (it fell asleep in the open, and
 *  `sleepOnBed` false is what makes it refill slower — moving it onto the bed
 *  here would silently contradict that). Y matches the 'asleep' mode's lift. */
function sleepRestPos(pet: PetData, fallback: Vector3): Vector3 {
  if (!pet.sleepOnBed) return Vector3.create(fallback.x, C.PET_BASE_Y + SLEEP_BED_LIFT, fallback.z)
  // Land ON the bed: use its exact spot. NO nudgeOutsideBuildings here — the bed
  // sits INSIDE the house dome ring, so nudging "outside the ring" shoved the pet
  // off the cushion toward the wall (that's why it didn't land exactly on top).
  // The lift scales with the bed so the pet sits ON the (shrunk) cushion, not
  // floating above it, for smaller stages.
  const bed = objectPosition(EntityNames.PetBed_glb)
  return Vector3.create(bed.x, C.PET_BASE_Y + SLEEP_BED_LIFT * sleepBedFactor(pet), bed.z)
}

let localTag: HealthTag | null = null
const remoteTags = new Map<string, HealthTag>()

/** @param showStats create the 4 owner-only mood icons (skip for other players' pets). */
function makeTag(showStats: boolean): HealthTag {
  const root = engine.addEntity()
  Transform.create(root, { position: Vector3.create(0, TAG_HEIGHT, 0) })
  Billboard.create(root, {})

  const label = engine.addEntity()
  Transform.create(label, { position: Vector3.create(0, 0.16, 0), parent: root })
  TextShape.create(label, {
    text: '',
    fontSize: 2.2,
    textColor: { r: 1, g: 0.95, b: 0.8, a: 1 },
    outlineColor: { r: 0.1, g: 0.07, b: 0.04 },
    outlineWidth: 0.25
  })

  const icons: Entity[] = []
  const iconCol: number[] = []
  if (showStats) {
    for (let i = 0; i < 4; i++) {
      const icon = engine.addEntity()
      Transform.create(icon, {
        position: Vector3.create((i - 1.5) * MOOD_ICON_STEP, MOOD_ICON_Y, 0),
        scale: moodIconScale(i, 1),
        rotation: Quaternion.fromEulerDegrees(0, 0, MOOD_ICON_TILT_DEG),
        parent: root
      })
      MeshRenderer.setPlane(icon, moodUvs(i, 1))
      Material.setPbrMaterial(icon, {
        texture: Material.Texture.Common({ src: MOOD_ICON_SRC }),
        transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
      })
      icons.push(icon)
      iconCol.push(-1)
    }
  }

  return { root, label, icons, name: '', iconCol, hidden: false }
}

/** Reposition the tag over the pet, refresh its name, and (if owned) its mood icons. */
function updateTag(tag: HealthTag, pos: Vector3, species: string | null, growthSize: number, name: string, stats: PetData | null): void {
  const tune = species ? petOverheadTuning(species, growthSize) : { nameLift: 0 }
  Transform.getMutable(tag.root).position = Vector3.create(pos.x, pos.y + TAG_MIN + TAG_SIZE_MULT * stageScaleFor(growthSize) + tune.nameLift, pos.z)
  // Keep following the pet while hidden (so it reappears in the right place),
  // but don't rewrite the label — setTagVisible cleared it on purpose and this
  // runs every frame, which would put the name straight back on screen.
  if (tag.hidden) return
  if (name !== tag.name) {
    TextShape.getMutable(tag.label).text = name
    tag.name = name
  }
  if (!stats || tag.icons.length === 0) return
  // Row order: hunger, hygiene, energy, happiness (matches the spritesheet).
  const values = [stats.hunger, stats.hygiene, stats.energy, stats.happiness]
  for (let i = 0; i < tag.icons.length; i++) {
    const col = moodCol(values[i])
    if (col !== tag.iconCol[i]) {
      MeshRenderer.setPlane(tag.icons[i], moodUvs(i, col))
      Transform.getMutable(tag.icons[i]).scale = moodIconScale(i, col)
      tag.iconCol[i] = col
    }
  }
}

/**
 * Show/hide a tag as a whole. This is the ONLY place tag visibility is written,
 * because hiding one takes more than flipping the root: `propagateToChildren`
 * only cascades down to a mood icon's plane once something touches that
 * icon's OWN components again (updateTag only rewrites an icon when its stat
 * crosses a color band) — so relying on propagation alone meant the icons
 * stayed visible for however long it took the next stat tick to happen to
 * touch them, instead of hiding the instant the bubble opened. Setting
 * VisibilityComponent directly on the label and every icon (not just the
 * root) makes it immediate. TextShape also ignores visibility outright, so
 * the name has to be cleared directly too — `name` reset so updateTag's
 * diff-check re-writes it when the tag comes back.
 */
function setTagVisible(tag: HealthTag, visible: boolean): void {
  if (tag.hidden === !visible) return
  tag.hidden = !visible
  VisibilityComponent.createOrReplace(tag.root, { visible, propagateToChildren: true })
  VisibilityComponent.createOrReplace(tag.label, { visible })
  for (const icon of tag.icons) VisibilityComponent.createOrReplace(icon, { visible })
  if (!visible) {
    TextShape.getMutable(tag.label).text = ''
    tag.name = ''
  }
}

// The local pet's tag has two independent reasons to be hidden: the pet flow
// itself (carried in hand, waiting inside an unhatched egg) and the speech
// bubble taking over that space. Track what the flow WANTS and AND it with the
// bubble's suppression, so whichever un-hides first can't override the other.
let localTagWanted = true
let tagsSuppressed = false

function setLocalTagVisible(visible: boolean): void {
  localTagWanted = visible
  if (localTag) setTagVisible(localTag, visible && !tagsSuppressed)
}

/**
 * True while the pet is standing in the world as itself — false when it's being
 * carried in the player's hands or hidden inside an egg mid-hatch. The speech
 * bubble reads this so it never floats over a pet the player can't see or act
 * on; it's the same signal that drives the pet's own name tag.
 */
export function petIsPresent(): boolean {
  return localPet !== null && localTagWanted
}

/**
 * Hide the owned pet's indicators (name + mood icons) while the speech bubble is
 * on screen, and put them back when it goes away. Called from client/speech.ts.
 */
export function suppressPetTags(on: boolean): void {
  if (on === tagsSuppressed) return
  tagsSuppressed = on
  if (localTag) setTagVisible(localTag, localTagWanted && !on)
}

/** Remove a tag and all its child entities. */
function removeTag(tag: HealthTag): void {
  for (const icon of tag.icons) engine.removeEntity(icon)
  engine.removeEntity(tag.label)
  engine.removeEntity(tag.root)
}

// ---------------------------------------------------------------------------
// Animation helpers
// ---------------------------------------------------------------------------
/** Build (or rebuild) an entity's Animator from ITS species' clip names. Called
 *  again whenever the model swaps — a pet that changes species keeps the entity
 *  but needs the new GLB's clip names, or every setClip would be a silent no-op. */
function ensureAnimator(e: Entity, species: string): void {
  if (Animator.has(e) && entitySpecies.get(e) === species) return
  entitySpecies.set(e, species)
  const idle = clipForSpecies(species, 'idle')
  Animator.createOrReplace(e, {
    states: clipsForSpecies(species).map((clip) => ({ clip, playing: clip === idle, loop: true, speed: 1, weight: 1 }))
  })
  curClip.set(e, idle)
  lastLogicalClip.set(e, 'idle')
}

function forgetAnimator(e: Entity): void {
  curClip.delete(e)
  entitySpecies.delete(e)
  lastLogicalClip.delete(e)
}

/** Play a logical clip, resolved to whatever this entity's species calls it. */
function setClip(e: Entity, clip: PetClip): void {
  lastLogicalClip.set(e, clip)
  const name = clipForSpecies(entitySpecies.get(e) ?? '', clip)
  if (curClip.get(e) === name) return
  curClip.set(e, name)
  const a = Animator.getMutable(e)
  for (const s of a.states) s.playing = s.clip === name
}

/** The last LOGICAL clip requested via setClip (not the resolved GLB name) —
 *  e.g. so a caller can tell idle from walk without knowing per-species clip
 *  names. Undefined until setClip has been called at least once. */
export function getLogicalClip(e: Entity): PetClip | undefined {
  return lastLogicalClip.get(e)
}

/** Force the active pet's currently-playing clip (walk/run while fetching,
 *  most likely) to restart from frame 0 on the NEXT tick — used to phase-lock
 *  a carried prop's own baked animation (the fetch ball's per-species "carried
 *  in mouth" walk clip, play.ts, issue #221 — its clip runs the exact same
 *  duration as the pet's own walk clip) to the pet's actual walk cycle at a
 *  specific moment. setClip() no-ops when the resolved clip name hasn't
 *  changed (see its curClip check above), so restarting an ALREADY-playing
 *  clip needs this: drop it for one tick (clearing curClip so the very next
 *  setClip call re-triggers a genuine stopped->playing edge) with
 *  shouldReset armed, so the Animator snaps to frame 0 instead of resuming
 *  mid-loop. Two-tick handoff (this call just flags it; movementTick applies
 *  it) so the drop and the following setClip land in separate frames — doing
 *  both within the same tick would collapse to no visible transition. */
export function restartMoveClip(): void {
  moveClipRestartPending = true
}

// ---------------------------------------------------------------------------
// Movement
// ---------------------------------------------------------------------------
function flat(v: Vector3): Vector3 {
  return Vector3.create(v.x, C.PET_BASE_Y, v.z)
}

/** World scale for a pet = grown size × its species multiplier. */
function petScale(species: string, size: number): Vector3 {
  return Vector3.scale(Vector3.One(), size * scaleForSpecies(species))
}

function distFlat(a: Vector3, b: Vector3): number {
  return Vector3.distance(flat(a), flat(b))
}
function yawToward(from: Vector3, to: Vector3, offsetDeg = 0): Quaternion {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return Quaternion.Identity()
  const yaw = (Math.atan2(dx, dz) * 180) / Math.PI
  return Quaternion.fromEulerDegrees(0, yaw + offsetDeg, 0)
}

/** Move entity toward dest; returns the distance actually moved this frame.
 *  `yawOffset` corrects models whose forward axis isn't the walk direction. */
function stepToward(entity: Entity, dest: Vector3, dt: number, yawOffset = 0): number {
  const t = Transform.getMutable(entity)
  const cur = t.position
  const d = distFlat(cur, dest)
  if (d <= C.PET_ARRIVE_DISTANCE) return 0
  const dir = Vector3.normalize(Vector3.subtract(flat(dest), flat(cur)))
  const step = Math.min(d, C.PET_MOVE_SPEED * dt)
  t.position = Vector3.add(flat(cur), Vector3.scale(dir, step))
  t.rotation = yawToward(cur, dest, yawOffset)
  return step
}

// ---------------------------------------------------------------------------
// Local pet lifecycle
// ---------------------------------------------------------------------------
export function getLocalPet(): Entity | null {
  return localPet
}

/** The world entity of one of the player's OWN stored (non-active) pets,
 *  roaming the care area — see updateInactivePets. Null if it isn't spawned
 *  right now (e.g. it just became active, or the roster just changed). */
export function getInactivePetEntity(petId: string): Entity | null {
  return inactivePets.get(petId)?.entity ?? null
}

/** True while the pet is walking to / performing a care action. */
export function isBusy(): boolean {
  return mode === 'goto' || mode === 'interact' || mode === 'bathhop' || mode === 'asleep'
}

/** True while a self-contained interaction (carry-to-bathe, petting, fetch,
 *  hatching/egg carry) already owns the pet — none of these overlap the
 *  care-action queue's own busy state, so isBusy() is intentionally NOT here. */
/** True while something else has taken direct ownership of the pet's
 *  Transform/parenting (carried in hand to bathe, egg being carried home,
 *  mid-hatch reveal) — genuinely incompatible with sending it on a queued
 *  walk, since the pet isn't a free-standing walking entity right now. */
function petTransformOwnedElsewhere(): boolean {
  return clientState.hatch.active || clientState.carryEgg.active || clientState.carryPet.active
}

/** True while a self-contained interaction already owns the moment — the
 *  above PLUS petting/fetch's camera-lock UI (those don't touch the pet's
 *  Transform, but they do take over the whole screen) PLUS the Feed errand
 *  (feed.ts), which owns the PLAYER: they're out walking to the tree with the
 *  guide arrow up, and starting anything else there would strand that arrow. */
function otherActivityActive(): boolean {
  return petTransformOwnedElsewhere() || clientState.petting.active || clientState.fetch.active || clientState.feedTask.active || clientState.feedGame.active || clientState.bathGame.active || pendingEgg !== null
}

/**
 * Shared gate for STARTING a brand-new interaction (Feed errand, bath carry,
 * petting, fetch/Play) from scratch: blocked while asleep, while any other
 * interaction already owns the pet, or while it's mid-walk on a queued care
 * action. Interactions are meant to be mutually exclusive (one at a time).
 */
export function canStartPetInteraction(): boolean {
  return !hasPendingHatchling() && !clientState.activePet?.sleeping && !otherActivityActive() && !isBusy()
}

/**
 * Narrower gate for ENQUEUEING a care action (input.ts's triggerCare): this is
 * canStartPetInteraction() WITHOUT the isBusy() clause, because queued actions
 * are allowed to stack up — that's the point of the queue, and isBusy() already
 * covers "don't start a 2nd one mid-walk".
 *
 * Every other interaction still blocks, including the ones that don't own the
 * pet's Transform (petting, fetch, the Feed errand). They leave the in-world
 * Bath/Sleep hotspots clickable, so without this a tap on the bed mid-errand
 * yanks the pet away from whatever is already running — that's the concurrent-
 * action bug, and for Feed it also stranded the guide arrow. Cancel the running
 * action (BACK) first.
 */
export function canQueueCareAction(): boolean {
  return !hasPendingHatchling() && !clientState.activePet?.sleeping && !otherActivityActive()
}

// ---------------------------------------------------------------------------
// Pooled pet switching — the ResetMaterialSystem (Unity desktop) crash fix.
//
// Every owned pet keeps its OWN persistent, already-skinned entity: the active
// pet is whichever entity `localPet` points at; the others are the roamers in
// `inactivePets`. Switching the active pet must therefore NEVER swap a
// GltfContainer, re-run applyCreatureSkin, or engine.removeEntity a skinned
// creature — any of those changes/tears-down a GltfNodeModifiers material
// override, which fires Unity's ResetMaterialSystem and crashes the desktop
// client (mobile is unaffected). Instead we hand the "active" role between two
// entities that both already exist and are already skinned.
// ---------------------------------------------------------------------------

/** Reset the shared active-pet flags so a newly-promoted pet doesn't inherit the
 *  outgoing pet's errand/trail, then settle it into follow/wander/asleep at the
 *  position it is ALREADY standing on — the promoted entity is its own roamer,
 *  so it's already where the pet was, no re-placement needed. */
function settlePromotedPet(pet: PetData): void {
  onArrive = null
  interactTimer = 0
  justBathed = false
  bathHopT = 0
  bathSplashT = 0
  followTrail.length = 0
  if (!localPet) return
  const t = Transform.getMutable(localPet)
  if (pet.sleeping) {
    t.position = sleepRestPos(pet, t.position)
    mode = 'asleep'
    return
  }
  mode = clientState.followEnabled ? 'follow' : 'wander'
  wanderHome = flat(t.position)
  wanderTarget = null
  wanderPause = 1
}

/** Park a skinned creature off-map + hidden instead of destroying it. We can't
 *  engine.removeEntity it (that tears down its GltfNodeModifiers override and
 *  fires Unity's ResetMaterialSystem -> desktop crash), and hiding alone is not
 *  enough: a hidden entity KEEPS its CL_POINTER collider, so it would sit there
 *  as an invisible ray-absorber over the bed/pool/feeder and neighbouring pets'
 *  clicks. Moving it far below the map takes that collider out of the way. It's
 *  tracked in retiredPets so the same pet re-shows this entity on return. */
function parkPetEntity(petId: string, e: Entity): void {
  if (petId) retiredPets.set(petId, e)
  VisibilityComponent.createOrReplace(e, { visible: false })
  Transform.getMutable(e).position = Vector3.create(0, -100, 0) // off-map: gets its collider clear of everything (same trick sleepLabel uses)
  pointerEventsSystem.removeOnPointerDown(e)
  forgetAnimator(e)
}

/** Normal roster switch: promote the incoming pet's roamer entity to be the
 *  active `localPet`, and demote the current `localPet` to a roamer for its own
 *  pet. Both entities are already loaded and skinned, so no material override is
 *  ever changed or destroyed — ResetMaterialSystem never runs. */
function swapActiveWithRoamer(newPet: PetData, targetRoamer: Roamer): void {
  const p = clientState.player
  if (!localPet || !localTag || !p) return

  // Demote the outgoing active entity into a roamer for the pet it was showing.
  const outId = localPetId
  const outIndex = p.pets.findIndex((x) => x.id === outId)
  const outEntity = localPet
  const outTag = localTag
  pointerEventsSystem.removeOnPointerDown(outEntity) // drop the "Open" click
  if (outIndex >= 0) {
    const outName = p.pets[outIndex].name
    pointerEventsSystem.onPointerDown(
      { entity: outEntity, opts: { button: InputAction.IA_POINTER, hoverText: `Select ${outName}`, maxDistance: 8 } },
      () => switchActivePet(outId)
    )
    // Un-hide the tag: it may have been hidden mid-speech-bubble while active,
    // and updateInactivePets' updateTag never un-hides it — the pet would roam
    // permanently nameless otherwise.
    setTagVisible(outTag, true)
    inactivePets.set(outId, {
      entity: outEntity,
      species: localSpecies,
      tag: outTag,
      home: slotHome(outIndex),
      target: null,
      pause: 0.4 // brief beat before it starts wandering back to its slot
    })
  } else {
    // The outgoing pet already left the roster (e.g. a discarded hatchling):
    // don't leave a selectable ghost of it — park it away instead.
    parkPetEntity(outId, outEntity)
    removeTag(outTag)
  }

  // Promote the incoming pet's roamer into the active entity.
  inactivePets.delete(newPet.id)
  pointerEventsSystem.removeOnPointerDown(targetRoamer.entity) // drop the "Select" click
  registerPetOpenClick(targetRoamer.entity)
  localPet = targetRoamer.entity
  localTag = targetRoamer.tag
  localSpecies = newPet.species // already the loaded model — prevents a re-skin below
  localSkinKey = `${newPet.species}|${newPet.rarity}` // already the applied skin — ditto
  reskinTicks = 0 // a carry put-down could have left this armed; re-asserting the skin now is the exact op we're avoiding
  settlePromotedPet(newPet)
}

/** Retire the outgoing active entity when the incoming active pet has NO entity
 *  of its own yet (e.g. a pet just received via a trade). We can't reuse the old
 *  entity — re-skinning it to the newcomer would fire ResetMaterialSystem — so
 *  we park it (see parkPetEntity) and let the caller build a fresh,
 *  first-time-skinned entity for the newcomer. */
function retireActiveEntity(): void {
  if (localPet) parkPetEntity(localPetId, localPet)
  if (localTag) {
    removeTag(localTag)
    localTag = null
  }
  localPet = null
  localSpecies = ''
  localSkinKey = ''
  reskinTicks = 0
}

/** Click-to-open handler for the local pet — pulled out of ensureLocalPet so
 *  startPetting()/cancelPetting() can strip and restore it: while petting is
 *  active the camera is locked on the pet for the swipe gesture, and the
 *  world-space full-screen blocker over it (ui.tsx's PettingOverlay) already
 *  swallows every click, so this handler's own click never actually fires —
 *  but the pointer-event REGISTRATION itself still drives the "Open" hover
 *  tooltip/cursor, which just sits there doing nothing and reads as broken. */
function registerPetOpenClick(entity: Entity): void {
  pointerEventsSystem.onPointerDown(
    { entity, opts: { button: InputAction.IA_POINTER, hoverText: 'Open', maxDistance: 8 } },
    () => {
      // Feed owns the pet's transform, camera and input while it is active.
      // The staged pet remains visible beside the catch lane, but must not
      // reopen its action panel from a world click during that sequence.
      if (clientState.feedGame.active) return
      // While a freshly hatched pet is still awaiting the Keep/Discard decision,
      // the actions panel must stay closed: opening it lets the player run care
      // actions on a pet that isn't accepted into a slot yet, which bugs out.
      // The Keep/Discard modal owns this moment until they decide.
      if (hasPendingHatchling()) {
        pushToast('Keep or discard your new pet first!')
        return
      }
      // Clicking the pet opens its control panel. (The "pet for happiness"
      // action is suspended for now — was: actions.petSelf() + petReact().)
      clientState.petPanelOpen = true
      // Point them at the Breed button until the pet grows up.
      const ap = clientState.activePet
      if (ap && petStage(ap.size) !== 'ADULT') {
        showHint('breed', 'Grow your pet to Adult in order to BREED amazing creatures!')
      }
    }
  )
}

function ensureLocalPet(): void {
  const pet = clientState.activePet
  if (!pet) {
    // No active pet (lost your last one / state cleared). Retire the entity by
    // HIDING it, not engine.removeEntity — destroying a skinned creature fires
    // Unity's ResetMaterialSystem (desktop crash). retireActiveEntity leaks it,
    // which is fine: there's no pet to render until you adopt again.
    if (localPet || localTag) retireActiveEntity()
    localPetId = ''
    return
  }
  const renderSpecies = pet.species

  // The roster switched to a DIFFERENT pet (My Pets panel, or clicking a stored
  // pet in the care area). Handle it BEFORE the create/reuse decision so a real
  // switch NEVER re-skins or destroys a skinned creature (see the pooled-pet
  // switching block above — that reset crashes the Unity desktop client).
  if (localPet && localPetId !== pet.id) {
    const targetRoamer = inactivePets.get(pet.id)
    if (targetRoamer) {
      // The incoming pet already has its own persistent, skinned roamer entity:
      // promote it to active and demote the current localPet. No re-skin, no
      // removal — ResetMaterialSystem never runs.
      swapActiveWithRoamer(pet, targetRoamer)
    } else if (localPetId.startsWith('local_')) {
      // No roamer AND the OUTGOING id is the optimistic hatchling's throwaway
      // `local_...` id being replaced by the server's real one: same creature,
      // new id. Nothing to do — keep the same entity exactly where it is (mode,
      // position and skin all still describe this very pet).
    } else {
      // No roamer and not a hatchling re-key: a genuinely new active pet we have
      // no entity for (e.g. one just received via a trade). Hide the outgoing
      // entity instead of re-skinning it, then build a fresh one below.
      retireActiveEntity()
    }
  }

  if (!localPet) {
    localPet = engine.addEntity()
    // Reconnecting while the pet was left sleeping: resume it AT the bed,
    // already asleep — otherwise it spawns at the generic home point in
    // 'follow' mode and walks over to fall asleep right next to the player
    // instead of staying where it was left.
    let spawnPos = homeSpawnPos()
    if (pet.sleeping) {
      spawnPos = sleepRestPos(pet, spawnPos)
      mode = 'asleep'
    }
    Transform.create(localPet, { position: spawnPos, scale: petScale(renderSpecies, stageScaleFor(pet.size)) })
    registerPetOpenClick(localPet)
    localTag = makeTag(false) // owner's own pet — mood icons replaced by petEmotes.ts's floating emote
    // A pet can be (re)built mid-sentence — start the fresh tag in whatever state
    // the flow and the speech bubble currently agree on, not blindly visible.
    setTagVisible(localTag, localTagWanted && !tagsSuppressed)
  }
  localPetId = pet.id
  if (localSpecies !== renderSpecies) {
    localSpecies = renderSpecies
    GltfContainer.createOrReplace(localPet, { src: modelForSpecies(renderSpecies), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
    ensureAnimator(localPet, renderSpecies)
  }
  // Re-skin on species OR rarity change (a same-species roster switch reuses the
  // entity but may need a different rarity skin).
  const skinKey = `${renderSpecies}|${pet.rarity}`
  if (localSkinKey !== skinKey) {
    localSkinKey = skinKey
    applyCreatureSkin(localPet, renderSpecies, pet.rarity)
  }
  // Carry reparent recovery: re-assert the skin every frame over a short budget so
  // it re-lands the instant the reparent-triggered reload finishes, whenever that is.
  if (reskinTicks > 0) {
    applyCreatureSkin(localPet, pet.species, pet.rarity)
    reskinTicks--
  }
  // Keep visual scale synced to growth. This runs before updateLocalPet's
  // interaction branches every frame, so carry behavior must only change the
  // parent/pose and must never write a competing carry-specific scale.
  const t = Transform.getMutable(localPet)
  const s = petScale(renderSpecies, stageScaleFor(pet.size))
  if (t.scale.x !== s.x) t.scale = s
}

/** Send the pet to a world position; play `clip` on arrival, then run cb. */
export function sendPetTo(dest: Vector3, cb: () => void, clip: PetClip = 'eat'): void {
  if (!localPet) return
  target = flat(dest)
  onArrive = cb
  interactClip = clip
  mode = 'goto'
}

/** Quick affection reaction (used when petting). */
export function petReact(): void {
  if (!localPet) return
  if (mode === 'goto') return
  mode = 'interact'
  interactClip = 'gesture-positive'
  interactTimer = 0.9
}

/** Restart the baked eating clip and explicitly keep it looping for the full
 * Feed cinematic. `playSingleAnimation` supplies the reset-to-frame-zero; the
 * state update below prevents the clip from stopping after its first pass. */
function restartEatAnimation(): boolean {
  if (!localPet || !Animator.has(localPet)) return false
  const eatClip = clipForSpecies(clientState.activePet?.species ?? '', 'eat')
  curClip.set(localPet, eatClip)
  lastLogicalClip.set(localPet, 'eat')
  Animator.playSingleAnimation(localPet, eatClip, true)
  const state = Animator.getMutable(localPet).states.find((candidate) => candidate.clip === eatClip)
  if (state) {
    state.playing = true
    state.loop = true
    state.speed = eatPlaybackSpeed
  }
  return true
}

/** Sprout's baked clip needs an explicit loop boundary for the feed path. */
export function restartFeedEatCycle(): boolean {
  return restartEatAnimation()
}

/** End the feed-owned eat loop immediately when its results card is dismissed. */
export function stopEatCinematic(): void {
  eatCinematicActive = false
  if (mode === 'interact' && interactClip === 'eat') {
    interactTimer = 0
    mode = clientState.followEnabled ? 'follow' : 'wander'
  }
}

/** Place the pet in a short, in-world eating beat after a successful fruit run. */
export function playEatCinematic(position: Vector3, lookAt: Vector3, duration: number, playbackSpeed = 1): void {
  if (!localPet) return
  const t = Transform.getMutable(localPet)
  t.position = Vector3.create(position.x, position.y, position.z)
  t.rotation = yawToward(position, lookAt, yawOffsetForSpecies(clientState.activePet?.species ?? ''))
  onArrive = null
  justBathed = false
  mode = 'interact'
  interactClip = 'eat'
  interactTimer = duration
  eatCinematicActive = true
  eatPlaybackSpeed = Math.max(0.1, Math.min(3, playbackSpeed))
  restartEatAnimation()
}

// ---------------------------------------------------------------------------
// Pet gesture (Adopt-Me style): lock the camera on the pet, then swipe left/right
// across the screen (the pet is centered, so it reads as petting it) for a few
// seconds. A dedicated virtual camera frames the pet; the avatar is frozen.
// ---------------------------------------------------------------------------
let petCam: Entity | null = null
let petCamFocus: Entity | null = null

/** Enter petting mode: frame the pet, face it to camera, freeze the avatar. */
export function startPetting(): void {
  if (!clientState.activePet || !localPet) return
  if (!canStartPetInteraction()) {
    pushToast(clientState.activePet.sleeping ? 'Your pet is asleep!' : 'Your pet is busy right now!')
    return
  }
  clientState.petting = { active: true, progress: 0, celebrationUntil: 0 }
  // The full-screen blocker over the pet during this overlay already
  // swallows clicks, so the "Open" hover/cursor feedback would just sit
  // there doing nothing for the whole gesture — strip it for now,
  // cancelPetting() puts it back once the overlay closes.
  pointerEventsSystem.removeOnPointerDown(localPet)

  const petPos = Transform.get(localPet).position
  // Camera sits a few metres out and slightly up, looking straight at the pet.
  const camPos = Vector3.create(petPos.x, petPos.y + 1.15, petPos.z + 2.8)
  if (!petCam) petCam = engine.addEntity()
  if (!petCamFocus) petCamFocus = engine.addEntity()
  Transform.createOrReplace(petCamFocus, {
    position: Vector3.create(petPos.x, petPos.y + PETTING_CAMERA_LOOK_LIFT, petPos.z)
  })
  Transform.createOrReplace(petCam, { position: camPos })
  VirtualCamera.createOrReplace(petCam, { lookAtEntity: petCamFocus })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: petCam })

  // Turn the pet to face the camera so we see its front, and freeze it there.
  Transform.getMutable(localPet).rotation = yawToward(petPos, camPos, yawOffsetForSpecies(clientState.activePet.species))
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
}

/** Hand the camera + avatar control back to the player. */
function releasePettingView(): void {
  if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
}

/** Leave petting mode without completing (BACK button). */
export function cancelPetting(): void {
  clientState.petting = { active: false, progress: 0, celebrationUntil: 0 }
  releasePettingView()
  if (localPet) registerPetOpenClick(localPet) // restore the "Open" click startPetting() stripped
}

/** Finish petting: reward happiness, then linger on the happy reaction. */
function completePetting(): void {
  const st = clientState.petting
  if (st.celebrationUntil > 0) return
  st.progress = 1
  st.celebrationUntil = Date.now() + C.PETTING_HAPPY_CINEMATIC_S * 1000
  const pet = clientState.activePet
  if (pet) pet.happiness = Math.min(100, pet.happiness + C.PET_SELF_HAPPINESS)
  actions.petSelf() // server is authoritative; this is the "happiness" action
  pushToast('Your pet loved that!  +Happy')
}

/**
 * Register a tap on the pet (mobile fill). Called from the overlay's onMouseDown
 * because quick taps don't reliably register via isPressed polling.
 */
export function petTap(): void {
  const st = clientState.petting
  if (!st.active || st.celebrationUntil > 0) return
  st.progress += C.PET_TAP_FILL
  if (st.progress >= 1) completePetting()
}

/**
 * Shared gesture fill (petting + hatching). Desktop/Bevy fills by swiping
 * (screenDelta); mobile only ebbs here — taps are added by the UI (petTap /
 * hatchTap) because quick taps don't register via isPressed polling.
 */
function gestureFill(progress: number, dt: number): number {
  const rate = dt / C.PET_GESTURE_SECONDS
  if (mobile()) {
    progress -= rate * C.PET_GESTURE_DECAY_FACTOR
  } else {
    const pressed = inputSystem.isPressed(InputAction.IA_POINTER)
    const info = PrimaryPointerInfo.getOrNull(engine.RootEntity)
    const dx = Math.abs(info?.screenDelta?.x ?? 0)
    const dpr = UiCanvasInformation.getOrNull(engine.RootEntity)?.devicePixelRatio || 1
    const swiping = pressed && dx > C.PET_SWIPE_EPS * dpr
    progress += swiping ? rate : -rate * C.PET_GESTURE_DECAY_FACTOR
  }
  return Math.max(0, Math.min(1, progress))
}

/** Per-frame petting update. Completing rewards happiness. */
function updatePetting(dt: number): void {
  const st = clientState.petting
  if (!st.active) return
  if (!clientState.activePet || !localPet) {
    cancelPetting()
    return
  }
  if (st.celebrationUntil > 0) {
    if (Date.now() >= st.celebrationUntil) cancelPetting()
    return
  }
  st.progress = gestureFill(st.progress, dt)
  if (st.progress >= 1) completePetting()
}

// ---------------------------------------------------------------------------
// Hatching — on adoption an egg appears; rubbing/tapping it (same gesture as
// petting) hatches the pet. The server isn't told until the egg hatches, so a
// snapshot can't reveal the pet early.
// ---------------------------------------------------------------------------
const EGG_MODEL = 'models/stylized_dino_egg.glb'
// The Nest: a fixture inside the house. Eggs hatch ON it — startHatch() drops the
// egg here (not in front of the player), so hatching always happens on the nest.
const NEST_MODEL = 'assets/Models/newModels/Nest.glb'
const NEST_POS = Vector3.create(204, C.PET_BASE_Y, 254) // inside the house, just past HOME_BASE (204,240)
const NEST_EGG_LIFT = 0.5 // how high the egg sits on the nest (tune to the model's bowl)
const NEST_YAW = 237 // degrees: face the house door (door is west of the dome). Tune if the model's front points elsewhere (try ±90 / 180).
// Hatch reveal camera, relative to the egg on the nest. HATCH_CAM_YAW is the bearing
// FROM the egg TO the camera (0 = +Z). Aligned with the nest's facing so the shot is
// head-on with the nest+egg instead of viewing it from the side. Tune freely.
const HATCH_CAM_YAW = NEST_YAW
const HATCH_CAM_DIST = 2.6 // metres back from the egg
const HATCH_CAM_HEIGHT = 1.2 // metres above the egg

/** Place the (static, non-blocking) hatching nest inside the house. Called once. */
function placeNest(): void {
  const e = engine.addEntity()
  Transform.create(e, { position: NEST_POS, rotation: Quaternion.fromEulerDegrees(0, NEST_YAW, 0) })
  // No collision — decorative hatch surface; must not block the player walking in.
  GltfContainer.create(e, { src: NEST_MODEL, visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
}
// Timings synced to the egg's `Hatch` clip (2.0s one-shot): the shell opens and
// reveals the interior at ~1.4s, and is fully gone at 2.0s.
const HATCH_ANIM_SECONDS = 2.0 // total Hatch clip length -> when the egg is removed
const PET_EMERGE_AT = 1.4 // when the pet pops out (egg is open)
const HATCH_POP_SECONDS = HATCH_ANIM_SECONDS - PET_EMERGE_AT // pop lasts until the egg is gone
const HATCH_ADMIRE_SECONDS = 1.2 // camera lingers on the newborn before handing back control
const HATCH_PET_LIFT = 0.35 // raise the newborn ~35 cm during the reveal (sits on the nest, not the floor)
let egg: Entity | null = null
let hatchSpecies = ''
let hatchName = ''
// Breed eggs vs adoption eggs: a breed offspring already exists on the server as
// the hatchling (from the breed roll), so its reveal must NOT re-adopt.
let carryIsBreed = false
let hatchPopT = 0 // >0 while the freshly-hatched pet is popping in
let hatchRevealPos: Vector3 | null = null // where the pet emerges (the egg's spot)
let hatchAnimT = 0 // elapsed time since the Hatch clip started
let hatchRevealed = false // pet already popped out this hatch?
let hatchEggRemoved = false // egg entity already removed this hatch?
let hatchFocus: Entity | null = null // invisible, fixed point at the egg's spot the camera stays locked on

// --- Carrying the egg home ------------------------------------------------
// On adoption the egg is attached above the avatar; the player walks it home,
// where a Hatch button starts the rub-to-hatch flow below.
let carriedEgg: Entity | null = null // the egg mesh (child)
let carriedEggAnchor: Entity | null = null // empty attached to the hand bone
// Offset of the egg from the hand bone origin, and its scale in hand.
// Calibrated in-world on desktop/Unity (issue #178).
const EGG_HAND_OFFSET = Vector3.create(0.16, 0.1, -0.09)
const EGG_HAND_SCALE = 0.6 // back to the previous size (looks big in hand, that's fine)
// Rotation of the egg in hand (euler degrees). Points the tip up (^).
const EGG_HAND_ROTATION = Quaternion.fromEulerDegrees(90, 0, 0)
// Looping "hold" emote played while carrying (poses the arms as if cradling the
// egg). Masked to the upper body so the legs keep using normal walk/run
// locomotion — the client auto-replays a looping masked emote on its own if
// something momentarily interrupts it, so this is triggered ONCE per carry
// and never re-applied on movement changes (see holdEmote.ts's stopHoldEmote
// doc comment for why a manual re-trigger would race the deliberate stop —
// issue #115).
// Scene emotes must end in '_emote.glb' (Unity enforces this naming convention).
const HOLD_EMOTE = 'models/hold_emote.glb'

function playHoldEmote(): void {
  triggerHoldEmote(HOLD_EMOTE)
}
// stopHoldEmote is imported from ./holdEmote (shared with fruitGame.ts).

// ---------------------------------------------------------------------------
// Holding the pet in hand — attached to the player's lower-spine bone
// (AvatarAttach), same approach as the carried egg. A manually-computed world
// position (read from the player's Transform each frame) lagged behind the
// avatar and looked jittery/stuck at running speed; bone attachment is
// resolved by the renderer every render frame, so it stays smooth. The name/
// health tag is just hidden for the duration — its absolute world-unit size
// reads huge up close on the player's chest, and there's no good spot for it
// there. It reappears (at its normal position/scale) as soon as the pet is
// back in world space. Tune the bone-local offset below (approximate — verify
// against the actual rig in-world and nudge as needed).
// ---------------------------------------------------------------------------
const HOLD_PET_EMOTE = 'models/hold_pet_emote.glb'
const PET_HOLD_OFFSET = Vector3.create(0, -0.15, 0.22) // local offset from the spine bone, out in front and down toward the belly
const PET_HOLD_YAW = 0 // extra yaw if the model faces the wrong way (0/90/180/270)
const BATH_RADIUS = 3 // how close to the tub before the Bath button appears

let carriedPetAnchor: Entity | null = null

function playHoldPetEmote(): void {
  triggerHoldEmote(HOLD_PET_EMOTE)
}

/** The carry offset tracks the pet's rendered growth/species scale, so a large
 * pet stays clear of the avatar instead of using the old baby-sized pose. */
function petHoldOffset(pet: PetData): Vector3 {
  return Vector3.scale(PET_HOLD_OFFSET, petScale(pet.species, stageScaleFor(pet.size)).x)
}

function remotePetHoldOffset(species: string, size: number): Vector3 {
  return Vector3.scale(PET_HOLD_OFFSET, petScale(species, stageScaleFor(size)).x)
}

/** The held pet is directly in front of the camera. Disable its pointer collider
 * so it cannot block clicks on the bath or other world interactions. */
function setHeldPetPointerCollider(enabled: boolean): void {
  if (!localPet || !GltfContainer.has(localPet)) return
  GltfContainer.getMutable(localPet).visibleMeshesCollisionMask = enabled ? ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE
}

/** Remote pets use their own pointer handler for the passport. Mirror the local
 * carry behavior so a pet held at another player's chest cannot intercept taps. */
function setRemotePetPointerCollider(entity: Entity, enabled: boolean): void {
  if (!GltfContainer.has(entity)) return
  GltfContainer.getMutable(entity).visibleMeshesCollisionMask = enabled ? ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE
}

/** Parent the pet to the player's spine bone, offset out in front (carrying pose); hide its tag. */
function attachPetToHands(pet: PetData): void {
  if (!localPet) return
  if (!carriedPetAnchor) carriedPetAnchor = engine.addEntity()
  Transform.createOrReplace(carriedPetAnchor, {})
  AvatarAttach.createOrReplace(carriedPetAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_SPINE })
  const t = Transform.getMutable(localPet)
  t.parent = carriedPetAnchor
  t.position = petHoldOffset(pet)
  t.rotation = Quaternion.fromEulerDegrees(0, yawOffsetForSpecies(pet.species) + PET_HOLD_YAW, 0)
  setHeldPetPointerCollider(false)
  setLocalTagVisible(false)
  reskinTicks = RESKIN_TICKS // reparent reloads the GLTF late; keep re-asserting the skin until it lands
}

/** Detach the pet back into world space (place at the tub, or cancel the carry); restore its tag.
 *  Reparenting alone leaves the Transform at PET_HOLD_OFFSET — a small offset
 *  LOCAL to the player's spine bone — which becomes a near-origin WORLD
 *  position once detached (the pet vanishing bug, #122), so this also resets
 *  position/rotation here instead of leaving every caller to remember it:
 *  dropped at its natural follow-slot spot, facing the player, not stacked
 *  exactly on top of them. placePetAtStation() overwrites both right after
 *  this returns (hard-placing into the tub instead). */
function detachPetFromHands(): void {
  if (localPet) {
    const t = Transform.getMutable(localPet)
    t.parent = engine.RootEntity
    const drop = flat(followTarget())
    t.position = drop
    t.rotation = yawToward(drop, playerPos())
  }
  setHeldPetPointerCollider(true)
  setLocalTagVisible(true)
  if (carriedPetAnchor) AvatarAttach.deleteFrom(carriedPetAnchor) // stop riding the player's bone between baths
  reskinTicks = RESKIN_TICKS // reparent back to the scene reloads the GLTF too — keep re-asserting the skin
}

/** Bath step 1: pick the pet up into the player's hands to carry it to the tub. */
export function startCarryPet(): void {
  if (!clientState.activePet || !localPet) return
  if (!canStartPetInteraction()) {
    pushToast(clientState.activePet.sleeping ? 'Your pet is asleep!' : 'Your pet is busy right now!')
    return
  }
  clientState.carryPet = { active: true, atStation: false }
  attachPetToHands(clientState.activePet)
  actions.setCarried(true)
  playHoldPetEmote()
  showArrowTo(objectPosition(EntityNames.PetPool_glb), 'carryPet')
  pushToast('Carry your pet to the bath!')
}

/** Cancel the bath carry (BACK): drop the flow, the pet just resumes following. */
export function cancelCarryPet(): void {
  if (!clientState.carryPet.active) return
  clientState.carryPet = { active: false, atStation: false }
  detachPetFromHands() // also resets position/rotation — see its doc comment
  actions.setCarried(false)
  stopHoldEmote() // drop the hold pose, pet is no longer in hand
  hideArrow('carryPet')
}

// Bath minigame camera: a cinematic shot framed on the tub, held (avatar frozen)
// through the whole minigame — the intro "Start" beat, the countdown, popping and
// results — the same lock/lookAt pattern the petting/hatch shots use. Tunable.
const BATH_CAM_DIST = 3.2 // metres out from the tub, on the side AWAY from the home dome (-Z)
const BATH_CAM_HEIGHT = 1.6 // metres above the tub
const BATH_CAM_LOOK_LIFT = 0.6 // focus point above the tub floor (roughly the pet's body)
const BATH_CAM_AVATAR_BACK = 2 // metres to park the frozen avatar BEHIND the camera, out of the shot
const BATH_CAM_TRANSITION_S = 0.8 // blend-in time, mirrors the fruit minigame's ARRIVAL_CAM_TRANSITION_S (no hard cut)

/** Lock the camera onto the bathtub for the bath minigame. */
function startBathCamera(): void {
  const tub = objectPosition(EntityNames.PetPool_glb)
  if (!petCam) petCam = engine.addEntity()
  if (!petCamFocus) petCamFocus = engine.addEntity()
  // Frame the tub from the -Z side: +Z aims straight into HomeDome01, which would
  // put the camera inside the dome and teleport the frozen avatar through its
  // wall. nudgeOutsideBuildings is a belt-and-braces guard — relocating the tub
  // in the editor can never re-park the shot (or the avatar) indoors. (It flattens
  // Y to PET_BASE_Y, so the camera/avatar height is re-applied afterwards.)
  const camFlat = nudgeOutsideBuildings(Vector3.create(tub.x, C.PET_BASE_Y, tub.z - BATH_CAM_DIST))
  const avatarFlat = nudgeOutsideBuildings(Vector3.create(tub.x, C.PET_BASE_Y, tub.z - (BATH_CAM_DIST + BATH_CAM_AVATAR_BACK)))
  Transform.createOrReplace(petCamFocus, { position: Vector3.create(tub.x, C.PET_BASE_Y + BATH_CAM_LOOK_LIFT, tub.z) })
  Transform.createOrReplace(petCam, { position: Vector3.create(camFlat.x, C.PET_BASE_Y + BATH_CAM_HEIGHT, camFlat.z) })
  VirtualCamera.createOrReplace(petCam, {
    lookAtEntity: petCamFocus,
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(BATH_CAM_TRANSITION_S) } // blend in, like fruitGame
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: petCam })
  // Tuck the avatar BEHIND the camera (further out than it) so it's out of the shot
  // — done before the freeze so the teleport isn't blocked. It stays frozen there.
  void movePlayerTo({
    newRelativePosition: Vector3.create(avatarFlat.x, C.PET_BASE_Y, avatarFlat.z),
    cameraTarget: Vector3.create(tub.x, C.PET_BASE_Y + BATH_CAM_LOOK_LIFT, tub.z)
  })
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
}

/** Hand the camera + avatar control back when the bath minigame ends (Done/BACK). */
export function endBathCamera(): void {
  releasePettingView() // shared camera/input release (clears the virtual cam + InputModifier)
}

/** Bath step 2: place the pet in the tub and start the bubble minigame. The bath
 *  reward + splash come from the minigame's RESULT (finishBath), not from here. */
export function placePetAtStation(): void {
  if (!clientState.carryPet.active) return
  clientState.carryPet = { active: false, atStation: false }
  detachPetFromHands()
  actions.setCarried(false)
  stopHoldEmote() // drop the hold pose, pet is no longer in hand
  hideArrow('carryPet')
  if (localPet) {
    const t = Transform.getMutable(localPet)
    t.position = flat(objectPosition(EntityNames.PetPool_glb))
    t.rotation = Quaternion.Identity()
    bathSplashFrom = t.position
  }
  // A brief neutral interact just clears any stale 'goto' (e.g. a queued care
  // action mid-walk when the carry started) so the pet doesn't wander off after
  // the game. NO splash/countdown is armed here — the pet simply idles in the tub
  // while the minigame runs (updateLocalPet holds it there), and only a WIN plays
  // the splash + hop-out (finishBath). This is what stops a full bath animation
  // from playing after a LOSS or BACK and reading as a successful bath.
  mode = 'interact'
  interactClip = 'gesture-positive'
  interactTimer = 0.5
  bathSplashT = 0
  justBathed = false
  // Lock the camera ONLY if the game actually started — startBathGame no-ops if a
  // round is somehow still live, and locking + freezing the avatar with no overlay
  // and no BACK button behind it would be an unrecoverable soft-lock.
  if (startBathGame()) startBathCamera() // cinematic lock on the tub for the intro beat + the minigame
}

/** Called by the bath minigame when it ends. On a WIN the pet plays the short
 *  splash + hop-out-of-the-tub celebration; on a loss/BACK it just resumes — no
 *  splash, no reward, so the outcome stays honest. */
export function finishBath(won: boolean): void {
  if (!localPet || !won) return
  bathSplashFrom = Transform.get(localPet).position
  mode = 'interact'
  interactClip = 'gesture-positive'
  interactTimer = BATH_SPLASH_SECONDS
  bathSplashT = 0
  justBathed = true // splash in place, then hop out of the tub (see updateLocalPet)
}

// ---------------------------------------------------------------------------
// Ground arrow guide — a flowing arrow on the floor that points from the player
// toward a destination (e.g. home while carrying the egg). Reusable, but there
// is only ONE arrow, so every user claims it under an ArrowOwner tag: set a
// target with showArrowTo(target, owner), clear it with hideArrow(owner).
// ---------------------------------------------------------------------------
const ARROW_MODEL = 'models/arrow_indicator.glb'
const ARROW_LEAD = 1 // metres ahead of the player, toward the target
const ARROW_GROUND_CLEARANCE = 0.05 // desired world height above the floor (~player's feet at rest)
const ARROW_INDOOR_LIFT = 0.6 // extra world height indoors so the arrow clears raised floors / trim
const ARROW_YAW_OFFSET = 180 // model points backwards; flip it to point at the target
const ARROW_SCALE = 1 // tune the arrow size
const CARE_CENTER_ARROW_RADIUS = 4.5 // arrow-only footprint around the Care Center interior
let arrow: Entity | null = null
let arrowTarget: Vector3 | null = null

/** Which flow the arrow currently belongs to. Exactly one at a time: the arrow
 *  is a single shared entity, so without an owner two overlapping flows fight
 *  over it — one re-pointing it every frame while the other clears it, which is
 *  how it ended up stuck on screen after switching actions. */
export type ArrowOwner = 'feed' | 'carryEgg' | 'carryPet' | 'getEgg'
let arrowOwner: ArrowOwner | null = null

export function showArrowTo(target: Vector3, owner: ArrowOwner): void {
  arrowTarget = target
  arrowOwner = owner
}
/** Clear the arrow. Pass the owner that raised it so a flow that is shutting
 *  down can't yank an arrow another flow has just taken over. */
export function hideArrow(owner: ArrowOwner): void {
  if (arrowOwner !== owner) return
  arrowTarget = null
  arrowOwner = null
}

/** Is the flow that raised the arrow still running? The arrow outliving its
 *  owner is the stuck-arrow bug, so updateArrow() drops it here rather than
 *  trusting every exit path of every flow to call hideArrow(). */
function arrowOwnerActive(): boolean {
  if (arrowOwner === 'feed') return clientState.feedTask.active
  if (arrowOwner === 'carryEgg') return clientState.carryEgg.active
  if (arrowOwner === 'carryPet') return clientState.carryPet.active
  if (arrowOwner === 'getEgg') return pendingEgg !== null
  return false
}

function playerNeedsIndoorArrowLift(pos: Vector3): boolean {
  if (zoneOf(pos) !== null) return true
  const caretaker = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
  if (!caretaker || !Transform.has(caretaker)) return false
  return distFlat(pos, Transform.get(caretaker).position) <= CARE_CENTER_ARROW_RADIUS
}
// Parented to the player (body-fixed, same trick as AvatarAttach) instead of
// positioned each frame from a world-space read of the player's Transform — that
// read lags behind the avatar's actual (render-smooth) movement and looked
// jittery/stuck while running, same root cause the carried pet had before it was
// switched to AvatarAttach. With native parenting the renderer supplies the
// player's *current* position every render frame; we only ever compute the
// (slowly-changing) bearing to the target, expressed as a small local offset/yaw.
function updateArrow(): void {
  if (!arrow) {
    arrow = engine.addEntity()
    Transform.create(arrow, { parent: engine.PlayerEntity, scale: Vector3.scale(Vector3.One(), ARROW_SCALE) })
    GltfContainer.create(arrow, { src: ARROW_MODEL })
    Animator.create(arrow, { states: [{ clip: 'flow', playing: true, loop: true }] })
    VisibilityComponent.create(arrow, { visible: false })
  }
  const vis = VisibilityComponent.getMutable(arrow)

  // Safety net: the owning flow ended without clearing its arrow (superseded by
  // another action, pet switched, ...) — drop it instead of leaving it stuck.
  if (arrowTarget && !arrowOwnerActive()) {
    arrowTarget = null
    arrowOwner = null
  }
  if (!arrowTarget) {
    if (vis.visible) vis.visible = false
    return
  }
  const pt = Transform.getOrNull(engine.PlayerEntity)
  if (!pt) return
  const dx = arrowTarget.x - pt.position.x
  const dz = arrowTarget.z - pt.position.z
  if (dx * dx + dz * dz < 0.01) {
    if (vis.visible) vis.visible = false
    return
  }
  // World bearing to the target, then the player's own current facing — both via
  // atan2(x,z), DCL's yaw convention — so we can express the arrow's pose in the
  // PLAYER's local frame (localYaw = worldYaw - playerYaw). Parented, that local
  // pose combines with the renderer's own current (smooth) player transform.
  const worldYaw = (Math.atan2(dx, dz) * 180) / Math.PI
  const fwd = Vector3.rotate(Vector3.create(0, 0, 1), pt.rotation)
  const playerYaw = (Math.atan2(fwd.x, fwd.z) * 180) / Math.PI
  const localYaw = worldYaw - playerYaw
  const rad = (localYaw * Math.PI) / 180
  // Parenting fixes horizontal jitter, but a fixed local Y would ride up with the
  // player during a jump (local space moves with the parent on every axis). Cancel
  // the player's current height so the arrow stays near the actual ground instead.
  // Indoors, add a small fixed lift so the same floor arrow stays visible over the
  // house / Care Center floors without turning into a floating waypoint.
  const localY = ARROW_GROUND_CLEARANCE + (playerNeedsIndoorArrowLift(pt.position) ? ARROW_INDOOR_LIFT : 0) - pt.position.y
  const t = Transform.getMutable(arrow)
  t.position = Vector3.create(Math.sin(rad) * ARROW_LEAD, localY, Math.cos(rad) * ARROW_LEAD)
  t.rotation = Quaternion.fromEulerDegrees(0, localYaw + ARROW_YAW_OFFSET, 0)
  t.scale = Vector3.scale(Vector3.One(), ARROW_SCALE)
  if (!vis.visible) vis.visible = true
}

/** Adopt handoff: give the player an egg to carry home (held in the hand). */
// An egg the player adopted but hasn't picked up yet: they must walk to the
// Caretaker to receive it, instead of it materialising in their hand from
// wherever they happened to be standing (e.g. right after buying a slot). Once
// they reach the Caretaker, updateGetEgg() hands it over via startCarryEgg().
let pendingEgg: { species: string; name: string } | null = null
const CARETAKER_EGG_REACH = 4.5 // metres from the Caretaker that count as "arrived"

/** True while an adopted egg is waiting to be collected at the Caretaker. Folded
 *  into the shared activity gates (otherActivityActive, feed.ts's yield) so this
 *  pending pickup OWNS the moment like the carry flows — nothing else can grab
 *  the single guide arrow out from under it. */
export function getEggPending(): boolean {
  return pendingEgg !== null
}

/** Adoption confirmed: send the player to the Caretaker to collect the egg. If
 *  they're already there (e.g. the first-pet intro parks them at the Caretaker),
 *  hand it over immediately — no pointless walk. */
export function startGetEgg(species: string, name: string): void {
  // One egg at a time — a second Adopt would silently drop the first one's
  // chosen species/name (the pending egg isn't in player.pets yet, so the
  // free-slot check still passes and the panel stays reachable).
  if (pendingEgg) {
    pushToast('Go to the Caretaker to pick up your egg first!')
    return
  }
  const caretaker = objectPosition(EntityNames.Caretaker_glb)
  if (distFlat(playerPos(), caretaker) <= CARETAKER_EGG_REACH) {
    startCarryEgg(species, name)
    return
  }
  pendingEgg = { species, name }
  showArrowTo(caretaker, 'getEgg')
  pushToast('Go to the Caretaker to pick up your egg!')
}

/** Abandon a pending pickup (BACK on GetEggOverlay). Nothing is committed
 *  server-side yet, so this just drops the local intent + guide arrow. */
export function cancelGetEgg(): void {
  if (!pendingEgg) return
  pendingEgg = null
  hideArrow('getEgg')
  pushToast('Adoption cancelled')
}

/** Per-frame while an egg is waiting at the Caretaker: keep the arrow pointing at
 *  them, and hand the egg over the moment the player arrives. */
function updateGetEgg(): void {
  if (!pendingEgg) return
  // Yield the shared arrow to a carry flow that legitimately holds it (a pet
  // could be adopted mid-bath-carry / while already carrying an egg): don't
  // re-assert it, and don't hand this egg over while the player's hands are
  // full. The pickup resumes the moment that flow ends.
  if (clientState.carryEgg.active || clientState.carryPet.active) return
  const caretaker = objectPosition(EntityNames.Caretaker_glb)
  if (distFlat(playerPos(), caretaker) <= CARETAKER_EGG_REACH) {
    const { species, name } = pendingEgg
    pendingEgg = null
    hideArrow('getEgg')
    startCarryEgg(species, name) // now attach the egg — existing carry-home -> hatch flow
  } else {
    showArrowTo(caretaker, 'getEgg') // re-assert (arrow ownership can lapse between flows)
  }
}

export function startCarryEgg(species: string, name: string, isBreed = false): void {
  carryIsBreed = isBreed
  clientState.carryEgg = { active: true, species, name, atHome: false }

  // An empty follows the right hand; the egg is a child offset into the palm.
  if (!carriedEggAnchor) carriedEggAnchor = engine.addEntity()
  Transform.createOrReplace(carriedEggAnchor, {})
  AvatarAttach.createOrReplace(carriedEggAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })

  if (!carriedEgg) carriedEgg = engine.addEntity()
  Transform.createOrReplace(carriedEgg, { parent: carriedEggAnchor, position: EGG_HAND_OFFSET, rotation: EGG_HAND_ROTATION, scale: Vector3.scale(Vector3.One(), EGG_HAND_SCALE) })
  GltfContainer.createOrReplace(carriedEgg, { src: EGG_MODEL })
  Animator.createOrReplace(carriedEgg, { states: [{ clip: 'Idle', playing: true, loop: true }] })

  playHoldEmote() // pose the arms as if holding the egg

  openDialog('Your Egg', ['Take it home and hatch it! Walk back to your house, then tap Hatch.'], 'Got it!', () =>
    pushToast('Take your egg home to hatch it!')
  )
}

/** Per-frame while carrying: flag whether the player is home (drives the Hatch button). */
function updateCarryEgg(): void {
  const st = clientState.carryEgg
  if (!st.active) return
  const pp = playerPos()
  const home = objectPosition(EntityNames.HomeDome01_glb)
  st.atHome = distFlat(pp, home) <= C.HOME_RADIUS
  // Guide arrow points home until you're there (where the Hatch button shows).
  if (st.atHome) hideArrow('carryEgg')
  else showArrowTo(home, 'carryEgg')
}

/** Hatch button pressed at home: drop the carried egg and start the rub flow. */
export function beginHatchFromCarry(): void {
  const st = clientState.carryEgg
  if (!st.active) return
  const { species, name } = st
  if (carriedEgg) {
    engine.removeEntity(carriedEgg)
    carriedEgg = null
  }
  if (carriedEggAnchor) {
    engine.removeEntity(carriedEggAnchor)
    carriedEggAnchor = null
  }
  clientState.carryEgg = { active: false, species: '', name: '', atHome: false }
  stopHoldEmote() // drop the hold pose, egg is no longer in hand
  hideArrow('carryEgg') // stop guiding home, the egg is no longer being carried
  startHatch(species, name)
}

/** Begin the adoption hatch: spawn the egg (Idle loop), frame it, freeze avatar. */
export function startHatch(species: string, name: string): void {
  hatchSpecies = species
  hatchName = name
  clientState.hatch.active = true
  clientState.hatch.progress = 0
  hatchAnimT = 0
  hatchRevealed = false
  hatchEggRemoved = false

  // Egg hatches ON the Nest inside the house (not in front of the player), framed
  // by a dedicated camera; the pet then reveals at that same spot before relocating.
  const eggPos = Vector3.create(NEST_POS.x, NEST_POS.y + NEST_EGG_LIFT, NEST_POS.z)
  hatchRevealPos = eggPos

  if (!egg) egg = engine.addEntity()
  Transform.createOrReplace(egg, { position: eggPos, scale: Vector3.One() })
  GltfContainer.createOrReplace(egg, { src: EGG_MODEL })
  Animator.createOrReplace(egg, {
    states: [
      { clip: 'Idle', playing: true, loop: true },
      { clip: 'Hatch', playing: false, loop: false, shouldReset: true }
    ]
  })

  // Invisible focus fixed at the egg's spot (raised to the pet's body). The
  // camera locks onto THIS, not the egg — so when the egg is removed the shot
  // stays put and you watch the pet appear right where the egg opened.
  if (!hatchFocus) hatchFocus = engine.addEntity()
  Transform.createOrReplace(hatchFocus, { position: Vector3.create(eggPos.x, eggPos.y + 0.4, eggPos.z) })

  // Sit the camera on the nest's front bearing so it looks at the egg head-on,
  // not from the side (the nest is rotated toward the door, so a fixed +Z camera
  // caught it edge-on).
  const camRad = (HATCH_CAM_YAW * Math.PI) / 180
  const camPos = Vector3.create(eggPos.x + Math.sin(camRad) * HATCH_CAM_DIST, eggPos.y + HATCH_CAM_HEIGHT, eggPos.z + Math.cos(camRad) * HATCH_CAM_DIST)
  if (!petCam) petCam = engine.addEntity()
  Transform.createOrReplace(petCam, { position: camPos })
  VirtualCamera.createOrReplace(petCam, { lookAtEntity: hatchFocus })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: petCam })
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
}

/** Bar full: play the Hatch clip and start the reveal timeline. */
function startHatchAnim(): void {
  clientState.hatch.progress = 1
  hatchAnimT = 0
  if (egg) {
    const a = Animator.getMutable(egg)
    for (const s of a.states) s.playing = s.clip === 'Hatch' // Idle -> Hatch (one-shot)
  }
}

/** Reveal the pet (~when the egg opens): tell the server, pop it in at the egg. */
function revealHatchedPet(): void {
  hatchRevealed = true
  // Adoption: create the pet now (optimistic + tell the server). Breeding: the
  // offspring already exists as the server's hatchling, so just reveal it.
  if (!carryIsBreed) adoptPet(hatchSpecies, hatchName)
  hatchPopT = HATCH_POP_SECONDS
  pushToast(`Your ${speciesLabel(hatchSpecies)} hatched!`)
}

/** Admire beat over: hand the camera + avatar control back to the player. */
function finishHatch(): void {
  clientState.hatch.active = false
  clientState.hatch.progress = 0
  if (egg) {
    engine.removeEntity(egg)
    egg = null
  }
  if (hatchFocus) {
    engine.removeEntity(hatchFocus)
    hatchFocus = null
  }
  releasePettingView() // release camera + avatar (shared helper)
  hatchRevealPos = null
  carryIsBreed = false
}

/** Register a tap on the egg (mobile fill) — see petTap for the why. */
export function hatchTap(): void {
  const st = clientState.hatch
  if (!st.active || st.progress >= 1) return // ignore taps once it's hatching
  st.progress += C.PET_TAP_FILL
  if (st.progress >= 1) startHatchAnim()
}

/** Per-frame hatch update: rub to fill (progress<1), then run the Hatch timeline. */
function updateHatch(dt: number): void {
  const st = clientState.hatch
  if (!st.active) return

  if (st.progress < 1) {
    // Still rubbing — Idle loops on the egg; fill the bar.
    st.progress = gestureFill(st.progress, dt)
    if (st.progress >= 1) startHatchAnim()
    return
  }

  // Hatching timeline: reveal the pet as the egg opens, remove the egg once the
  // Hatch clip ends (camera is already on the pet, so no jump), then let the
  // camera linger on the newborn before handing control back.
  hatchAnimT += dt
  if (!hatchRevealed && hatchAnimT >= PET_EMERGE_AT) revealHatchedPet()
  if (!hatchEggRemoved && hatchAnimT >= HATCH_ANIM_SECONDS) {
    hatchEggRemoved = true
    if (egg) {
      engine.removeEntity(egg)
      egg = null
    }
  }
  if (hatchAnimT >= HATCH_ANIM_SECONDS + HATCH_ADMIRE_SECONDS) finishHatch()
}

export function setFollow(enabled: boolean): void {
  clientState.followEnabled = enabled
  actions.setFollow(enabled) // tell the server so others mirror our follow/stay
  if (enabled) {
    mode = 'follow'
  } else {
    mode = 'wander'
    wanderHome = localPet ? Transform.get(localPet).position : wanderHome
    wanderTarget = null
    wanderPause = 1
  }
}

function playerPos(): Vector3 {
  if (!Transform.has(engine.PlayerEntity)) return Vector3.create(199.2, 0, 231.8)
  return Transform.get(engine.PlayerEntity).position
}

function followTarget(): Vector3 {
  const pp = playerPos()
  return Vector3.create(pp.x - C.PET_FOLLOW_DISTANCE, C.PET_BASE_Y, pp.z - C.PET_FOLLOW_DISTANCE)
}

// --- Follow-the-leader breadcrumb trail ------------------------------------
// The pet follows the player by RETRACING the player's recent path, not by
// steering at the player's current position. The player can't walk through walls
// or models (they have colliders), so their trail is collision-free by
// construction — the pet inherits that and goes through the door because the
// player did. This replaces the footprint/door math for following (and the
// threshold oscillation it caused). Wander/goto still use nav (they stay outside).
const TRAIL_SPACING = 0.4 // record a new breadcrumb after the player moves this far (m)
const TRAIL_TELEPORT = 8 // a player jump larger than this = teleport -> reset the trail
const TRAIL_MAX = 96 // hard cap on stored breadcrumbs (~38 m) — bounds trailPathLength()'s per-frame cost on mobile
const FOLLOW_SUSPEND_SLACK = 2.0 // how far past follow distance still counts as "near the player"
const FOLLOW_WALL_KEEP = 2.5 // stay on the breadcrumb trail within this of any wall (clean door crossing)
let followTrail: Vector3[] = []

/** Append the player's position to the trail (call once per frame). The full Y is
 *  kept (not flattened) so the pet inherits the player's HEIGHT along the path —
 *  it rises where the player walked up onto the raised house / care-center bases. */
function recordTrail(): void {
  const src = playerPos()
  const pp = Vector3.create(src.x, src.y, src.z)
  if (followTrail.length === 0) {
    followTrail.push(pp)
    return
  }
  const last = followTrail[followTrail.length - 1]
  const d = distFlat(pp, last) // spacing is horizontal, so height changes don't spam crumbs
  if (d > TRAIL_TELEPORT) {
    followTrail = [pp] // teleport (e.g. Choose Location) -> drop the stale path
    return
  }
  if (d >= TRAIL_SPACING) {
    followTrail.push(pp)
    if (followTrail.length > TRAIL_MAX) followTrail.shift()
  }
}

/** Remaining distance from the pet, ALONG the trail, to the player. Using path
 *  length (not straight line) is what keeps a wall between them from stopping the
 *  pet early — the path goes the long way, through the door. */
function trailPathLength(petPos: Vector3): number {
  if (followTrail.length === 0) return distFlat(petPos, playerPos())
  let total = distFlat(petPos, followTrail[0])
  for (let i = 0; i < followTrail.length - 1; i++) total += distFlat(followTrail[i], followTrail[i + 1])
  return total + distFlat(followTrail[followTrail.length - 1], playerPos())
}

function updateWander(dt: number): number {
  if (wanderPause > 0) {
    wanderPause -= dt
    return 0
  }
  if (!wanderTarget || (localPet && distFlat(Transform.get(localPet).position, wanderTarget) <= C.PET_ARRIVE_DISTANCE)) {
    if (wanderTarget) {
      // Arrived: idle for a moment before choosing a new spot.
      wanderTarget = null
      wanderPause = 1.5 + Math.random() * 2.5
      return 0
    }
    const r = 3 + Math.random() * 3
    const ang = Math.random() * Math.PI * 2
    const cand = Vector3.create(wanderHome.x + Math.cos(ang) * r, C.PET_BASE_Y, wanderHome.z + Math.sin(ang) * r)
    // Don't wander INTO a building — pick a spot in the open, or just idle this
    // round if the roll landed inside one (next round tries again).
    if (pointInsideAnyBuilding(cand)) {
      wanderPause = 0.5
      return 0
    }
    wanderTarget = cand
  }
  return localPet ? navStepToward(localPet, wanderTarget, dt, yawOffsetForSpecies(clientState.activePet?.species ?? '')) : 0
}

function updateLocalPet(dt: number): void {
  ensureLocalPet()
  if (!localPet) return

  // During the tree game the pet waits beside the lane, sitting and watching
  // rather than disappearing. The final feeding shot takes over separately.
  if (clientState.feedGame.active && clientState.feedGame.phase !== 'feeding' && clientState.feedGame.phase !== 'results') {
    const sit = clientState.feedGame.petSitPos
    if (sit) {
      VisibilityComponent.createOrReplace(localPet, { visible: true })
      const transform = Transform.getMutable(localPet)
      transform.position = Vector3.create(sit.x, C.PET_BASE_Y, sit.z)
      const look = clientState.feedGame.petSitLook ?? sit
      transform.rotation = yawToward(transform.position, Vector3.create(look.x, C.PET_BASE_Y, look.z), yawOffsetForSpecies(clientState.activePet?.species ?? ''))
      setClip(localPet, 'sit')
    } else {
      VisibilityComponent.createOrReplace(localPet, { visible: false })
    }
    if (localTag) setTagVisible(localTag, false)
    return
  }
  // Undo that hide once the minigame ends — every other branch below assumes
  // visible unless it says otherwise. Route the tag through setTagVisible with the
  // carry-flow + speech-bubble state (NOT blindly visible), otherwise this runs
  // every frame and clobbers the speech bubble's tag suppression — the pet's mood
  // icons would flash back on while it's talking.
  VisibilityComponent.createOrReplace(localPet, { visible: true })
  if (localTag) setTagVisible(localTag, localTagWanted && !tagsSuppressed)

  // During the bubble-bath minigame the pet stays put in the tub (where
  // placePetAtStation teleported it) and just idles — don't let the follow/roam
  // logic below walk it away while the player is popping bubbles.
  if (clientState.bathGame.active) {
    setClip(localPet, 'idle')
    return
  }

  // While carrying a new egg (or hatching it, before the newborn emerges), send
  // the CURRENT pet to its home slot and park it there. This clears the hatch
  // spot in front of the player so the new pet won't spawn on top of this one.
  if ((clientState.carryEgg.active || (clientState.hatch.active && !hatchRevealed)) && clientState.activePet) {
    const petP = clientState.activePet
    // A breed offspring already exists as the hatchling and IS the active pet —
    // keep it hidden until it emerges from the egg, instead of it standing around.
    const hatchlingId = clientState.player?.hatchling?.id
    if (hatchlingId && petP.id === hatchlingId) {
      VisibilityComponent.createOrReplace(localPet, { visible: false })
      setLocalTagVisible(false)
      return
    }
    // Otherwise (adoption) the CURRENT pet steps aside to its home slot so the
    // hatch spot in front of the player is clear.
    const idx = activePetSlotIndex()
    const moved = idx >= 0 ? stepToward(localPet, slotHome(idx), dt, yawOffsetForSpecies(petP.species)) : 0
    setClip(localPet, moved > 0.003 ? 'walk' : 'idle')
    if (localTag) updateTag(localTag, Transform.get(localPet).position, petP.species, petP.size, petP.name, petP)
    return
  }

  // During the hatch sequence: keep the newborn at the egg's spot playing idle,
  // pop its scale in, and re-point the camera from the egg onto the pet so there's
  // no jump when the egg is removed. Normal behavior resumes once hatch ends.
  if (clientState.hatch.active && clientState.activePet) {
    const petH = clientState.activePet
    // Undo any hide from the carry phase — the newborn is emerging now.
    VisibilityComponent.createOrReplace(localPet, { visible: true })
    setLocalTagVisible(true)
    const full = petScale(petH.species, stageScaleFor(petH.size))
    if (hatchPopT > 0) hatchPopT -= dt
    const f = hatchPopT > 0 ? Math.max(0.05, 1 - hatchPopT / HATCH_POP_SECONDS) : 1 // 0 -> 1
    const t = Transform.getMutable(localPet)
    t.scale = Vector3.scale(full, f)
    if (hatchRevealPos) t.position = Vector3.create(hatchRevealPos.x, C.PET_BASE_Y + HATCH_PET_LIFT, hatchRevealPos.z)
    // The hatch camera sits on this bearing, so explicitly face the newborn
    // toward it instead of retaining its orientation from before the reveal.
    t.rotation = Quaternion.fromEulerDegrees(0, HATCH_CAM_YAW + yawOffsetForSpecies(petH.species), 0)
    setClip(localPet, 'idle')
    // Camera stays locked on hatchFocus (the egg's spot) — no retarget needed.
    if (localTag) updateTag(localTag, t.position, petH.species, petH.size, petH.name, petH)
    return
  }

  // Carrying the pet to the bath: it's attached to the player's spine bone (see
  // attachPetToHands), so its pose is handled by the renderer. Its tag is hidden
  // for the duration (attachPetToHands/detachPetFromHands) — here we just flag
  // proximity to the tub. ensureLocalPet has already applied this frame's
  // authoritative growth-stage scale; carry must not override it here.
  if (clientState.carryPet.active && clientState.activePet) {
    setClip(localPet, 'idle')
    const pp = playerPos()
    clientState.carryPet.atStation = distFlat(pp, objectPosition(EntityNames.PetPool_glb)) <= BATH_RADIUS
    return
  }

  // While the hold-to-pet overlay is up, the pet stays put and plays its happy
  // gesture — the whole focus is on petting it.
  if (clientState.petting.active) {
    setClip(localPet, 'gesture-positive')
    if (localTag) {
      const petT = clientState.activePet
      updateTag(
        localTag,
        Transform.get(localPet).position,
        petT?.species ?? null,
        petT ? petT.size : C.SIZE_BASE,
        petT ? petT.name : '',
        petT
      )
    }
    return
  }

  let moved = 0
  let moveClip: PetClip = 'walk'

  recordTrail() // keep the player's breadcrumb path fresh for follow mode

  switch (mode) {
    case 'follow': {
      // Retrace the player's breadcrumb trail (collision-free by construction) —
      // the pet walks the exact route the player took, so it enters through the
      // door instead of trying to cut across a wall.
      const petPos = Transform.get(localPet).position
      // Suspend the trail when the pet is already CLOSE to the player, in the SAME
      // zone, and both are clear of any wall: there's no wall between them so it can
      // just settle by the player instead of retracing their wiggles (kills the
      // zigzag in the open). Near a wall / different zone we keep the trail so the
      // door crossing stays clean, and going straight-to-player keeps the height
      // right (same local ground) — no far-crumb elevation artifact.
      const pp = playerPos()
      const nearPlayer = distFlat(petPos, pp) <= C.PET_FOLLOW_DISTANCE + FOLLOW_SUSPEND_SLACK
      if (nearPlayer && zoneOf(petPos) === zoneOf(pp) && !nearWall(petPos, FOLLOW_WALL_KEEP) && !nearWall(pp, FOLLOW_WALL_KEEP)) {
        followTrail.length = 0
      }
      // Drop breadcrumbs we've already reached.
      while (followTrail.length > 0 && distFlat(petPos, followTrail[0]) < C.PET_ARRIVE_DISTANCE) followTrail.shift()
      // Trail the player by the follow distance measured ALONG the path.
      if (trailPathLength(petPos) > C.PET_FOLLOW_DISTANCE + 0.5) {
        const wp = followTrail.length > 0 ? followTrail[0] : playerPos()
        // stepToward snaps Y back to PET_BASE_Y every frame, so ease the height
        // from the pet's PREVIOUS Y (captured before the step) toward the
        // breadcrumb's Y — otherwise the height keeps resetting to 0 each frame and
        // the pet only ever climbs a fraction of the way, sinking into raised bases.
        const prevY = petPos.y
        moved = stepToward(localPet, wp, dt, yawOffsetForSpecies(clientState.activePet?.species ?? ''))
        const tp = Transform.getMutable(localPet)
        const y = prevY + (wp.y - prevY) * Math.min(1, dt * 8)
        tp.position = Vector3.create(tp.position.x, y, tp.position.z)
      }
      break
    }
    case 'wander': {
      moved = updateWander(dt)
      break
    }
    case 'goto': {
      moveClip = 'run'
      // Plain direct-line movement, NOT navStepToward: care-action stations
      // (feeder/pool/bed) are fixed outdoor props, not behind a door, and
      // PetBed in particular sits close enough to the home dome's new
      // wall-avoidance footprint that navStepToward's wall-slide redirected
      // the pet around the building's ring instead of ever reaching it.
      // navStepToward is still what FOLLOW uses to trail the player through
      // doors — this only reverts the queued-errand walk.
      moved = stepToward(localPet, target, dt, yawOffsetForSpecies(clientState.activePet?.species ?? ''))
      if (distFlat(Transform.get(localPet).position, target) <= C.PET_ARRIVE_DISTANCE) {
        mode = 'interact'
        interactTimer = 1.1
        if (onArrive) {
          // Capture + clear BEFORE calling: the callback may chain another
          // sendPetTo (setting a new onArrive) that we must not clobber.
          const cb = onArrive
          onArrive = null
          cb()
        }
      }
      break
    }
    case 'interact': {
      if (justBathed) {
        bathSplashT += dt
        const splash = Math.abs(Math.sin(bathSplashT * 10)) * BATH_SPLASH_HEIGHT
        const turn = Math.sin(bathSplashT * 5) * 28
        const pt = Transform.getMutable(localPet)
        pt.position = Vector3.create(bathSplashFrom.x, bathSplashFrom.y + splash, bathSplashFrom.z)
        pt.rotation = Quaternion.fromEulerDegrees(0, turn + yawOffsetForSpecies(clientState.activePet?.species ?? ''), 0)
      }
      if (interactClip === 'eat' && eatCinematicActive) break
      interactTimer -= dt
      if (interactTimer <= 0) {
        if (justBathed) {
          justBathed = false
          const pt = Transform.getMutable(localPet)
          pt.position = bathSplashFrom
          bathHopT = BATH_HOP_DURATION
          bathHopFrom = bathSplashFrom
          mode = 'bathhop'
        } else if (clientState.activePet?.sleeping) {
          // The sleep care action just toggled `sleeping` true (onArrive, above)
          // — stay parked on the bed instead of immediately following again.
          mode = 'asleep'
        } else {
          mode = clientState.followEnabled ? 'follow' : 'wander'
        }
      }
      break
    }
    case 'asleep': {
      // Stay put — no follow/wander/goto movement while asleep (`moved` stays 0,
      // so the clip logic below plays 'sleep'). Resume as soon as it wakes.
      // Rest via sleepRestPos — the SINGLE source of truth for where a sleeping
      // pet belongs (on the bed's cushion when sleepOnBed, else lifted in place).
      // This is what makes a FRESH sleep (the care action walks the pet to a spot
      // nudged OUTSIDE the bed's building ring so navigation doesn't oscillate,
      // which left it dozing on the floor beside the bed) settle in the EXACT same
      // place as re-selecting a pet that was already asleep (settlePromotedPet).
      const pet2 = clientState.activePet
      if (pet2) {
        const st = Transform.getMutable(localPet)
        const rest = sleepRestPos(pet2, st.position)
        if (Vector3.distance(st.position, rest) > 0.001) st.position = rest
        if (!pet2.sleeping) mode = clientState.followEnabled ? 'follow' : 'wander'
      }
      break
    }
    case 'bathhop': {
      bathHopT -= dt
      const hopT = Math.min(1, 1 - Math.max(0, bathHopT) / BATH_HOP_DURATION)
      const toward = Vector3.subtract(flat(followTarget()), flat(bathHopFrom))
      const away = Vector3.lengthSquared(toward) > 0.01 ? Vector3.normalize(toward) : Vector3.create(0, 0, 1)
      const horizontal = Vector3.add(flat(bathHopFrom), Vector3.scale(away, BATH_HOP_DISTANCE * hopT))
      const pt = Transform.getMutable(localPet)
      pt.position = Vector3.create(horizontal.x, C.PET_BASE_Y + Math.sin(hopT * Math.PI) * BATH_HOP_HEIGHT, horizontal.z)
      const awayYaw = (Math.atan2(away.x, away.z) * 180) / Math.PI
      pt.rotation = Quaternion.fromEulerDegrees(0, awayYaw + yawOffsetForSpecies(clientState.activePet?.species ?? ''), 0)
      moved = 1 // plays the walk clip below instead of idle
      if (bathHopT <= 0) mode = clientState.followEnabled ? 'follow' : 'wander'
      break
    }
  }

  // Decide animation: interaction clip > movement > sleeping > idle.
  // (sleep only while standing still — a pet dozing mid-walk would just slide.)
  // A pending restartMoveClip() wins this tick — drop whatever's playing and
  // clear curClip so next tick's setClip below actually re-triggers it (see
  // restartMoveClip's doc comment for why this can't happen in one tick).
  if (moveClipRestartPending && Animator.has(localPet)) {
    moveClipRestartPending = false
    curClip.delete(localPet)
    const a = Animator.getMutable(localPet)
    for (const s of a.states) {
      if (s.playing) {
        s.playing = false
        s.shouldReset = true
      }
    }
  } else if (mode === 'interact') setClip(localPet, interactClip)
  else if (moved > 0.003) setClip(localPet, moveClip)
  else if (clientState.activePet?.sleeping) setClip(localPet, 'sleep')
  else setClip(localPet, 'idle')

  // Floating name tag follows the pet.
  if (localTag) {
    const pet2 = clientState.activePet
    updateTag(
      localTag,
      Transform.get(localPet).position,
      pet2?.species ?? null,
      pet2 ? pet2.size : C.SIZE_BASE,
      pet2 ? pet2.name : '',
      pet2
    )
  }
}

// ---------------------------------------------------------------------------
// Remote pets (social layer)
// ---------------------------------------------------------------------------
function remotePlayerPositions(): Map<string, Vector3> {
  const out = new Map<string, Vector3>()
  for (const [entity, id] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (!Transform.has(entity)) continue
    out.set(id.address.toLowerCase(), Transform.get(entity).position)
  }
  return out
}

/** Keep another player's pet out of a private-focus area. */
function setRemotePetVisible(address: string, pet: Entity, visible: boolean): void {
  const hidden = !visible
  if (hiddenRemotePets.has(address) === hidden) return

  if (hidden) hiddenRemotePets.add(address)
  else hiddenRemotePets.delete(address)

  VisibilityComponent.createOrReplace(pet, { visible })
}

function updateRemotePets(dt: number): void {
  const me = clientState.myAddress.toLowerCase()
  const positions = remotePlayerPositions()
  const seen = new Set<string>()

  for (const entry of clientState.presence) {
    const addr = entry.address.toLowerCase()
    if (addr === me) continue
    const ownerPos = positions.get(addr)
    if (!ownerPos) continue
    seen.add(addr)

    let ent = remotePets.get(addr)
    if (!ent) {
      ent = engine.addEntity()
      Transform.create(ent, { position: Vector3.create(ownerPos.x - 2, C.PET_BASE_Y, ownerPos.z - 2), scale: petScale(entry.species, stageScaleFor(entry.size)) })
      remotePets.set(addr, ent)
      remoteTags.set(addr, makeTag(false)) // another player's pet — name only
      const targetAddr = entry.address
      pointerEventsSystem.onPointerDown(
        { entity: ent, opts: { button: InputAction.IA_POINTER, hoverText: 'View', maxDistance: 8 } },
        () => {
          if (!hiddenRemotePets.has(addr)) clientState.viewingPetAddress = targetAddr
        }
      )
    }
    if (remoteSpecies.get(addr) !== entry.species) {
      remoteSpecies.set(addr, entry.species)
      GltfContainer.createOrReplace(ent, {
        src: modelForSpecies(entry.species),
        visibleMeshesCollisionMask: entry.carried ? ColliderLayer.CL_NONE : ColliderLayer.CL_POINTER
      })
      ensureAnimator(ent, entry.species)
    }
    // Re-skin on species OR rarity change (an owner swapping to a same-species pet
    // of a different rarity keeps the entity but needs a new skin).
    const rskin = `${entry.species}|${entry.rarity}`
    if (remoteSkinKey.get(addr) !== rskin) {
      remoteSkinKey.set(addr, rskin)
      applyCreatureSkin(ent, entry.species, entry.rarity)
    }
    const t = Transform.getMutable(ent)
    const s = petScale(entry.species, stageScaleFor(entry.size))
    if (t.scale.x !== s.x) t.scale = s
    const tag = remoteTags.get(addr)
    const carriedAnchor = remoteCarried.get(addr)
    if (entry.carried) {
      if (!carriedAnchor) {
        // The attachment only needs to be resolved when the owner starts
        // carrying. Recreating it each frame is expensive for every observer.
        const anchor = engine.addEntity()
        Transform.create(anchor, {})
        AvatarAttach.create(anchor, { avatarId: addr, anchorPointId: AvatarAnchorPointType.AAPT_SPINE })
        remoteCarried.set(addr, anchor)
        t.parent = anchor
        t.position = remotePetHoldOffset(entry.species, entry.size)
        t.rotation = Quaternion.fromEulerDegrees(0, yawOffsetForSpecies(entry.species) + PET_HOLD_YAW, 0)
        setRemotePetPointerCollider(ent, false)
      }
      setClip(ent, 'idle')
      setRemotePetVisible(addr, ent, !isInsidePrivateAvatarArea(ownerPos))
      if (tag) setTagVisible(tag, false)
      continue
    }
    if (carriedAnchor) {
      t.parent = engine.RootEntity
      t.position = Vector3.create(ownerPos.x - 2, C.PET_BASE_Y, ownerPos.z - 2)
      engine.removeEntity(carriedAnchor)
      remoteCarried.delete(addr)
      setRemotePetPointerCollider(ent, true)
    }
    // Follow the owner only if their pet is currently following them; otherwise
    // it stays put (mirrors the owner having dismissed it).
    const following = entry.following !== false
    let moved = 0
    if (following) {
      const dest = Vector3.create(ownerPos.x - 2, C.PET_BASE_Y, ownerPos.z - 2)
      moved = distFlat(t.position, dest) > 0.5 ? stepToward(ent, dest, dt, yawOffsetForSpecies(entry.species)) : 0
    }
    setClip(ent, moved > 0.003 ? 'walk' : 'idle')

    // The owner test keeps a following companion synchronized with its hidden
    // avatar. The pet test also keeps a dismissed pet hidden if it remains in
    // a private area after its owner has walked away.
    const visible = !isInsidePrivateAvatarArea(ownerPos) && !isInsidePrivateAvatarArea(t.position)
    setRemotePetVisible(addr, ent, visible)
    setRemotePetPointerCollider(ent, visible)
    if (tag) setTagVisible(tag, visible)
    if (tag) updateTag(tag, t.position, entry.species, entry.size, entry.name, null)
  }

  for (const [addr, ent] of remotePets) {
    if (!seen.has(addr)) {
      engine.removeEntity(ent)
      remotePets.delete(addr)
      remoteSpecies.delete(addr)
      remoteSkinKey.delete(addr)
      const carriedAnchor = remoteCarried.get(addr)
      if (carriedAnchor) {
        engine.removeEntity(carriedAnchor)
        remoteCarried.delete(addr)
      }
      hiddenRemotePets.delete(addr)
      forgetAnimator(ent)
      const tag = remoteTags.get(addr)
      if (tag) {
        removeTag(tag)
        remoteTags.delete(addr)
      }
      // Close their passport if it was open — otherwise it silently vanishes
      // now but would re-pop back open on its own if they return.
      if (clientState.viewingPetAddress?.toLowerCase() === addr) clientState.viewingPetAddress = null
    }
  }
}

// ---------------------------------------------------------------------------
// Inactive (stored, non-selected) pets — roam the care area on their own.
// ---------------------------------------------------------------------------
function updateInactivePets(dt: number): void {
  const p = clientState.player
  const wanted = new Set<string>()

  if (p) {
    // Exclude the pet currently shown as the ACTIVE localPet (which may be the
    // pending hatchling, not yet in p.pets) — never by activePetId, or a pet
    // would vanish during the hatch window.
    const shownId = clientState.activePet?.id
    for (let index = 0; index < p.pets.length; index++) {
      const pet = p.pets[index]
      if (pet.id === shownId) continue
      wanted.add(pet.id)
      const home = slotHome(index) // this pet's fixed slot

      let st = inactivePets.get(pet.id)
      if (!st) {
        // Re-show this pet's ORIGINAL entity if it was parked (returned to the
        // roster): its model + skin are still intact, so re-applying them would
        // be the very reset we avoid. Only build + skin a brand-new entity when
        // we've never seen this pet.
        const revived = retiredPets.get(pet.id)
        const e = revived ?? engine.addEntity()
        Transform.createOrReplace(e, { position: home, scale: petScale(pet.species, stageScaleFor(pet.size)) })
        if (revived) {
          retiredPets.delete(pet.id)
          VisibilityComponent.createOrReplace(e, { visible: true }) // parkPetEntity hid it
        } else {
          GltfContainer.createOrReplace(e, { src: modelForSpecies(pet.species), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
          applyCreatureSkin(e, pet.species, pet.rarity)
        }
        ensureAnimator(e, pet.species)
        const petId = pet.id
        pointerEventsSystem.onPointerDown(
          { entity: e, opts: { button: InputAction.IA_POINTER, hoverText: `Select ${pet.name}`, maxDistance: 8 } },
          () => switchActivePet(petId)
        )
        st = { entity: e, species: pet.species, tag: makeTag(false), home, target: null, pause: Math.random() * 2 } // owner's own pet — mood icons replaced by petEmotes.ts's floating emote
        inactivePets.set(pet.id, st)
      }
      st.home = home // keep anchored to its slot even if the roster reorders
      if (st.species !== pet.species) {
        st.species = pet.species
        GltfContainer.createOrReplace(st.entity, { src: modelForSpecies(pet.species), visibleMeshesCollisionMask: ColliderLayer.CL_POINTER })
        ensureAnimator(st.entity, pet.species)
        applyCreatureSkin(st.entity, pet.species, pet.rarity)
      }

      // Wander in a SMALL radius around its slot, so it stays in its own spot.
      let moved = 0
      if (st.pause > 0) {
        st.pause -= dt
      } else if (!st.target || distFlat(Transform.get(st.entity).position, st.target) <= C.PET_ARRIVE_DISTANCE) {
        if (st.target) {
          st.target = null
          st.pause = 1.5 + Math.random() * 3
        } else {
          const r = 0.6 + Math.random() * 1.0
          const ang = Math.random() * Math.PI * 2
          st.target = Vector3.create(st.home.x + Math.cos(ang) * r, C.PET_BASE_Y, st.home.z + Math.sin(ang) * r)
        }
      } else {
        // navStepToward (not stepToward) so a just-demoted pet walking back from
        // wherever it was deselected — possibly inside/near the dome — routes
        // around walls instead of beelining through them.
        moved = navStepToward(st.entity, st.target, dt, yawOffsetForSpecies(pet.species))
      }
      setClip(st.entity, moved > 0.003 ? 'walk' : 'idle')

      const t = Transform.getMutable(st.entity)
      const s = petScale(pet.species, stageScaleFor(pet.size))
      if (t.scale.x !== s.x) t.scale = s
      updateTag(st.tag, t.position, pet.species, pet.size, pet.name, pet)
    }
  }

  for (const [id, st] of inactivePets) {
    if (!wanted.has(id)) {
      // A pet left the roster (traded away / discarded). Park its skinned
      // creature off-map instead of engine.removeEntity — destroying it fires
      // Unity's ResetMaterialSystem (desktop crash). The tag carries no material
      // override, so removing it stays safe.
      parkPetEntity(id, st.entity)
      removeTag(st.tag)
      inactivePets.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------
// Sleep-lock countdown — a floating "M:SS" over the pet while its exhaustion nap
// is locked (SLEEP_LOCK_MS). Sits just above the name tag; hidden otherwise.
// ---------------------------------------------------------------------------
let sleepLabel: Entity | null = null
// Raised from 0.7 to clear petEmotes.ts's floating sleep-emote plane (sits
// ~0.65-0.9m above the name tag), which it was overlapping/mixing with.
const SLEEP_LABEL_LIFT = 1.3 // metres above the name tag

function updateSleepCountdown(): void {
  if (sleepLabel === null) {
    sleepLabel = engine.addEntity()
    Transform.create(sleepLabel, { position: Vector3.create(0, -100, 0), scale: Vector3.Zero() })
    Billboard.create(sleepLabel, {})
    TextShape.create(sleepLabel, {
      text: '',
      fontSize: 2.6,
      textColor: { r: 1, g: 0.98, b: 0.85, a: 1 },
      outlineColor: { r: 0.15, g: 0.1, b: 0.28 },
      outlineWidth: 0.22
    })
  }
  const t = Transform.getMutable(sleepLabel)
  const ts = TextShape.getMutable(sleepLabel)
  const pet = clientState.activePet
  const left = pet ? C.sleepLockRemaining(pet, Date.now()) : 0
  if (localPet === null || !pet || left <= 0 || !petIsPresent()) {
    if (ts.text !== '') ts.text = ''
    if (t.scale.x !== 0) t.scale = Vector3.Zero()
    return
  }
  const pos = Transform.get(localPet).position
  const tune = petOverheadTuning(pet.species, pet.size)
  t.position = Vector3.create(pos.x, pos.y + TAG_MIN + TAG_SIZE_MULT * stageScaleFor(pet.size) + tune.nameLift + SLEEP_LABEL_LIFT, pos.z)
  t.scale = Vector3.One()
  ts.text = C.formatLockCountdown(left)
}

// Scale the shared PetBed to match the growth stage of the pet sleeping on it, so a
// tiny Junior doesn't nap on an adult-sized bed (and an Adult doesn't dwarf it). The
// composite bed size is treated as the ADULT reference; smaller stages shrink it in
// the same proportion the pet does (stageScaleFor). Resets to full when nobody's on it.
let bedBaseScale: Vector3 | null = null
function updateSleepBedScale(): void {
  const bed = engine.getEntityOrNullByName(EntityNames.PetBed_glb)
  if (!bed || !Transform.has(bed)) return
  const t = Transform.getMutable(bed)
  // Capture the composite (adult-reference) scale once, before we ever mutate it.
  if (!bedBaseScale) bedBaseScale = Vector3.create(t.scale.x, t.scale.y, t.scale.z)
  const pet = clientState.activePet
  const onBed = !!pet && pet.sleeping && pet.sleepOnBed
  const factor = onBed ? sleepBedFactor(pet) : 1
  const sx = bedBaseScale.x * factor
  if (Math.abs(t.scale.x - sx) > 0.0001) {
    t.scale = Vector3.create(bedBaseScale.x * factor, bedBaseScale.y * factor, bedBaseScale.z * factor)
  }
}

export function setupPetSystems(): void {
  placeNest() // the in-house hatching nest (eggs hatch on top of it)
  engine.addSystem((dt: number) => {
    updateGetEgg()
    updateCarryEgg()
    updateArrow()
    updateHatch(dt)
    updatePetting(dt)
    updateLocalPet(dt)
    updateSleepCountdown()
    updateSleepBedScale()
    updateInactivePets(dt)
    updateRemotePets(dt)
  })
}

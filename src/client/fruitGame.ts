// Feed tree minigame (hand-off from feed.ts once the walk-to-tree errand
// reaches the tree — no click needed). Short cinematic (freeze, camera cut,
// "hands up" pose) then fruit fall from the canopy one per slot; walk
// left/right to catch them before they land. Hunger restored at the end
// scales with how many were caught (sim.ts's applyFeedMinigameLocal /
// server/state.ts's feedFromMinigame).

import {
  engine,
  Entity,
  Transform,
  GltfContainer,
  ColliderLayer,
  VisibilityComponent,
  Tween,
  TweenSequence,
  tweenSystem,
  EasingFunction,
  VirtualCamera,
  MainCamera,
  InputModifier,
  AvatarAttach,
  AvatarAnchorPointType,
  AudioSource,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Billboard
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { actions, clientState, pushToast } from './state'
import { applyDefaultTouchControls, applyFruitGameTouchControls } from './touchControls'
import { mobile } from './ui/theme'
import { applyFeedMinigameLocal } from './sim'
import { triggerHoldEmote, stopHoldEmote } from './holdEmote'

const FRUIT_MODELS = [
  'assets/Models/Fruit01.glb',
  'assets/Models/Fruit02.glb',
  'assets/Models/Fruit03.glb',
  'assets/Models/Fruit04.glb',
  'assets/Models/Fruit05.glb'
]
const NUM_FRUIT_SLOTS = 5
// Visual scale applied to every fruit (falling + fallen clutter). Cosmetic
// only — catching is a point check against the fruit's pivot vs the player
// (CATCH_RADIUS / CATCH_MIN_Y / CATCH_MAX_Y below), so the mesh size doesn't
// change difficulty. Set to 1 for the model's native size.
const FRUIT_SCALE = 1.2

const FRUIT_PICK_SOUND = 'assets/sounds/fruit_pick2.wav'

// Invisible walls placed in the composite (assets/asset-packs/invisible_wall)
// penning the player into the catch lane: lane_1/lane_2 are the long front/back
// walls (block wandering toward/away from the camera), lane_3/lane_4 are the
// short end-caps (block wandering past the left/right extremes). They ship
// with collision off in the composite — toggled on only while catching.
// IMPORTANT: these (and cinematic_point/cinematic_play_spawnpoint) must stay
// NOT networked (no Network-Entity/Sync-Components in the composite). This is
// a per-player mechanic — if GltfContainer were synced, one player's collider
// toggle here would broadcast to every connected client via CRDT, blocking
// movement for players who aren't even in the minigame. If Creator Hub
// re-enables sync on these next time the scene is opened/saved, strip it again.
const LANE_ENTITY_NAMES = [EntityNames.lane_1, EntityNames.lane_2, EntityNames.lane_3, EntityNames.lane_4]

// As placed in the composite, lane_1/lane_2 sit only ~0.78m apart (measured
// from their actual Transforms) — confirmed too tight to strafe in on desktop
// specifically (mobile's own framing/movement is fine as-is at that width, so
// this is gated to desktop only). Widened once at runtime — they're invisible,
// so nudging their position has no visual effect — rather than needing a
// composite re-edit for a collision-only fix.
const LANE_DEPTH_EXTRA = 1.2 // total metres of extra clearance added, split evenly between the two walls
let laneDepthWidened = false

// GltfContainer defaults to CL_POINTER | CL_PHYSICS when unset — without this,
// every fruit (and the held drawer, which follows the player everywhere) is a
// solid physics body, which for the drawer means a collider wall glued to the
// avatar that blocks its own movement.
const NO_COLLISION = { visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE }

const GAME_DURATION_S = 30
const FALL_DURATION_MS = 1800
const MIN_HANG_S = 1.2
const MAX_HANG_S = 2.5
const RESPAWN_DELAY_S = 0.8
const CATCH_RADIUS = 1.1 // metres, flat XZ
// Catch window is mid-air only. A fully fallen fruit rests at groundY +
// FRUIT_GROUND_OFFSET (0.3); CATCH_MIN_Y sits ABOVE that so a fruit that has
// already landed (or is about to, on the same frame its fall tween completes)
// is NOT catchable — it reads as a miss / ground clutter instead. Raising it
// here is what stops "picking fruit off the ground".
const CATCH_MIN_Y = 0.7 // above ground
const CATCH_MAX_Y = 2.4
// On a catch the fruit isn't hidden on the spot — it's reparented ONTO the
// drawer (same as the catch-burst circle) and tweened, in the drawer's local
// space, from just above the circle spot down into it, then unparented + hidden
// (see resolveFruit / the 'caught' phase in fruitTick). Parenting means it
// tracks the box wherever the player is, instead of a world-space guess that
// kept landing on the avatar's hips.
const CATCH_SUCK_MS = 280 // fruit's travel-into-the-box time — long enough to read, not a blink
const FRUIT_SUCK_START_LOCAL = Vector3.create(0, 0.6, 0.15) // offset ABOVE CATCH_BURST_LOCAL_OFFSET where the tween starts
// Fruit01-05's pivots all sit well above their base (measured ~0.24-0.36m) —
// landing them exactly at groundY buries most of the model, leaving only the
// stem poking out. Lift the resting height so they actually sit ON the ground.
const FRUIT_GROUND_OFFSET = 0.3

// Missed fruit don't just vanish — they get a small bounce+spin (see
// playLandBounce) and stay lying on the ground as clutter until the round
// ends. These are SEPARATE decorative entities from the catchable fruit pool
// (which keeps respawning on its own timer as before) — otherwise a few early
// misses would permanently eat into the limited number of drops for the rest
// of the round.
const GROUND_CLUTTER_COUNT = 8
const LAND_BOUNCE_HEIGHT = 0.22
const LAND_BOUNCE_UP_MS = 180
const LAND_BOUNCE_DOWN_MS = 220

// Catch feedback: a soft glow sprite (circle_01.png on a camera-facing plane)
// that pops in at the caught fruit's position, expands, fades, and vanishes —
// a purely local, cosmetic "you got that one" cue on top of the existing
// counter bump / screen flash / pick sound in resolveFruit. Pooled at the
// fruit-slot count so several near-simultaneous catches each get their own.
const CATCH_BURST_TEXTURE = 'assets/images/circle_01.png'
const CATCH_BURST_COUNT = NUM_FRUIT_SLOTS
const CATCH_BURST_START_SCALE = 0.2
const CATCH_BURST_END_SCALE = 1.6
const CATCH_BURST_GROW_MS = 240 // grow (scale tween) at full opacity
const CATCH_BURST_FADE_MS = 220 // then lerp alpha/emissive to 0 and hide
// The pop is PARENTED to `drawerEntity` (the box/crate cradled in both hands),
// so it rides with the box as the player strafes instead of being placed at a
// world-space guess near the avatar root (which landed near the hips). This is
// the local offset from that box's own origin — nudge up/forward to sit it on
// the lip of the box / in the hands. NOTE: the box is held at scale
// DRAWER_HOLD_SCALE, so this offset (and the sprite) inherit that scale.
const CATCH_BURST_LOCAL_OFFSET = Vector3.create(0, 0.6, 0.1)
const CATCH_BURST_TINT = Color4.create(0.55, 1, 0.7, 1) // light minty green (tints both emissive + albedo)
const CATCH_BURST_EMISSIVE = 2.4 // emissive glow strength — higher = brighter/lighter bloom

// Miss feedback: a scorch/splat decal (scorch_03.png) laid FLAT on the ground
// where an uncaught fruit hit — same pop-grow-then-fade idea as the catch
// burst, but a ground plane (not a billboard), no glow, and it lingers a few
// seconds. Purely cosmetic; the fallen-fruit ground clutter still drops as
// before. Pooled at GROUND_CLUTTER_COUNT so a streak of misses each get one.
const SCORCH_TEXTURE = 'assets/images/scorch_03.png'
const SCORCH_COUNT = GROUND_CLUTTER_COUNT
const SCORCH_START_SCALE = 0.6
const SCORCH_END_SCALE = 1.15 // metres across (plane is 1x1 at scale 1)
const SCORCH_GROW_MS = 300 // pop out to full size
const SCORCH_HOLD_MS = 2500 // sit at full opacity
const SCORCH_FADE_MS = 3000 // then fade away — total lifetime ~5.8s
const SCORCH_Y_OFFSET = 0.04 // lift off the floor to avoid z-fighting
const SCORCH_TINT = Color4.create(0.32, 0.2, 0.11, 1) // dark muddy splat — RGB only, alpha is driven by the fade

// Adjustment applied to the composite-placed cinematic_point marker — closer
// to, and lower than, the raw spot. This is also the "pulled back" game-camera
// position the cinematic zooms IN from and, later, back OUT to. Mobile only.
// These are `let`, not `const` — see debugCam* below, a runtime calibration
// panel (DEBUG builds/testing only) that nudges them live and prints the
// final numbers to copy back in here once you're happy with the framing.
let CAM_CLOSER_DIST = 3.5
let CAM_RAISE = -2.0
// Same idea, much lighter touch — desktop has no zoom/close shot, this is
// just a small correction on the single camera position it uses throughout.
let DESKTOP_CAM_CLOSER_DIST = 3.3
let DESKTOP_CAM_RAISE = -1.0
// Added on top of CAMERA_LOOK_HEIGHT for desktop only, so its one camera
// looks a bit higher (both during the arrival beat and gameplay, since
// desktop uses the same framing for both).
let DESKTOP_LOOK_HEIGHT_BOOST = -0.5
// Horizontal look offset for desktop's single continuous shot (metres, along
// +rightRef) — desktop has no separate arrival target, so this is the only
// way to turn/pan that one camera left or right instead of it staying pinned
// dead-center on the spawnpoint.
let DESKTOP_LOOK_LEFT = 0.6
// Where the arrival/intro shot looks (both the wide starting frame and the
// close zoomed-in hold use this same target) — higher above ground, and
// shifted toward the player's own left (confirmed direction: +rightRef) so
// the shot doesn't read as dead-center/tilted.
let ARRIVAL_LOOK_HEIGHT = 3.0
let ARRIVAL_LOOK_LEFT = 0.7 // metres, along +rightRef
// The close "personal" shot for the reveal: this many metres from the player,
// same height as the wide game-camera position.
let CLOSE_CAM_DIST = 3.0
const ZOOM_IN_MS = 1000

// Freeze -> emote reveal timeline (seconds since intro began). The crate
// reveal is delayed a little past the emote trigger so it pops in once the
// arms have actually reached the holding pose, instead of appearing mid-swing
// and looking like it jumps into place once the pose catches up. After that,
// 'intro' just sits there (parked) — no auto-advance — until the player taps
// Start (startCatchingCountdown), which runs a 3-2-1 before catching begins.
const INTRO_EMOTE_AT_S = 0.9
const DRAWER_REVEAL_DELAY_S = 0.35
export const COUNTDOWN_S = 3 // exported so ui.tsx's countdown number matches this exactly

// Arrival: we can't script the avatar's own walking (its Transform is
// engine-controlled), so rather than wait for the player to walk closer, the
// teleport/freeze happen immediately on hand-off. There's only ONE camera
// entity for the whole cinematic (cinCam) — it never gets swapped for a
// different one, it's just re-Tweened, always between points computed only
// from cinematic_point/spawnpoint (never a snapshot of the player's native
// follow-cam — that camera's own rig differs between desktop and mobile, so
// panning in from it made the cinematic start from a different angle per
// platform, which is the opposite of what we want):
//  1. cinCam activates at the wide game-camera position (looking at the
//     now-arrived avatar) — its own defaultTransition blends the cut in from
//     wherever the player's live follow-cam was, instead of hard-popping
//     there the instant the trigger fires.
//  2. Immediately Tweens IN to a close "personal" shot near the avatar, for
//     the hands-up reveal + "move left/right" hint.
//  3. Once that hint goes away (Start tapped + the 3-2-1), a second Tween
//     pulls the SAME camera back OUT to the wide game-camera position and
//     re-aims it at the canopy — this is the shot gameplay actually uses.
const ARRIVAL_HOLD_S = 1.4
const GAME_CAM_PAN_MS = 800
// Blends the very first cut (live follow-cam -> cinCam) via VirtualCamera's
// own defaultTransition, instead of a hard instant snap — this is a real
// engine-side blend (unlike Tweening an already-active camera, which doesn't
// animate), since it only fires on activation/switch. Units per CameraTransition's
// own "time" field (seconds).
const ARRIVAL_CAM_TRANSITION_S = 0.8

// Geometry: invisible marker entities placed in the Creator Hub composite
// (next to the tree) drive all of this — no geometry is derived from the
// tree's own transform/rotation:
//  - "cinematic_point": the camera's fixed position.
//  - "cinematic_play_spawnpoint": where the player is snapped to stand, and
//    the ground anchor the fruit canopy is centered above (NOT the tree's
//    trunk — the canopy follows the spawnpoint).
//  - "lane_3"/"lane_4": the lane's short end-cap walls — the line between
//    them IS the true walkable width, so the canopy's left/right span and
//    center are measured directly from their real positions instead of a
//    guessed constant (a fixed guess kept landing fruit outside the actual
//    lane on one side).
// The player is turned to face cinematic_point on arrival (movePlayerTo's
// cameraTarget); the camera looks up at the canopy area above the spawnpoint,
// not at ground level, so both the avatar and the falling fruit stay framed.
const CANOPY_HEIGHT = 8.75 // above the spawnpoint — where fruit hangs/falls from
const CAMERA_LOOK_HEIGHT = 4.2 // above the spawnpoint — independent of CANOPY_HEIGHT, so raising the drop height doesn't tilt the shot up too
const LANE_END_MARGIN = 1.0 // metres inset from each end-cap wall, so fruit don't spawn right against them
const CANOPY_DEPTH = 0.6 // half-depth, narrow so it reads as one lane
// The active pet is parked here (sitting, watching) for the round: this far
// PAST the right-hand end-cap wall along +localRight, so it's clearly outside
// the catch lane and never in the player's way.
const PET_SIT_MARGIN = 1.5

// Same "hold" pose/asset pet.ts uses for carrying the pet to the bath — a
// two-handed cradling pose, better suited to holding the drawer than the
// egg-carry emote.
const HOLD_EMOTE = 'models/hold_pet_emote.glb'

// Crate held in both hands for the round, same AvatarAttach approach pet.ts
// uses for carrying the pet (a two-handed object cradled at the belly). Offset
// and scale are eyeballed — nudge against the actual rig in-world as needed.
const DRAWER_MODEL = 'assets/asset-packs/drawer_2/Drawer 2.glb'
const DRAWER_HOLD_OFFSET = Vector3.create(0.22, 0, 0.2)
const DRAWER_HOLD_SCALE = 0.9

type FruitPhase = 'idle' | 'falling' | 'caught' | 'resolved'
interface FruitRuntime {
  entity: Entity
  phase: FruitPhase
  nextDropAt: number
  resolvedAt: number
}

type Phase = 'idle' | 'arrival' | 'intro' | 'countdown' | 'catching' | 'results'
let phase: Phase = 'idle'
let phaseAt = 0
let clock = 0
let introEmotePlayed = false
let drawerRevealed = false

const fruits: FruitRuntime[] = []
const groundClutter: Entity[] = [] // decorative fallen fruit — see GROUND_CLUTTER_COUNT
let clutterIndex = 0
const catchBursts: Entity[] = [] // pooled glow sprites — see CATCH_BURST_* / spawnCatchBurst
let catchBurstIndex = 0
// entity -> module clock (seconds) it was spawned at; present only while animating
const catchBurstStartedAt = new Map<Entity, number>()
let catchBurstTexture: ReturnType<typeof Material.Texture.Common> | null = null
const scorches: Entity[] = [] // pooled ground splat decals — see SCORCH_* / spawnScorch
let scorchIndex = 0
const scorchStartedAt = new Map<Entity, number>()
let scorchTexture: ReturnType<typeof Material.Texture.Common> | null = null
let cinCam: Entity | null = null // the one cinematic camera, re-Tweened rather than swapped
let drawerAnchor: Entity | null = null
let drawerEntity: Entity | null = null
let sfxEntity: Entity | null = null

let groundY = 0
let canopyCenter = Vector3.Zero()
let canopyHalfWidth = 4.0 // overwritten from the lane_3/lane_4 gap each game
let localRight = Vector3.create(1, 0, 0)
let localForward = Vector3.create(0, 0, 1)

// Cached each game start, consumed when 'arrival' hands off to 'intro'.
let pendingCamPos = Vector3.Zero()
let pendingLookTarget = Vector3.Zero()

function playerPos(): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : Vector3.Zero()
}

function distFlat(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

function playHoldEmote(): void {
  triggerHoldEmote(HOLD_EMOTE)
}
// stopHoldEmote is imported from ./holdEmote (shared with pet.ts).

/** One-time fixup: push lane_1/lane_2 apart along the line between them, so
 *  the pen they form is wide enough to walk in without clipping both sides
 *  at once. Desktop only (see LANE_DEPTH_EXTRA). No-ops if already done or if
 *  the markers aren't found. */
function widenLaneDepthOnce(): void {
  if (laneDepthWidened) return
  const lane1 = engine.getEntityOrNullByName(EntityNames.lane_1)
  const lane2 = engine.getEntityOrNullByName(EntityNames.lane_2)
  if (!lane1 || !lane2 || !Transform.has(lane1) || !Transform.has(lane2)) return
  const p1 = Transform.get(lane1).position
  const p2 = Transform.get(lane2).position
  const dir = Vector3.normalize(Vector3.create(p2.x - p1.x, 0, p2.z - p1.z))
  const half = LANE_DEPTH_EXTRA / 2
  Transform.getMutable(lane1).position = Vector3.create(p1.x - dir.x * half, p1.y, p1.z - dir.z * half)
  Transform.getMutable(lane2).position = Vector3.create(p2.x + dir.x * half, p2.y, p2.z + dir.z * half)
  laneDepthWidened = true
}

/** Turn the lane's invisible walls solid (catching) or back off (everywhere
 *  else). Logs what actually happened to each marker — whether it was found
 *  in the scene and what mask got applied — so a live test tells us for sure
 *  whether the colliders are really being armed, instead of guessing. */
function setLaneColliders(on: boolean): void {
  if (on && !mobile()) widenLaneDepthOnce()
  for (const name of LANE_ENTITY_NAMES) {
    const e = engine.getEntityOrNullByName(name)
    if (!e || !GltfContainer.has(e)) {
      console.log(`[Client] fruit game: lane marker "${name}" not found or has no GltfContainer — collider NOT set`)
      continue
    }
    const mask = on ? ColliderLayer.CL_PHYSICS : ColliderLayer.CL_NONE
    GltfContainer.getMutable(e).visibleMeshesCollisionMask = mask
    console.log(`[Client] fruit game: lane marker "${name}" visibleMeshesCollisionMask -> ${mask} (${on ? 'ON' : 'off'})`)
  }
  const pp = playerPos()
  console.log(`[Client] fruit game: setLaneColliders(${on}) — player at (${pp.x.toFixed(2)}, ${pp.z.toFixed(2)}), canopyCenter (${canopyCenter.x.toFixed(2)}, ${canopyCenter.z.toFixed(2)}), canopyHalfWidth ${canopyHalfWidth.toFixed(2)}`)
}

function randomFruitModel(): string {
  return FRUIT_MODELS[Math.floor(Math.random() * FRUIT_MODELS.length)]
}

function randomCanopySpot(): Vector3 {
  const rightOff = (Math.random() * 2 - 1) * canopyHalfWidth
  const fwdOff = (Math.random() * 2 - 1) * CANOPY_DEPTH
  return Vector3.create(
    canopyCenter.x + localRight.x * rightOff + localForward.x * fwdOff,
    canopyCenter.y,
    canopyCenter.z + localRight.z * rightOff + localForward.z * fwdOff
  )
}

function armFruit(f: FruitRuntime): void {
  f.phase = 'idle'
  f.nextDropAt = clock + MIN_HANG_S + Math.random() * (MAX_HANG_S - MIN_HANG_S)
}

function startFall(f: FruitRuntime): void {
  const start = Transform.get(f.entity).position
  const end = Vector3.create(start.x, groundY + FRUIT_GROUND_OFFSET, start.z)
  Tween.createOrReplace(f.entity, {
    mode: Tween.Mode.Move({ start, end }),
    duration: FALL_DURATION_MS,
    easingFunction: EasingFunction.EF_EASEINQUAD
  })
  f.phase = 'falling'
}

/** Small scripted bounce-and-settle for a fruit that hit the ground uncaught:
 *  up + spin, then down + spin further, then it just sits there. */
function playLandBounce(entity: Entity, groundPos: Vector3): void {
  const apex = Vector3.create(groundPos.x, groundPos.y + LAND_BOUNCE_HEIGHT, groundPos.z)
  const rest0 = Quaternion.fromEulerDegrees(0, 0, 0)
  const rest1 = Quaternion.fromEulerDegrees(0, Math.random() * 360, (Math.random() * 2 - 1) * 20)
  const rest2 = Quaternion.fromEulerDegrees(0, Math.random() * 360, (Math.random() * 2 - 1) * 20)
  Tween.createOrReplace(entity, {
    mode: Tween.Mode.MoveRotateScale({
      position: { start: groundPos, end: apex },
      rotation: { start: rest0, end: rest1 }
    }),
    duration: LAND_BOUNCE_UP_MS,
    easingFunction: EasingFunction.EF_EASEOUTQUAD
  })
  TweenSequence.createOrReplace(entity, {
    sequence: [
      {
        mode: Tween.Mode.MoveRotateScale({
          position: { start: apex, end: groundPos },
          rotation: { start: rest1, end: rest2 }
        }),
        duration: LAND_BOUNCE_DOWN_MS,
        easingFunction: EasingFunction.EF_EASEINQUAD
      }
    ]
  })
}

/** Leave a fallen fruit lying on the ground as clutter until the round ends —
 *  a separate pool from the catchable fruit, so misses don't eat into drops. */
function dropGroundClutter(pos: Vector3, model: string): void {
  const entity = groundClutter[clutterIndex]
  clutterIndex = (clutterIndex + 1) % groundClutter.length
  GltfContainer.createOrReplace(entity, { src: model, ...NO_COLLISION })
  Transform.createOrReplace(entity, { position: pos, scale: Vector3.scale(Vector3.One(), FRUIT_SCALE) })
  VisibilityComponent.createOrReplace(entity, { visible: true })
  playLandBounce(entity, pos)
}

/** Build the shared glow-sprite material at `emissive`/alpha strength `k`
 *  (1 = full, 0 = gone). Re-applied per frame during the fade so the sprite
 *  dims out instead of hard-cutting. */
function applyCatchBurstMaterial(entity: Entity, k: number): void {
  if (!catchBurstTexture) return
  Material.setPbrMaterial(entity, {
    texture: catchBurstTexture,
    alphaTexture: catchBurstTexture,
    emissiveTexture: catchBurstTexture,
    emissiveColor: CATCH_BURST_TINT,
    emissiveIntensity: CATCH_BURST_EMISSIVE * k,
    albedoColor: Color4.create(CATCH_BURST_TINT.r, CATCH_BURST_TINT.g, CATCH_BURST_TINT.b, k),
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

/** Pop a glow sprite ON the box held in both hands (parented to `drawerEntity`
 *  at CATCH_BURST_LOCAL_OFFSET), NOT at the caught fruit: scale-tween small ->
 *  large over its lifetime, full opacity for the grow, then alpha fades over
 *  the tail (see catchBurstTick). Round-robins the pool. */
function spawnCatchBurst(): void {
  const e = catchBursts[catchBurstIndex]
  if (!e || !drawerEntity) return
  catchBurstIndex = (catchBurstIndex + 1) % catchBursts.length
  Tween.deleteFrom(e)
  const t = Transform.getMutable(e)
  t.parent = drawerEntity
  t.position = CATCH_BURST_LOCAL_OFFSET
  t.scale = Vector3.scale(Vector3.One(), CATCH_BURST_START_SCALE)
  applyCatchBurstMaterial(e, 1)
  VisibilityComponent.createOrReplace(e, { visible: true })
  Tween.createOrReplace(e, {
    mode: Tween.Mode.Scale({
      start: Vector3.scale(Vector3.One(), CATCH_BURST_START_SCALE),
      end: Vector3.scale(Vector3.One(), CATCH_BURST_END_SCALE)
    }),
    duration: CATCH_BURST_GROW_MS + CATCH_BURST_FADE_MS,
    easingFunction: EasingFunction.EF_EASEOUTQUAD
  })
  catchBurstStartedAt.set(e, clock)
}

/** Fade + retire any live catch bursts. Runs every frame from tick(), so a
 *  pop that lands right as the round ends still completes. */
function catchBurstTick(): void {
  if (catchBurstStartedAt.size === 0) return
  for (const [e, startedAt] of catchBurstStartedAt) {
    const ageMs = (clock - startedAt) * 1000
    if (ageMs <= CATCH_BURST_GROW_MS) continue // grow phase — full opacity, tween drives scale
    const fade = (ageMs - CATCH_BURST_GROW_MS) / CATCH_BURST_FADE_MS
    if (fade >= 1) {
      Tween.deleteFrom(e)
      VisibilityComponent.createOrReplace(e, { visible: false })
      catchBurstStartedAt.delete(e)
      continue
    }
    applyCatchBurstMaterial(e, 1 - fade)
  }
}

/** Hide every catch burst and drop their timers — called on close/reset. */
function clearCatchBursts(): void {
  for (const e of catchBursts) {
    Tween.deleteFrom(e)
    VisibilityComponent.createOrReplace(e, { visible: false })
  }
  catchBurstStartedAt.clear()
}

/** Ground-splat material at alpha strength `k` (1 = full, 0 = gone). No
 *  emissive — a scorch mark shouldn't glow. */
function applyScorchMaterial(entity: Entity, k: number): void {
  if (!scorchTexture) return
  Material.setPbrMaterial(entity, {
    texture: scorchTexture,
    alphaTexture: scorchTexture,
    albedoColor: Color4.create(SCORCH_TINT.r, SCORCH_TINT.g, SCORCH_TINT.b, k),
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

/** Lay a scorch decal flat on the ground at `at` (x/z only — it sits at
 *  groundY): pop-grow to full size, hold, then fade over a few seconds
 *  (see scorchTick). Round-robins the pool; random spin so repeats don't
 *  read as tiled. */
function spawnScorch(at: Vector3): void {
  const e = scorches[scorchIndex]
  if (!e) return
  scorchIndex = (scorchIndex + 1) % scorches.length
  Tween.deleteFrom(e)
  const t = Transform.getMutable(e)
  t.position = Vector3.create(at.x, groundY + SCORCH_Y_OFFSET, at.z)
  // Plane faces +Z by default; -90° about X tips it face-up, Z roll then spins
  // it flat around its (now vertical) normal.
  t.rotation = Quaternion.fromEulerDegrees(-90, 0, Math.random() * 360)
  t.scale = Vector3.scale(Vector3.One(), SCORCH_START_SCALE)
  applyScorchMaterial(e, 1)
  VisibilityComponent.createOrReplace(e, { visible: true })
  Tween.createOrReplace(e, {
    mode: Tween.Mode.Scale({
      start: Vector3.scale(Vector3.One(), SCORCH_START_SCALE),
      end: Vector3.scale(Vector3.One(), SCORCH_END_SCALE)
    }),
    duration: SCORCH_GROW_MS,
    easingFunction: EasingFunction.EF_EASEOUTQUAD
  })
  scorchStartedAt.set(e, clock)
}

/** Fade + retire any live scorch decals. Runs every frame from tick(). */
function scorchTick(): void {
  if (scorchStartedAt.size === 0) return
  const fadeStartMs = SCORCH_GROW_MS + SCORCH_HOLD_MS
  for (const [e, startedAt] of scorchStartedAt) {
    const ageMs = (clock - startedAt) * 1000
    if (ageMs <= fadeStartMs) continue
    const fade = (ageMs - fadeStartMs) / SCORCH_FADE_MS
    if (fade >= 1) {
      Tween.deleteFrom(e)
      VisibilityComponent.createOrReplace(e, { visible: false })
      scorchStartedAt.delete(e)
      continue
    }
    applyScorchMaterial(e, 1 - fade)
  }
}

/** Hide every scorch decal and drop their timers — called on close/reset. */
function clearScorches(): void {
  for (const e of scorches) {
    Tween.deleteFrom(e)
    VisibilityComponent.createOrReplace(e, { visible: false })
  }
  scorchStartedAt.clear()
}

function resolveFruit(f: FruitRuntime, caught: boolean): void {
  const pos = Transform.get(f.entity).position
  Tween.deleteFrom(f.entity)
  if (caught) {
    clientState.feedGame.caught += 1
    clientState.feedGame.catchFlashUntil = Date.now() + 350
    if (sfxEntity) AudioSource.playSound(sfxEntity, FRUIT_PICK_SOUND)
    spawnCatchBurst()
    // Don't blink it out in mid-air — reparent onto the drawer and slide it
    // from just above the circle spot down into the box, staying visible;
    // fruitTick unparents + hides it once this tween finishes ('caught').
    if (drawerEntity) {
      const startLocal = Vector3.add(CATCH_BURST_LOCAL_OFFSET, FRUIT_SUCK_START_LOCAL)
      const t = Transform.getMutable(f.entity)
      t.parent = drawerEntity
      t.position = startLocal
      Tween.createOrReplace(f.entity, {
        mode: Tween.Mode.Move({ start: startLocal, end: CATCH_BURST_LOCAL_OFFSET }),
        duration: CATCH_SUCK_MS,
        easingFunction: EasingFunction.EF_EASEINQUAD
      })
    } else {
      VisibilityComponent.createOrReplace(f.entity, { visible: false })
    }
    f.phase = 'caught'
    f.resolvedAt = clock
    return
  }
  VisibilityComponent.createOrReplace(f.entity, { visible: false })
  dropGroundClutter(pos, GltfContainer.get(f.entity).src)
  spawnScorch(pos)
  f.phase = 'resolved'
  f.resolvedAt = clock
}

function fruitTick(): void {
  const pp = playerPos()
  for (const f of fruits) {
    if (f.phase === 'idle') {
      if (clock >= f.nextDropAt) startFall(f)
      continue
    }
    if (f.phase === 'falling') {
      const pos = Transform.get(f.entity).position
      const inCatchBand = pos.y >= groundY + CATCH_MIN_Y && pos.y <= groundY + CATCH_MAX_Y
      if (inCatchBand && distFlat(pp, pos) <= CATCH_RADIUS) {
        resolveFruit(f, true)
      } else if (tweenSystem.tweenCompleted(f.entity)) {
        resolveFruit(f, false)
      }
      continue
    }
    if (f.phase === 'caught') {
      // The suck-into-the-box tween from resolveFruit — unparent from the
      // drawer, restore scale, hide, and start the respawn clock once it lands.
      if (tweenSystem.tweenCompleted(f.entity)) {
        Tween.deleteFrom(f.entity)
        const t = Transform.getMutable(f.entity)
        t.parent = undefined
        t.scale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
        VisibilityComponent.createOrReplace(f.entity, { visible: false })
        f.phase = 'resolved'
        f.resolvedAt = clock
      }
      continue
    }
    if (f.phase === 'resolved' && clock - f.resolvedAt >= RESPAWN_DELAY_S) {
      Transform.getMutable(f.entity).position = randomCanopySpot()
      GltfContainer.createOrReplace(f.entity, { src: randomFruitModel(), ...NO_COLLISION })
      VisibilityComponent.createOrReplace(f.entity, { visible: true })
      armFruit(f)
    }
  }
}

/** Arrival: just a timer gate — the zoom-in already started in startFruitGame
 *  and has had time to settle by now. Time-based, not distance-based: we
 *  can't script the avatar's own walk, so this doesn't wait on player
 *  movement. */
function arrivalTick(): void {
  if (clock - phaseAt < ARRIVAL_HOLD_S) return
  // Swap the full freeze for the same light lock catching uses (walk/run
  // free, no jump/glide) — the move buttons are already on screen, so let the
  // player try them out before they commit with Start.
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({ disableJump: true, disableDoubleJump: true, disableGliding: true })
  })
  setLaneColliders(true) // keep them penned in the lane while they test the buttons
  phase = 'intro'
  phaseAt = clock
  clientState.feedGame.phase = 'intro'
}

function introTick(): void {
  const elapsed = clock - phaseAt
  if (!introEmotePlayed && elapsed >= INTRO_EMOTE_AT_S) {
    playHoldEmote()
    introEmotePlayed = true
  }
  if (!drawerRevealed && elapsed >= INTRO_EMOTE_AT_S + DRAWER_REVEAL_DELAY_S) {
    // Delayed past the emote trigger so the crate pops in once the arms have
    // actually reached the holding pose, not mid-swing.
    console.log(`[Client] fruit game: revealing drawer — drawerEntity=${drawerEntity}, has Transform=${drawerEntity ? Transform.has(drawerEntity) : 'n/a'}, has AvatarAttach on anchor=${drawerAnchor ? AvatarAttach.has(drawerAnchor) : 'n/a'}`)
    if (drawerEntity) VisibilityComponent.getMutable(drawerEntity).visible = true
    drawerRevealed = true
  }
  // No auto-advance from here — 'intro' just sits parked (frozen, hands up,
  // crate in hand) until the player taps Start (see startCatchingCountdown).
}

/** Start button tapped: run the 3-2-1, then hand off to beginCatching(). */
export function startCatchingCountdown(): void {
  if (phase !== 'intro') return
  // The Start button is enabled the instant 'intro' begins, but the emote and
  // drawer reveal are timed (INTRO_EMOTE_AT_S / +DRAWER_REVEAL_DELAY_S) — a
  // fast tap can beat introTick() to one or both, permanently skipping them
  // for the round since introTick stops running once we leave 'intro'. Force
  // whichever hasn't fired yet, right now, so Start never skips the reveal.
  if (!introEmotePlayed) {
    playHoldEmote()
    introEmotePlayed = true
  }
  if (!drawerRevealed) {
    if (drawerEntity) VisibilityComponent.getMutable(drawerEntity).visible = true
    drawerRevealed = true
  }
  phase = 'countdown'
  phaseAt = clock
  clientState.feedGame.phase = 'countdown'
  clientState.feedGame.countdownAt = Date.now()
}

function countdownTick(): void {
  if (clock - phaseAt < COUNTDOWN_S) return
  beginCatching()
}

/** Zoom the cinematic camera back out to the wide game position and start
 *  dropping fruit — the jump/glide lock and lane pen are already in place
 *  from arrivalTick, since the player's been free to move (and try the
 *  buttons) since 'intro' began. */
function beginCatching(): void {
  // Zoom the SAME camera back out to the wide game position and re-aim it at
  // the canopy, from wherever the close shot currently sits.
  if (cinCam) {
    const cur = Transform.get(cinCam)
    const gameRot = Quaternion.fromLookAt(pendingCamPos, pendingLookTarget)
    Tween.createOrReplace(cinCam, {
      mode: Tween.Mode.MoveRotateScale({
        position: { start: cur.position, end: pendingCamPos },
        rotation: { start: cur.rotation, end: gameRot }
      }),
      duration: GAME_CAM_PAN_MS,
      easingFunction: EasingFunction.EF_EASEQUAD
    })
  }
  for (const f of fruits) armFruit(f)
  phase = 'catching'
  phaseAt = clock
  clientState.feedGame.phase = 'catching'
}

/** Round over: stop the catching gameplay and submit the reward, but stay on
 *  screen showing the results (count-up + feed bar) — closing fully happens
 *  separately, once the player taps Exit (see finalizeAndClose). */
function applyResults(): void {
  const caught = clientState.feedGame.caught
  stopHoldEmote()
  if (drawerEntity) VisibilityComponent.getMutable(drawerEntity).visible = false
  for (const f of fruits) {
    Tween.deleteFrom(f.entity)
    VisibilityComponent.createOrReplace(f.entity, { visible: false })
    f.phase = 'idle'
  }
  // Ground clutter stays lying around for the results beat — it's just cosmetic debris.
  phase = 'results'
  clientState.feedGame.phase = 'results'
  clientState.feedGame.resultsAt = Date.now()
  if (caught > 0) {
    applyFeedMinigameLocal(caught) // optimistic local effect
    actions.feedResult(caught) // tell the server (it corrects via snapshot)
  }
}

/** Release the camera/movement lock/touch controls and hand the screen back —
 *  called once the player is done looking at the results (Exit), or right
 *  away on an early cancel (no results screen in that case). */
function finalizeAndClose(): void {
  if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
  if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
  setLaneColliders(false)
  applyDefaultTouchControls()
  clearCatchBursts()
  clearScorches()
  if (drawerEntity) VisibilityComponent.getMutable(drawerEntity).visible = false
  for (const e of groundClutter) {
    Tween.deleteFrom(e)
    if (TweenSequence.has(e)) TweenSequence.deleteFrom(e)
    VisibilityComponent.createOrReplace(e, { visible: false })
  }
  clientState.feedGame.active = false
  phase = 'idle'
}

/** Bail out early (Back button, only shown before 'results') — submits
 *  whatever was caught so far and closes immediately, skipping the results
 *  reveal (you asked to leave, so no flourish). */
export function cancelFruitGame(): void {
  if (phase === 'idle' || phase === 'results') return
  const caught = clientState.feedGame.caught
  applyResults()
  finalizeAndClose()
  if (caught > 0) pushToast(`Caught ${caught} fruit${caught === 1 ? '' : 's'}!`)
}

/** Exit button on the results screen. */
export function exitFeedResults(): void {
  if (phase !== 'results') return
  finalizeAndClose()
}

// DEBUG: purely observational — logs (throttled) if the player is found
// further from the canopy than the lane should ever allow, so a live test on
// mobile tells us for certain whether they're actually escaping the pen and
// where/when, instead of guessing from a static code read. No correction, no
// teleport — just evidence.
let lastBoundsLogAt = -999
function logIfOutOfBounds(): void {
  if (clock - lastBoundsLogAt < 1) return
  const pp = playerPos()
  const dist = distFlat(pp, canopyCenter)
  const maxExpected = canopyHalfWidth + 3 // generous margin over the intended width
  if (dist <= maxExpected) return
  lastBoundsLogAt = clock
  console.log(`[Client] fruit game DEBUG: player at (${pp.x.toFixed(2)}, ${pp.z.toFixed(2)}) is ${dist.toFixed(2)}m from canopyCenter — expected within ~${maxExpected.toFixed(2)}m`)
}

function tick(dt: number): void {
  clock += dt
  catchBurstTick() // cosmetic, phase-independent so a pop finishes even past round end
  scorchTick()
  if (phase === 'arrival') {
    arrivalTick()
  } else if (phase === 'intro') {
    introTick()
    logIfOutOfBounds()
  } else if (phase === 'countdown') {
    countdownTick()
    logIfOutOfBounds()
  } else if (phase === 'catching') {
    fruitTick()
    logIfOutOfBounds()
    const st = clientState.feedGame
    st.timeLeft = Math.max(0, st.timeLeft - dt)
    if (st.timeLeft <= 0) applyResults()
  }
}

/** Spawn the (initially hidden) fruit pool once and start the module's system. */
export function setupFruitGame(): void {
  const fruitScale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
  for (let i = 0; i < NUM_FRUIT_SLOTS; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: fruitScale })
    GltfContainer.create(entity, { src: FRUIT_MODELS[i % FRUIT_MODELS.length], ...NO_COLLISION })
    VisibilityComponent.create(entity, { visible: false })
    fruits.push({ entity, phase: 'idle', nextDropAt: 0, resolvedAt: 0 })
  }

  for (let i = 0; i < GROUND_CLUTTER_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: fruitScale })
    GltfContainer.create(entity, { src: FRUIT_MODELS[i % FRUIT_MODELS.length], ...NO_COLLISION })
    VisibilityComponent.create(entity, { visible: false })
    groundClutter.push(entity)
  }

  catchBurstTexture = Material.Texture.Common({ src: CATCH_BURST_TEXTURE })
  for (let i = 0; i < CATCH_BURST_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    MeshRenderer.setPlane(entity)
    applyCatchBurstMaterial(entity, 1)
    Billboard.create(entity) // always face the camera
    VisibilityComponent.create(entity, { visible: false })
    catchBursts.push(entity)
  }

  scorchTexture = Material.Texture.Common({ src: SCORCH_TEXTURE })
  for (let i = 0; i < SCORCH_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    MeshRenderer.setPlane(entity)
    applyScorchMaterial(entity, 1)
    // no Billboard — spawnScorch lays it flat on the ground
    VisibilityComponent.create(entity, { visible: false })
    scorches.push(entity)
  }

  drawerAnchor = engine.addEntity()
  Transform.create(drawerAnchor, {})
  AvatarAttach.create(drawerAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_SPINE })
  drawerEntity = engine.addEntity()
  Transform.create(drawerEntity, { parent: drawerAnchor, position: DRAWER_HOLD_OFFSET, scale: Vector3.scale(Vector3.One(), DRAWER_HOLD_SCALE) })
  GltfContainer.create(drawerEntity, { src: DRAWER_MODEL, ...NO_COLLISION })
  VisibilityComponent.create(drawerEntity, { visible: false })

  sfxEntity = engine.addEntity()
  Transform.create(sfxEntity, {})
  AudioSource.create(sfxEntity, { audioClipUrl: FRUIT_PICK_SOUND, playing: false, global: true, volume: 0.4 })

  engine.addSystem(tick)
}

interface CinematicGeometry {
  camPos: Vector3
  viewDir: Vector3
  rightRef: Vector3
  gameLookTarget: Vector3
  arrivalLookTarget: Vector3
  wideRot: Quaternion
  closeCamPos: Vector3
  closeRot: Quaternion
}

/** All the camera math shared between startFruitGame's real setup and the
 *  debugCam* live-preview below — kept in one place so nudging a constant
 *  from the debug panel matches exactly what a real playthrough would do. */
function computeCinematicGeometry(rawCamPos: Vector3, spawnPos: Vector3, gY: number, onMobile: boolean): CinematicGeometry {
  const towardSpawn = Vector3.normalize(Vector3.create(spawnPos.x - rawCamPos.x, 0, spawnPos.z - rawCamPos.z))
  const closerDist = onMobile ? CAM_CLOSER_DIST : DESKTOP_CAM_CLOSER_DIST
  const raise = onMobile ? CAM_RAISE : DESKTOP_CAM_RAISE
  const camPos = Vector3.create(
    rawCamPos.x + towardSpawn.x * closerDist,
    rawCamPos.y + raise,
    rawCamPos.z + towardSpawn.z * closerDist
  )

  const viewDir = Vector3.normalize(Vector3.create(spawnPos.x - camPos.x, 0, spawnPos.z - camPos.z))
  const rightRef = Vector3.create(-viewDir.z, 0, viewDir.x)

  const lookHeight = CAMERA_LOOK_HEIGHT + (onMobile ? 0 : DESKTOP_LOOK_HEIGHT_BOOST)
  const lookLeftOffset = onMobile ? 0 : DESKTOP_LOOK_LEFT
  const gameLookTarget = Vector3.create(
    spawnPos.x + rightRef.x * lookLeftOffset,
    gY + lookHeight,
    spawnPos.z + rightRef.z * lookLeftOffset
  )

  // Desktop has no separate "look at the player" arrival shot at all — it's
  // the exact same framing as gameplay from the very first frame, so there's
  // nothing in between that could point the wrong way.
  const arrivalLookTarget = onMobile
    ? Vector3.create(
        spawnPos.x + rightRef.x * ARRIVAL_LOOK_LEFT,
        gY + ARRIVAL_LOOK_HEIGHT,
        spawnPos.z + rightRef.z * ARRIVAL_LOOK_LEFT
      )
    : gameLookTarget
  const wideRot = Quaternion.fromLookAt(camPos, arrivalLookTarget)

  // Close "personal" shot: same height as the wide position, just this much
  // nearer to the player, along the same camera-to-player line. Mobile only,
  // but computed unconditionally — harmless, and lets the debug panel preview
  // it regardless of the platform it's running on.
  const towardCam = Vector3.create(-viewDir.x, 0, -viewDir.z)
  const closeCamPos = Vector3.create(
    spawnPos.x + towardCam.x * CLOSE_CAM_DIST,
    camPos.y,
    spawnPos.z + towardCam.z * CLOSE_CAM_DIST
  )
  const closeRot = Quaternion.fromLookAt(closeCamPos, arrivalLookTarget)

  return { camPos, viewDir, rightRef, gameLookTarget, arrivalLookTarget, wideRot, closeCamPos, closeRot }
}

/** Hand-off once the walk-to-tree errand arrives: freeze + camera cut + "hands
 *  up" reveal, then the timed fruit-catching round. mascotaId is accepted for
 *  parity with the errand's hand-off signature; the effect always targets the
 *  current active pet. */
export function startFruitGame(mascotaId: string): void {
  if (phase !== 'idle') return
  if (clientState.petting.active || clientState.hatch.active || clientState.carryPet.active) return
  // Fixed camera spot placed in the Creator Hub composite, next to the tree.
  const cinePoint = engine.getEntityOrNullByName(EntityNames.cinematic_point)
  if (!cinePoint || !Transform.has(cinePoint)) {
    console.log('[Client] fruit game: cinematic_point not found in scene')
    return
  }
  // Where the player stands; the canopy's depth-center follows this too.
  const spawnPoint = engine.getEntityOrNullByName(EntityNames.cinematic_play_spawnpoint)
  if (!spawnPoint || !Transform.has(spawnPoint)) {
    console.log('[Client] fruit game: cinematic_play_spawnpoint not found in scene')
    return
  }
  // The lane's end-cap walls — the real, measured left/right bounds.
  const lane3 = engine.getEntityOrNullByName(EntityNames.lane_3)
  const lane4 = engine.getEntityOrNullByName(EntityNames.lane_4)
  if (!lane3 || !lane4 || !Transform.has(lane3) || !Transform.has(lane4)) {
    console.log('[Client] fruit game: lane end-cap markers not found in scene')
    return
  }
  console.log('[Client] fruit game started for', mascotaId)

  const onMobile = mobile() // all the camera repositioning below (closer/lower/zoom/look-offset) is mobile-only — desktop keeps the original framing

  const rawCamPos = Transform.get(cinePoint).position
  const spawnPos = Transform.get(spawnPoint).position
  const p3 = Transform.get(lane3).position
  const p4 = Transform.get(lane4).position
  groundY = spawnPos.y

  const geo = computeCinematicGeometry(rawCamPos, spawnPos, groundY, onMobile)
  const { camPos, viewDir, rightRef, arrivalLookTarget, wideRot } = geo
  localForward = viewDir
  let laneSpan = Vector3.create(p4.x - p3.x, 0, p4.z - p3.z)
  if (Vector3.dot(laneSpan, rightRef) < 0) laneSpan = Vector3.create(-laneSpan.x, 0, -laneSpan.z)
  const laneWidth = Vector3.length(laneSpan)
  localRight = Vector3.normalize(laneSpan)
  canopyHalfWidth = Math.max(0.5, laneWidth / 2 - LANE_END_MARGIN)

  canopyCenter = Vector3.create(
    (p3.x + p4.x) / 2,
    groundY + CANOPY_HEIGHT,
    (p3.z + p4.z) / 2
  )

  // Where the active pet sits and watches for the round — just past the
  // right-hand end-cap wall, on the ground, facing the play area (pet.ts reads
  // these). Right = +localRight; distance = half the lane + a margin.
  const laneMid = Vector3.create(canopyCenter.x, groundY, canopyCenter.z)
  const petSitPos = Vector3.create(
    laneMid.x + localRight.x * (laneWidth / 2 + PET_SIT_MARGIN),
    groundY,
    laneMid.z + localRight.z * (laneWidth / 2 + PET_SIT_MARGIN)
  )

  // Cached for arrivalTick's cut to the game camera.
  pendingCamPos = camPos
  pendingLookTarget = geo.gameLookTarget

  // Snap the player into place and face them at cinematic_point right away —
  // we can't script their own walk-in, so there's no point waiting for it.
  void movePlayerTo({ newRelativePosition: spawnPos, cameraTarget: camPos })

  // Movement-only lock, NOT disableAll: disableAll also blocks scene-triggered
  // emotes, which would silently no-op the hold_emote reveal in introTick.
  InputModifier.createOrReplace(engine.PlayerEntity, {
    mode: InputModifier.Mode.Standard({
      disableWalk: true,
      disableJog: true,
      disableRun: true,
      disableJump: true,
      disableDoubleJump: true,
      disableGliding: true
    })
  })

  // Swap the native joystick/crosshair/gamepad for the custom left/right
  // buttons in FeedGameOverlay from the very start — no-op on platforms
  // without touch controls. Shown from the first "Move left/right" hint, not
  // just once catching begins, so mobile players see them right away.
  applyFruitGameTouchControls()

  // Arrival camera: cut straight to the wide cinematic_point framing (looking
  // at the now-arrived avatar) — computed only from cinematic_point/
  // spawnpoint, never a snapshot of the player's native follow-cam (that
  // camera's own rig differs between desktop and mobile, which made an
  // earlier version of this cut start from a different-looking angle per
  // platform). On mobile, immediately Tweens IN to a close shot for the
  // reveal; the pull back out to this same wide position happens later, in
  // introTick, once the "move left/right" hint goes away. Desktop skips the
  // zoom entirely — it keeps the original single cut, looking straight at
  // the player (no height/left offset).
  if (!cinCam) cinCam = engine.addEntity()
  Transform.createOrReplace(cinCam, { position: camPos, rotation: wideRot })
  VirtualCamera.createOrReplace(cinCam, {
    defaultTransition: { transitionMode: VirtualCamera.Transition.Time(ARRIVAL_CAM_TRANSITION_S) }
  })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: cinCam })

  if (onMobile) {
    Tween.createOrReplace(cinCam, {
      mode: Tween.Mode.MoveRotateScale({
        position: { start: camPos, end: geo.closeCamPos },
        rotation: { start: wideRot, end: geo.closeRot }
      }),
      duration: ZOOM_IN_MS,
      easingFunction: EasingFunction.EF_EASEOUTQUAD
    })
  }

  for (const f of fruits) {
    Tween.deleteFrom(f.entity)
    GltfContainer.createOrReplace(f.entity, { src: randomFruitModel(), ...NO_COLLISION })
    const t = Transform.getMutable(f.entity)
    t.parent = undefined // in case a round ended while this fruit was mid-'caught' (still parented to the drawer)
    t.scale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
    t.position = randomCanopySpot()
    VisibilityComponent.createOrReplace(f.entity, { visible: true })
    f.phase = 'idle'
  }

  clientState.feedGame = { active: true, phase: 'arrival', caught: 0, timeLeft: GAME_DURATION_S, catchFlashUntil: 0, countdownAt: 0, resultsAt: 0, petSitPos, petSitLook: laneMid }
  introEmotePlayed = false
  drawerRevealed = false
  phase = 'arrival'
  phaseAt = clock
  console.log(`[Client] fruit game: startFruitGame() full reset done — introEmotePlayed=${introEmotePlayed}, drawerRevealed=${drawerRevealed}, drawerEntity=${drawerEntity}`)
}

// ---------------------------------------------------------------------------
// DEBUG camera calibration panel. While the fruit game is active, nudges the
// module-level camera constants above and re-applies them straight to cinCam's
// Transform so the effect is visible immediately — no restart needed. Once
// the numbers feel right, call debugCamPrint() (logs to console) and hardcode
// them back into the `let`s above.
// ---------------------------------------------------------------------------
export type DebugCamKey = 'closer' | 'raise' | 'lookHeight' | 'lookLeft' | 'closeDist'
let debugPreviewClose = false

function debugFindMarkers(): { cinePoint: Entity; spawnPoint: Entity } | null {
  const cinePoint = engine.getEntityOrNullByName(EntityNames.cinematic_point)
  const spawnPoint = engine.getEntityOrNullByName(EntityNames.cinematic_play_spawnpoint)
  if (!cinePoint || !spawnPoint || !Transform.has(cinePoint) || !Transform.has(spawnPoint)) return null
  return { cinePoint, spawnPoint }
}

function debugApplyPreview(): void {
  if (!cinCam || !Transform.has(cinCam)) return
  const markers = debugFindMarkers()
  if (!markers) return
  const rawCamPos = Transform.get(markers.cinePoint).position
  const spawnPos = Transform.get(markers.spawnPoint).position
  const onMobileNow = mobile()
  const geo = computeCinematicGeometry(rawCamPos, spawnPos, spawnPos.y, onMobileNow)
  Tween.deleteFrom(cinCam) // a stale Tween would otherwise fight the snap below
  if (onMobileNow && debugPreviewClose) {
    Transform.createOrReplace(cinCam, { position: geo.closeCamPos, rotation: geo.closeRot })
  } else {
    Transform.createOrReplace(cinCam, { position: geo.camPos, rotation: geo.wideRot })
  }
}

/** 'closeDist' (the zoom-in shot) is a mobile-only concept — desktop has no
 *  zoom, so the debug panel hides it there. Every other key applies to both
 *  platforms, just backed by a different pair of constants (see debugCamValue). */
export function debugCamAvailableKeys(): DebugCamKey[] {
  return mobile() ? ['closer', 'raise', 'lookHeight', 'lookLeft', 'closeDist'] : ['closer', 'raise', 'lookHeight', 'lookLeft']
}

export function debugCamLabel(key: DebugCamKey): string {
  switch (key) {
    case 'closer': return 'Closer'
    case 'raise': return 'Raise'
    case 'lookHeight': return 'Look height'
    case 'lookLeft': return 'Look left'
    case 'closeDist': return 'Close dist'
  }
}

export function debugCamValue(key: DebugCamKey): number {
  const m = mobile()
  switch (key) {
    case 'closer': return m ? CAM_CLOSER_DIST : DESKTOP_CAM_CLOSER_DIST
    case 'raise': return m ? CAM_RAISE : DESKTOP_CAM_RAISE
    case 'lookHeight': return m ? ARRIVAL_LOOK_HEIGHT : DESKTOP_LOOK_HEIGHT_BOOST
    case 'lookLeft': return m ? ARRIVAL_LOOK_LEFT : DESKTOP_LOOK_LEFT
    case 'closeDist': return CLOSE_CAM_DIST
  }
}

export function debugCamAdjust(key: DebugCamKey, delta: number): void {
  const m = mobile()
  switch (key) {
    case 'closer': if (m) CAM_CLOSER_DIST += delta; else DESKTOP_CAM_CLOSER_DIST += delta; break
    case 'raise': if (m) CAM_RAISE += delta; else DESKTOP_CAM_RAISE += delta; break
    case 'lookHeight': if (m) ARRIVAL_LOOK_HEIGHT += delta; else DESKTOP_LOOK_HEIGHT_BOOST += delta; break
    case 'lookLeft': if (m) ARRIVAL_LOOK_LEFT += delta; else DESKTOP_LOOK_LEFT += delta; break
    case 'closeDist': CLOSE_CAM_DIST += delta; break
  }
  debugApplyPreview()
}

export function debugCamToggleClosePreview(): void {
  debugPreviewClose = !debugPreviewClose
  debugApplyPreview()
}

export function debugCamIsClosePreview(): boolean {
  return debugPreviewClose
}

export function debugCamPrint(): void {
  const m = mobile()
  const lines = m
    ? [
        `CAM_CLOSER_DIST = ${CAM_CLOSER_DIST.toFixed(2)}`,
        `CAM_RAISE = ${CAM_RAISE.toFixed(2)}`,
        `ARRIVAL_LOOK_HEIGHT = ${ARRIVAL_LOOK_HEIGHT.toFixed(2)}`,
        `ARRIVAL_LOOK_LEFT = ${ARRIVAL_LOOK_LEFT.toFixed(2)}`,
        `CLOSE_CAM_DIST = ${CLOSE_CAM_DIST.toFixed(2)}`
      ]
    : [
        `DESKTOP_CAM_CLOSER_DIST = ${DESKTOP_CAM_CLOSER_DIST.toFixed(2)}`,
        `DESKTOP_CAM_RAISE = ${DESKTOP_CAM_RAISE.toFixed(2)}`,
        `DESKTOP_LOOK_HEIGHT_BOOST = ${DESKTOP_LOOK_HEIGHT_BOOST.toFixed(2)}`,
        `DESKTOP_LOOK_LEFT = ${DESKTOP_LOOK_LEFT.toFixed(2)}`
      ]
  console.log(`[Client] fruit game camera calibration (${m ? 'mobile' : 'desktop'}):\n` + lines.join('\n'))
  pushToast('Cam values printed to console')
}

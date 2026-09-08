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
  AvatarModifierArea,
  AvatarModifierType,
  AudioSource,
  MeshRenderer,
  Material,
  MaterialTransparencyMode,
  Billboard
} from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import * as Cfg from '../shared/config'
import { actions, clientState, pushToast } from './state'
import { applyDefaultTouchControls, applyFruitGameTouchControls } from './touchControls'
import { mobile } from './ui/theme'
import { applyFeedMinigameLocal } from './sim'
import { triggerHoldEmote, stopHoldEmote } from './holdEmote'
import { getLocalPet, playEatCinematic, setEatCinematicPaused, suppressPetTags } from './pet'

const FRUIT_MODELS = [
  'assets/Models/Fruit01.glb',
  'assets/Models/Fruit02.glb',
  'assets/Models/Fruit03.glb',
  'assets/Models/Fruit04.glb',
  'assets/Models/Fruit05.glb'
]
const NUM_FRUIT_SLOTS = 5
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
const CATCH_MIN_Y = 0.7 // above ground; fallen fruit read as misses, not catches
const CATCH_MAX_Y = 2.4
const CATCH_SUCK_MS = 180
const FRUIT_SUCK_START_LOCAL = Vector3.create(0, 0.6, 0.15)
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
const CATCH_BURST_TEXTURE = 'assets/images/circle_01.png'
const CATCH_BURST_COUNT = NUM_FRUIT_SLOTS
const CATCH_BURST_LOCAL_OFFSET = Vector3.create(0, 0.6, 0.1)
const CATCH_BURST_START_SCALE = 0.2
const CATCH_BURST_END_SCALE = 1.6
const CATCH_BURST_GROW_MS = 150
const CATCH_BURST_FADE_MS = 140
const CATCH_BURST_TINT = Color4.create(0.55, 1, 0.7, 1)
const CATCH_BURST_EMISSIVE = 2.4
const SCORCH_TEXTURE = 'assets/images/scorch_03.png'
const SCORCH_COUNT = GROUND_CLUTTER_COUNT
const SCORCH_START_SCALE = 0.6
const SCORCH_END_SCALE = 1.15
const SCORCH_GROW_MS = 300
const SCORCH_HOLD_MS = 2500
const SCORCH_FADE_MS = 3000
const SCORCH_Y_OFFSET = 0.04
const SCORCH_TINT = Color4.create(0.32, 0.2, 0.11, 1)

// Adjustment applied to the composite-placed cinematic_point marker — closer
// to, and lower than, the raw spot. This is also the "pulled back" game-camera
// position the cinematic zooms IN from and, later, back OUT to. Mobile only.
// These values are intentionally fixed so the minigame framing is consistent.
const CAM_CLOSER_DIST = 3.5
const CAM_RAISE = -2.0
// Same idea, much lighter touch — desktop has no zoom/close shot, this is
// just a small correction on the single camera position it uses throughout.
const DESKTOP_CAM_CLOSER_DIST = 3.3
const DESKTOP_CAM_RAISE = -1.0
// Added on top of CAMERA_LOOK_HEIGHT for desktop only, so its one camera
// looks a bit higher (both during the arrival beat and gameplay, since
// desktop uses the same framing for both).
const DESKTOP_LOOK_HEIGHT_BOOST = -0.5
// Horizontal look offset for desktop's single continuous shot (metres, along
// +rightRef) — desktop has no separate arrival target, so this is the only
// way to turn/pan that one camera left or right instead of it staying pinned
// dead-center on the spawnpoint.
const DESKTOP_LOOK_LEFT = 0.6
// Where the arrival/intro shot looks (both the wide starting frame and the
// close zoomed-in hold use this same target) — higher above ground, and
// shifted toward the player's own left (confirmed direction: +rightRef) so
// the shot doesn't read as dead-center/tilted.
const ARRIVAL_LOOK_HEIGHT = 3.0
const ARRIVAL_LOOK_LEFT = 0.7 // metres, along +rightRef
// The close "personal" shot for the reveal: this many metres from the player,
// same height as the wide game-camera position.
const CLOSE_CAM_DIST = 3.0
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

type Phase = 'idle' | 'arrival' | 'intro' | 'countdown' | 'catching' | 'feeding' | 'results'
let phase: Phase = 'idle'
let phaseAt = 0
let clock = 0
let introEmotePlayed = false
let drawerRevealed = false

const fruits: FruitRuntime[] = []
const groundClutter: Entity[] = [] // decorative fallen fruit — see GROUND_CLUTTER_COUNT
let clutterIndex = 0
const catchBursts: Entity[] = []
let catchBurstIndex = 0
const catchBurstStartedAt = new Map<Entity, number>()
let catchBurstTexture: ReturnType<typeof Material.Texture.Common> | null = null
const scorches: Entity[] = []
let scorchIndex = 0
const scorchStartedAt = new Map<Entity, number>()
let scorchTexture: ReturnType<typeof Material.Texture.Common> | null = null
let cinCam: Entity | null = null // the one cinematic camera, re-Tweened rather than swapped
let drawerAnchor: Entity | null = null
let drawerEntity: Entity | null = null
let sfxEntity: Entity | null = null
let heldFruit: Entity | null = null
let heldFruitElapsedMs = 0

// The preview is deliberately dressed like the final feeding shot: a world
// drawer beside the pet, fruit piled into it, and a few pieces already fallen.
// These are preview-only entities, separate from the minigame's interactive
// fruit pool and the avatar-attached drawer.
let foodDrawer: Entity | null = null
let foodDrawerAnchor: Entity | null = null
let foodPile: Entity | null = null
const foodPileFruits: Entity[] = []
const foodGroundFruits: Entity[] = []
let foodSetVisible = false
let feedingAvatarHideArea: Entity | null = null

type FruitHandCalibration = {
  x: number
  y: number
  z: number
  mouthX: number
  mouthY: number
  mouthZ: number
  scale: number
}

// These offsets are local to the pet model. Each species keeps a fixed preset.
const DEFAULT_FRUIT_HAND: FruitHandCalibration = {
  x: 0.28, y: 0.72, z: 0.3,
  mouthX: 0.04, mouthY: 0.94, mouthZ: 0.08,
  scale: 0.16
}
// Sprout_Eat is 1.666… seconds long. Keep the visible fruit on that exact
// cadence so its hand → mouth trip restarts with the baked animation.
const EAT_HAND_CYCLE_MS = 1667
const FRUIT_HAND_PRESETS: Partial<Record<string, FruitHandCalibration>> = {
  'sprout-original': {
    x: -0.02, y: 0.4, z: 0.18,
    mouthX: 0.02, mouthY: 0.62, mouthZ: 0.04,
    scale: 0.45
  }
}
const fruitHandBySpecies = new Map<string, FruitHandCalibration>()

// Drawer 2 is authored from x/z = 0 at one inner corner (not centered at its
// pivot). These coordinates are therefore deliberately all *inside* its
// 0.62 × 0.47m bounds, not around (0, 0, 0).
type FruitPileCalibration = { x: number; y: number; z: number; scale: number }
export type DebugFruitPileKey = keyof FruitPileCalibration
type FruitDrawerCalibration = { x: number; y: number; z: number; scale: number }

// Calibrated in the in-scene pile preview. Keep this as the default so both
// the real feeding shot and the debug preview start with the pile in place.
const DEFAULT_FRUIT_PILE: FruitPileCalibration = { x: -0.64, y: -0.02, z: -0.18, scale: 1.40 }
let fruitPileCalibration: FruitPileCalibration = { ...DEFAULT_FRUIT_PILE }
const DEFAULT_FRUIT_DRAWER: FruitDrawerCalibration = { x: -0.02, y: 0, z: -0.16, scale: 1 }
let fruitDrawerCalibration: FruitDrawerCalibration = { ...DEFAULT_FRUIT_DRAWER }
const FRUIT_PILE_CHILDREN = [
  // Broad lower layer plus a smaller upper layer: dense enough to read as a
  // full crate without one oversized fruit hiding all the others.
  { position: Vector3.create(0.06, 0.10, 0.08), rotation: Vector3.create(10, 12, -12), scale: 0.28 },
  { position: Vector3.create(0.18, 0.10, 0.08), rotation: Vector3.create(-8, 57, 13), scale: 0.28 },
  { position: Vector3.create(0.30, 0.10, 0.08), rotation: Vector3.create(9, 116, -10), scale: 0.28 },
  { position: Vector3.create(0.42, 0.10, 0.08), rotation: Vector3.create(-11, 171, 14), scale: 0.27 },
  { position: Vector3.create(0.11, 0.17, 0.19), rotation: Vector3.create(-10, 218, 12), scale: 0.29 },
  { position: Vector3.create(0.24, 0.17, 0.19), rotation: Vector3.create(13, 272, -13), scale: 0.30 },
  { position: Vector3.create(0.37, 0.17, 0.19), rotation: Vector3.create(-8, 326, 10), scale: 0.29 },
  { position: Vector3.create(0.06, 0.23, 0.29), rotation: Vector3.create(11, 43, -10), scale: 0.26 },
  { position: Vector3.create(0.17, 0.24, 0.29), rotation: Vector3.create(-10, 101, 14), scale: 0.28 },
  { position: Vector3.create(0.28, 0.24, 0.28), rotation: Vector3.create(12, 159, -13), scale: 0.29 },
  { position: Vector3.create(0.39, 0.23, 0.28), rotation: Vector3.create(-11, 224, 12), scale: 0.26 },
  { position: Vector3.create(0.23, 0.29, 0.24), rotation: Vector3.create(8, 291, -9), scale: 0.27 },
  { position: Vector3.create(0.10, 0.12, 0.36), rotation: Vector3.create(-9, 337, 11), scale: 0.26 },
  { position: Vector3.create(0.22, 0.12, 0.37), rotation: Vector3.create(12, 73, -12), scale: 0.27 },
  { position: Vector3.create(0.34, 0.12, 0.37), rotation: Vector3.create(-10, 139, 10), scale: 0.26 },
  { position: Vector3.create(0.15, 0.19, 0.38), rotation: Vector3.create(11, 197, -12), scale: 0.27 },
  { position: Vector3.create(0.28, 0.19, 0.38), rotation: Vector3.create(-12, 253, 13), scale: 0.28 },
  { position: Vector3.create(0.22, 0.26, 0.37), rotation: Vector3.create(8, 309, -10), scale: 0.25 }
]
const GROUND_FRUIT_OFFSETS = [
  Vector3.create(-0.56, 0.02, 0.46),
  Vector3.create(0.58, 0.02, 0.33),
  Vector3.create(0.42, 0.02, -0.42),
  Vector3.create(-0.38, 0.02, -0.5)
]

const EAT_PICKUP_START = 0.12 // fraction of Sprout_Eat: fruit leaves drawer
const EAT_MOUTH_REACHED = 0.46 // disappear before the pet's hand crosses its face
const EAT_BITE_PATH_FRACTION = 0.85 // a clearly readable one-way hand → mouth movement
const EAT_BITE_COUNT = 3
const FEED_STAGE_SIDE_OFFSET = 2.3
const FEED_CAMERA_DISTANCE = 2.4
const FEED_CAMERA_TRANSITION_MS = 750

let groundY = 0
let canopyCenter = Vector3.Zero()
let canopyHalfWidth = 4.0 // overwritten from the lane_3/lane_4 gap each game
let localRight = Vector3.create(1, 0, 0)
let localForward = Vector3.create(0, 0, 1)
let cinematicSpawnPos = Vector3.Zero()

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

function feedingDrawerPosition(petPos: Vector3): Vector3 {
  // The pet faces +localRight during this shot, so the drawer is in front of
  // it and the camera (along localForward) sees the action in profile.
  return Vector3.create(
    petPos.x + localRight.x * 1.26,
    petPos.y,
    petPos.z + localRight.z * 0.63
  )
}

function feedingShot(anchor: Vector3): { petPos: Vector3; drawerPos: Vector3; camPos: Vector3; focus: Vector3 } {
  // Move the staged pet sideways off the player instead of placing it between
  // the active camera and avatar. This makes the shot about pet + food only.
  const petPos = Vector3.create(
    anchor.x + localRight.x * FEED_STAGE_SIDE_OFFSET,
    anchor.y,
    anchor.z + localRight.z * FEED_STAGE_SIDE_OFFSET
  )
  const drawerPos = feedingDrawerPosition(petPos)
  const camPos = Vector3.create(
    petPos.x - localForward.x * FEED_CAMERA_DISTANCE + localRight.x * 0.12,
    petPos.y + 1.12,
    petPos.z - localForward.z * FEED_CAMERA_DISTANCE + localRight.z * 0.12
  )
  const focus = Vector3.create(
    (petPos.x + drawerPos.x) / 2,
    petPos.y + 0.5,
    (petPos.z + drawerPos.z) / 2
  )
  return { petPos, drawerPos, camPos, focus }
}

function setFeedingAvatarHidden(hidden: boolean): void {
  if (!hidden) {
    if (feedingAvatarHideArea && AvatarModifierArea.has(feedingAvatarHideArea)) {
      AvatarModifierArea.deleteFrom(feedingAvatarHideArea)
    }
    return
  }
  const player = Transform.getOrNull(engine.PlayerEntity)
  if (!player) return
  if (!feedingAvatarHideArea) {
    feedingAvatarHideArea = engine.addEntity()
    Transform.create(feedingAvatarHideArea, { position: player.position })
  } else {
    Transform.getMutable(feedingAvatarHideArea).position = player.position
  }
  AvatarModifierArea.createOrReplace(feedingAvatarHideArea, {
    area: Vector3.create(2.5, 4, 2.5),
    modifiers: [AvatarModifierType.AMT_HIDE_AVATARS, AvatarModifierType.AMT_HIDE_NAMETAGS],
    excludeIds: []
  })
}

function fruitHandCalibration(): FruitHandCalibration | null {
  const species = clientState.activePet?.species
  if (!species) return null
  let calibration = fruitHandBySpecies.get(species)
  if (!calibration) {
    calibration = { ...(FRUIT_HAND_PRESETS[species] ?? DEFAULT_FRUIT_HAND) }
    fruitHandBySpecies.set(species, calibration)
  }
  return calibration
}

function setDrawerFruitForCurrentBite(heldFruitVisible: boolean): void {
  if (!foodSetVisible || foodPileFruits.length === 0) return
  // While positioning the pile, always show the complete pile. In the real
  // cinematic, the first three disappear one-by-one as the bites happen.
  if (clientState.debugFruitPilePanelOpen) {
    for (const fruit of foodPileFruits) VisibilityComponent.createOrReplace(fruit, { visible: true })
    return
  }
  const completedLoops = Math.floor(heldFruitElapsedMs / EAT_HAND_CYCLE_MS) % EAT_BITE_COUNT
  const removed = Math.min(foodPileFruits.length, completedLoops + (heldFruitVisible ? 1 : 0))
  for (let i = 0; i < foodPileFruits.length; i++) {
    VisibilityComponent.createOrReplace(foodPileFruits[i], { visible: i >= removed })
  }
}

/** Attach the visible fruit to the pet's local space for the eating beat. The
 * SDK cannot parent scene entities to an animated GLB hand bone. Instead, one
 * fruit leaves the drawer, makes a single hand → mouth trip, then disappears
 * as eaten. It never travels back down on the same bite. */
function showHeldFruit(): void {
  const pet = getLocalPet()
  const calibration = fruitHandCalibration()
  if (!pet || !calibration) {
    hideHeldFruit()
    return
  }
  if (!heldFruit) {
    heldFruit = engine.addEntity()
    Transform.create(heldFruit, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(heldFruit, { src: FRUIT_MODELS[0], ...NO_COLLISION })
    VisibilityComponent.create(heldFruit, { visible: false })
  }
  const cycle = (heldFruitElapsedMs % EAT_HAND_CYCLE_MS) / EAT_HAND_CYCLE_MS
  const eatingThisFruit = cycle >= EAT_PICKUP_START && cycle <= EAT_MOUTH_REACHED
  setDrawerFruitForCurrentBite(eatingThisFruit)
  if (!eatingThisFruit) {
    hideHeldFruit()
    return
  }
  // A single forward trip: at pickup the fruit is in the hand, reaches the
  // mouth once, and is then gone. The next loop takes a different fruit.
  const trip = Math.max(0, Math.min(1, (cycle - EAT_PICKUP_START) / (EAT_MOUTH_REACHED - EAT_PICKUP_START)))
  Transform.createOrReplace(heldFruit, {
    parent: pet,
    position: Vector3.create(
      calibration.x + (calibration.mouthX - calibration.x) * trip * EAT_BITE_PATH_FRACTION,
      calibration.y + (calibration.mouthY - calibration.y) * trip * EAT_BITE_PATH_FRACTION,
      calibration.z + (calibration.mouthZ - calibration.z) * trip * EAT_BITE_PATH_FRACTION
    ),
    rotation: Quaternion.fromEulerDegrees(0, trip * 18, trip * -12),
    scale: Vector3.create(calibration.scale, calibration.scale, calibration.scale)
  })
  VisibilityComponent.createOrReplace(heldFruit, { visible: true })
}

function startHeldFruitMotion(): void {
  heldFruitElapsedMs = 0
  showHeldFruit()
}

/** The pile preview is a still frame, so keep one fruit visibly resting in the
 * pet's hand instead of advancing its hand → mouth path. */
function holdFruitAtHand(): void {
  heldFruitElapsedMs = EAT_HAND_CYCLE_MS * EAT_PICKUP_START
  showHeldFruit()
}

function advanceHeldFruitMotion(dt: number): void {
  heldFruitElapsedMs += dt * 1000
}

function hideHeldFruit(): void {
  if (heldFruit) VisibilityComponent.createOrReplace(heldFruit, { visible: false })
}

function ensureFoodSet(): void {
  if (!foodDrawerAnchor) {
    foodDrawerAnchor = engine.addEntity()
    Transform.create(foodDrawerAnchor, { position: Vector3.Zero(), rotation: Quaternion.Identity(), scale: Vector3.One() })
  }
  if (!foodDrawer) {
    foodDrawer = engine.addEntity()
    Transform.create(foodDrawer, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(foodDrawer, { src: DRAWER_MODEL, ...NO_COLLISION })
    VisibilityComponent.create(foodDrawer, { visible: false })
  }
  if (!foodPile) {
    foodPile = engine.addEntity()
    Transform.create(foodPile, { position: Vector3.Zero(), scale: Vector3.Zero() })
  }
  while (foodPileFruits.length < FRUIT_PILE_CHILDREN.length) {
    const i = foodPileFruits.length
    const fruit = engine.addEntity()
    Transform.create(fruit, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(fruit, { src: FRUIT_MODELS[i % FRUIT_MODELS.length], ...NO_COLLISION })
    VisibilityComponent.create(fruit, { visible: false })
    foodPileFruits.push(fruit)
  }
  while (foodGroundFruits.length < GROUND_FRUIT_OFFSETS.length) {
    const i = foodGroundFruits.length
    const fruit = engine.addEntity()
    Transform.create(fruit, { position: Vector3.Zero(), scale: Vector3.Zero() })
    GltfContainer.create(fruit, { src: FRUIT_MODELS[(i + 2) % FRUIT_MODELS.length], ...NO_COLLISION })
    VisibilityComponent.create(fruit, { visible: false })
    foodGroundFruits.push(fruit)
  }
}

/** Move/scale the whole authored crate beneath the shot anchor. The fruit pile
 * stays parented to it, so it follows every crate calibration adjustment. */
function applyFruitDrawerLayout(): void {
  if (!foodDrawer || !foodDrawerAnchor) return
  Transform.createOrReplace(foodDrawer, {
    parent: foodDrawerAnchor,
    position: Vector3.create(fruitDrawerCalibration.x, fruitDrawerCalibration.y, fruitDrawerCalibration.z),
    rotation: Quaternion.Identity(),
    scale: Vector3.scale(Vector3.One(), 1.25 * fruitDrawerCalibration.scale)
  })
  applyFruitPileLayout()
}

function applyFruitPileLayout(): void {
  if (!foodDrawer || !foodPile) return
  Transform.createOrReplace(foodPile, {
    parent: foodDrawer,
    position: Vector3.create(fruitPileCalibration.x, fruitPileCalibration.y, fruitPileCalibration.z),
    scale: Vector3.scale(Vector3.One(), fruitPileCalibration.scale)
  })
  for (let i = 0; i < foodPileFruits.length; i++) {
    const child = FRUIT_PILE_CHILDREN[i]
    const fruit = foodPileFruits[i]
    Transform.createOrReplace(fruit, {
      parent: foodPile,
      position: child.position,
      rotation: Quaternion.fromEulerDegrees(child.rotation.x, child.rotation.y, child.rotation.z),
      scale: Vector3.scale(Vector3.One(), child.scale)
    })
    VisibilityComponent.createOrReplace(fruit, { visible: true })
  }
}

function showFoodSet(petPos: Vector3, cameraPos: Vector3): void {
  ensureFoodSet()
  if (!foodDrawer || !foodDrawerAnchor) return
  const drawerPos = feedingDrawerPosition(petPos)
  Transform.createOrReplace(foodDrawerAnchor, {
    position: drawerPos,
    rotation: Quaternion.fromLookAt(drawerPos, Vector3.create(cameraPos.x, drawerPos.y, cameraPos.z)),
    scale: Vector3.One()
  })
  applyFruitDrawerLayout()
  VisibilityComponent.createOrReplace(foodDrawer, { visible: true })

  for (let i = 0; i < foodGroundFruits.length; i++) {
    const offset = GROUND_FRUIT_OFFSETS[i]
    const fruit = foodGroundFruits[i]
    Transform.createOrReplace(fruit, {
      position: Vector3.create(drawerPos.x + offset.x, petPos.y + offset.y, drawerPos.z + offset.z),
      rotation: Quaternion.fromEulerDegrees(i * 24, i * 86, i % 2 === 0 ? 82 : -76),
      scale: Vector3.scale(Vector3.One(), 0.5)
    })
    VisibilityComponent.createOrReplace(fruit, { visible: true })
  }
  foodSetVisible = true
}

function hideFoodSet(): void {
  if (!foodSetVisible) return
  if (foodDrawer) VisibilityComponent.createOrReplace(foodDrawer, { visible: false })
  for (const fruit of foodPileFruits) VisibilityComponent.createOrReplace(fruit, { visible: false })
  for (const fruit of foodGroundFruits) VisibilityComponent.createOrReplace(fruit, { visible: false })
  foodSetVisible = false
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

function applyCatchBurstMaterial(entity: Entity, alpha: number): void {
  if (!catchBurstTexture) return
  Material.setPbrMaterial(entity, {
    texture: catchBurstTexture,
    alphaTexture: catchBurstTexture,
    emissiveTexture: catchBurstTexture,
    emissiveColor: CATCH_BURST_TINT,
    emissiveIntensity: CATCH_BURST_EMISSIVE * alpha,
    albedoColor: Color4.create(CATCH_BURST_TINT.r, CATCH_BURST_TINT.g, CATCH_BURST_TINT.b, alpha),
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

function spawnCatchBurst(): void {
  const entity = catchBursts[catchBurstIndex]
  if (!entity || !drawerEntity) return
  catchBurstIndex = (catchBurstIndex + 1) % catchBursts.length
  Tween.deleteFrom(entity)
  const transform = Transform.getMutable(entity)
  transform.parent = drawerEntity
  transform.position = CATCH_BURST_LOCAL_OFFSET
  transform.scale = Vector3.scale(Vector3.One(), CATCH_BURST_START_SCALE)
  applyCatchBurstMaterial(entity, 1)
  VisibilityComponent.createOrReplace(entity, { visible: true })
  Tween.createOrReplace(entity, {
    mode: Tween.Mode.Scale({
      start: Vector3.scale(Vector3.One(), CATCH_BURST_START_SCALE),
      end: Vector3.scale(Vector3.One(), CATCH_BURST_END_SCALE)
    }),
    duration: CATCH_BURST_GROW_MS + CATCH_BURST_FADE_MS,
    easingFunction: EasingFunction.EF_EASEOUTQUAD
  })
  catchBurstStartedAt.set(entity, clock)
}

function catchBurstTick(): void {
  for (const [entity, startedAt] of catchBurstStartedAt) {
    const ageMs = (clock - startedAt) * 1000
    if (ageMs <= CATCH_BURST_GROW_MS) continue
    const fade = (ageMs - CATCH_BURST_GROW_MS) / CATCH_BURST_FADE_MS
    if (fade >= 1) {
      Tween.deleteFrom(entity)
      VisibilityComponent.createOrReplace(entity, { visible: false })
      catchBurstStartedAt.delete(entity)
      continue
    }
    applyCatchBurstMaterial(entity, 1 - fade)
  }
}

function clearCatchBursts(): void {
  for (const entity of catchBursts) {
    Tween.deleteFrom(entity)
    VisibilityComponent.createOrReplace(entity, { visible: false })
  }
  catchBurstStartedAt.clear()
}

function applyScorchMaterial(entity: Entity, alpha: number): void {
  if (!scorchTexture) return
  Material.setPbrMaterial(entity, {
    texture: scorchTexture,
    alphaTexture: scorchTexture,
    albedoColor: Color4.create(SCORCH_TINT.r, SCORCH_TINT.g, SCORCH_TINT.b, alpha),
    roughness: 1,
    metallic: 0,
    transparencyMode: MaterialTransparencyMode.MTM_ALPHA_BLEND
  })
}

function spawnScorch(at: Vector3): void {
  const entity = scorches[scorchIndex]
  if (!entity) return
  scorchIndex = (scorchIndex + 1) % scorches.length
  Tween.deleteFrom(entity)
  const transform = Transform.getMutable(entity)
  transform.position = Vector3.create(at.x, groundY + SCORCH_Y_OFFSET, at.z)
  transform.rotation = Quaternion.fromEulerDegrees(-90, 0, Math.random() * 360)
  transform.scale = Vector3.scale(Vector3.One(), SCORCH_START_SCALE)
  applyScorchMaterial(entity, 1)
  VisibilityComponent.createOrReplace(entity, { visible: true })
  Tween.createOrReplace(entity, {
    mode: Tween.Mode.Scale({
      start: Vector3.scale(Vector3.One(), SCORCH_START_SCALE),
      end: Vector3.scale(Vector3.One(), SCORCH_END_SCALE)
    }),
    duration: SCORCH_GROW_MS,
    easingFunction: EasingFunction.EF_EASEOUTQUAD
  })
  scorchStartedAt.set(entity, clock)
}

function scorchTick(): void {
  const fadeStartMs = SCORCH_GROW_MS + SCORCH_HOLD_MS
  for (const [entity, startedAt] of scorchStartedAt) {
    const ageMs = (clock - startedAt) * 1000
    if (ageMs <= fadeStartMs) continue
    const fade = (ageMs - fadeStartMs) / SCORCH_FADE_MS
    if (fade >= 1) {
      Tween.deleteFrom(entity)
      VisibilityComponent.createOrReplace(entity, { visible: false })
      scorchStartedAt.delete(entity)
      continue
    }
    applyScorchMaterial(entity, 1 - fade)
  }
}

function clearScorches(): void {
  for (const entity of scorches) {
    Tween.deleteFrom(entity)
    VisibilityComponent.createOrReplace(entity, { visible: false })
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
    if (drawerEntity) {
      const startLocal = Vector3.add(CATCH_BURST_LOCAL_OFFSET, FRUIT_SUCK_START_LOCAL)
      const transform = Transform.getMutable(f.entity)
      transform.parent = drawerEntity
      transform.position = startLocal
      Tween.createOrReplace(f.entity, {
        mode: Tween.Mode.Move({ start: startLocal, end: CATCH_BURST_LOCAL_OFFSET }),
        duration: CATCH_SUCK_MS,
        easingFunction: EasingFunction.EF_EASEINQUAD
      })
      f.phase = 'caught'
      f.resolvedAt = clock
      return
    }
    VisibilityComponent.createOrReplace(f.entity, { visible: false })
    f.phase = 'resolved'
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
      if (tweenSystem.tweenCompleted(f.entity)) {
        Tween.deleteFrom(f.entity)
        const transform = Transform.getMutable(f.entity)
        transform.parent = undefined
        transform.scale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
        VisibilityComponent.createOrReplace(f.entity, { visible: false })
        f.phase = 'resolved'
        f.resolvedAt = clock
      }
      continue
    }
    if (f.phase === 'resolved' && clock - f.resolvedAt >= RESPAWN_DELAY_S) {
      const transform = Transform.getMutable(f.entity)
      transform.parent = undefined
      transform.position = randomCanopySpot()
      transform.scale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
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
function showResults(): void {
  // The hunger bar completes while the pet eats, so there is no second modal
  // to interrupt the final shot. Release the player as soon as that beat ends.
  finalizeAndClose()
}

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
  if (caught <= 0) {
    showResults()
    return
  }

  const hungerStart = clientState.activePet?.hunger ?? 0
  const hungerTarget = Math.min(100, hungerStart + caught * Cfg.FEED_HUNGER_PER_FRUIT)
  applyFeedMinigameLocal(caught) // optimistic local effect
  actions.feedResult(caught) // tell the server (it corrects via snapshot)

  const player = Transform.getOrNull(engine.PlayerEntity)
  if (player && cinCam) {
    const shot = feedingShot(player.position)
    const cameraStart = Transform.get(cinCam)
    const cameraEndRotation = Quaternion.fromLookAt(shot.camPos, shot.focus)
    Tween.deleteFrom(cinCam)
    Tween.createOrReplace(cinCam, {
      mode: Tween.Mode.MoveRotateScale({
        position: { start: cameraStart.position, end: shot.camPos },
        rotation: { start: cameraStart.rotation, end: cameraEndRotation }
      }),
      duration: FEED_CAMERA_TRANSITION_MS,
      easingFunction: EasingFunction.EF_EASEOUTQUAD
    })
    // Pet faces the nearby drawer; camera is perpendicular, giving a clear
    // side view of it taking a fruit and eating it.
    playEatCinematic(shot.petPos, shot.drawerPos, Cfg.FEED_EAT_CINEMATIC_S)
    startHeldFruitMotion()
    showFoodSet(shot.petPos, shot.camPos)
    suppressPetTags(true)
    setFeedingAvatarHidden(true)
  }
  phase = 'feeding'
  phaseAt = clock
  clientState.feedGame.phase = 'feeding'
  clientState.feedGame.resultsAt = Date.now()
  clientState.feedGame.hungerStart = hungerStart
  clientState.feedGame.hungerTarget = hungerTarget
}

/** Release the camera/movement lock/touch controls and hand the screen back —
 *  called once the player is done looking at the results (Exit), or right
 *  away on an early cancel (no results screen in that case). */
function finalizeAndClose(): void {
  hideHeldFruit()
  hideFoodSet()
  suppressPetTags(false)
  setFeedingAvatarHidden(false)
  clientState.debugFruitPilePanelOpen = false
  setEatCinematicPaused(false)
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
  // Back is an early exit, not a round completion: grant partial progress but
  // never start the pet-eating transition reserved for the natural timeout.
  if (caught > 0) {
    applyFeedMinigameLocal(caught)
    actions.feedResult(caught)
  }
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

/** Pet systems run before this fruit-game system, so after a debug roster swap
 * the reused local-pet entity has already loaded the selected species here. */
function tick(dt: number): void {
  if (phase === 'feeding') {
    // Pile calibration freezes the exact visual the player is positioning;
    // the hand-to-mouth prop belongs to the real, moving cinematic only.
    if (clientState.debugFruitPilePanelOpen) {
      return
    }
    advanceHeldFruitMotion(dt)
    showHeldFruit()
  }
  clock += dt
  catchBurstTick()
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
  } else if (phase === 'feeding' && clock - phaseAt >= Cfg.FEED_EAT_CINEMATIC_S) {
    showResults()
  }
}

/** Spawn the (initially hidden) fruit pool once and start the module's system. */
export function setupFruitGame(): void {
  for (let i = 0; i < NUM_FRUIT_SLOTS; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: Vector3.scale(Vector3.One(), FRUIT_SCALE) })
    GltfContainer.create(entity, { src: FRUIT_MODELS[i % FRUIT_MODELS.length], ...NO_COLLISION })
    VisibilityComponent.create(entity, { visible: false })
    fruits.push({ entity, phase: 'idle', nextDropAt: 0, resolvedAt: 0 })
  }

  for (let i = 0; i < GROUND_CLUTTER_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: Vector3.scale(Vector3.One(), FRUIT_SCALE) })
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
    Billboard.create(entity)
    VisibilityComponent.create(entity, { visible: false })
    catchBursts.push(entity)
  }

  scorchTexture = Material.Texture.Common({ src: SCORCH_TEXTURE })
  for (let i = 0; i < SCORCH_COUNT; i++) {
    const entity = engine.addEntity()
    Transform.create(entity, { position: Vector3.Zero(), scale: Vector3.Zero() })
    MeshRenderer.setPlane(entity)
    applyScorchMaterial(entity, 1)
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

/** Camera math shared by the minigame's arrival and gameplay shots. */
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
  cinematicSpawnPos = spawnPos
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
    const transform = Transform.getMutable(f.entity)
    transform.parent = undefined
    transform.scale = Vector3.scale(Vector3.One(), FRUIT_SCALE)
    transform.position = randomCanopySpot()
    VisibilityComponent.createOrReplace(f.entity, { visible: true })
    f.phase = 'idle'
  }

  hideHeldFruit()
  hideFoodSet()
  clearCatchBursts()
  clearScorches()
  suppressPetTags(false)
  setFeedingAvatarHidden(false)
  clientState.debugFruitPilePanelOpen = false
  setEatCinematicPaused(false)
  clientState.feedGame = {
    active: true,
    phase: 'arrival',
    caught: 0,
    timeLeft: GAME_DURATION_S,
    catchFlashUntil: 0,
    countdownAt: 0,
    resultsAt: 0,
    petSitPos,
    petSitLook: laneMid,
    hungerStart: 0,
    hungerTarget: 0
  }
  introEmotePlayed = false
  drawerRevealed = false
  phase = 'arrival'
  phaseAt = clock
  console.log(`[Client] fruit game: startFruitGame() full reset done — introEmotePlayed=${introEmotePlayed}, drawerRevealed=${drawerRevealed}, drawerEntity=${drawerEntity}`)
}

// ---------------------------------------------------------------------------
// Compact fruit-pile calibration: it freezes the final Feed beat while the
// player moves the single parent transform that owns the fruit pile.
// ---------------------------------------------------------------------------
export function debugFruitPileToggle(): boolean {
  if (phase !== 'feeding') return false
  clientState.debugFruitPilePanelOpen = !clientState.debugFruitPilePanelOpen
  setEatCinematicPaused(clientState.debugFruitPilePanelOpen)
  if (clientState.debugFruitPilePanelOpen) {
    holdFruitAtHand()
    applyFruitPileLayout()
    setDrawerFruitForCurrentBite(false)
  }
  return true
}

export function debugFruitPileActive(): boolean {
  return phase === 'feeding' && clientState.debugFruitPilePanelOpen
}

export function debugFruitPileLabel(key: DebugFruitPileKey): string {
  switch (key) {
    case 'x': return 'Pile X'
    case 'y': return 'Pile Y'
    case 'z': return 'Pile Z'
    case 'scale': return 'Pile scale'
  }
}

export function debugFruitPileValue(key: DebugFruitPileKey): number {
  return fruitPileCalibration[key]
}

export function debugFruitPileAdjust(key: DebugFruitPileKey, delta: number): void {
  fruitPileCalibration[key] += delta
  if (key === 'scale') fruitPileCalibration.scale = Math.max(0.2, Math.min(2, fruitPileCalibration.scale))
  applyFruitPileLayout()
}

export function debugFruitPileReset(): void {
  fruitPileCalibration = { ...DEFAULT_FRUIT_PILE }
  applyFruitPileLayout()
}

export function debugFruitDrawerLabel(key: DebugFruitPileKey): string {
  switch (key) {
    case 'x': return 'Crate X'
    case 'y': return 'Crate Y'
    case 'z': return 'Crate Z'
    case 'scale': return 'Crate scale'
  }
}

export function debugFruitDrawerValue(key: DebugFruitPileKey): number {
  return fruitDrawerCalibration[key]
}

export function debugFruitDrawerAdjust(key: DebugFruitPileKey, delta: number): void {
  fruitDrawerCalibration[key] += delta
  if (key === 'scale') fruitDrawerCalibration.scale = Math.max(0.4, Math.min(2, fruitDrawerCalibration.scale))
  applyFruitDrawerLayout()
}

export function debugFruitDrawerReset(): void {
  fruitDrawerCalibration = { ...DEFAULT_FRUIT_DRAWER }
  applyFruitDrawerLayout()
}

/** Restart only the baked pet eat loop from frame zero. */

/** Pause or resume only the baked pet eat loop. */



/** Restart only the procedural fruit hand → mouth path from its hand point. */

/** Pause or resume only the procedural fruit path. */



/** Shift the fruit along its loop without restarting the pet animation. */


/** Put both animations on the same frame zero and make their speed equal. */

/** Launch a no-reward preview of the actual final Feed shot. Its timeline is
 * locked open while the complete fruit pile is positioned. */
export function startDebugFruitPilePreview(): boolean {
  const pet = clientState.activePet
  if (!pet || phase !== 'idle') return false
  startFruitGame(pet.id)
  if (!clientState.feedGame.active || !cinCam) return false

  stopHoldEmote()
  if (drawerEntity) VisibilityComponent.getMutable(drawerEntity).visible = false
  for (const fruit of fruits) {
    Tween.deleteFrom(fruit.entity)
    VisibilityComponent.createOrReplace(fruit.entity, { visible: false })
    fruit.phase = 'idle'
  }

  const shot = feedingShot(cinematicSpawnPos)
  Transform.createOrReplace(cinCam, {
    position: shot.camPos,
    rotation: Quaternion.fromLookAt(shot.camPos, shot.focus)
  })
  playEatCinematic(shot.petPos, shot.drawerPos, Cfg.FEED_EAT_CINEMATIC_S)
  startHeldFruitMotion()
  showFoodSet(shot.petPos, shot.camPos)
  suppressPetTags(true)
  setFeedingAvatarHidden(true)
  phase = 'feeding'
  phaseAt = clock
  clientState.feedGame.phase = 'feeding'
  clientState.feedGame.resultsAt = Date.now()
  clientState.debugFruitPilePanelOpen = true
  holdFruitAtHand()
  setEatCinematicPaused(true)
  return true
}

// The fruit-pile preview is the only feed debug entry point.

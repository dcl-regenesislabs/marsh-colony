// The Ark's two cinematics (issue #248):
//
//  - Hand-over: after the server accepts a donation, the pet walks up the ramp,
//    the dome door opens and it boards the ship. A fresh clone entity plays the
//    walk — the real pet entity belongs to pet.ts's pool and is retired there
//    when the snapshot drops the pet from the roster.
//  - Launch: when the goal is reached the ship lifts off for everyone in the
//    scene, then a card tells each player what they earned. Donors who were away
//    get the same sequence first thing on their next visit (snapshot arkUnseen).
//
// Both freeze the player and drive a VirtualCamera; the HUD is hidden while
// clientState.ark.cinematic is set (ui.tsx Root).

import { Animator, ColliderLayer, engine, Entity, GltfContainer, InputModifier, MainCamera, Transform, VirtualCamera, VisibilityComponent } from '@dcl/sdk/ecs'
import { Quaternion, Vector3 } from '@dcl/sdk/math'
import * as C from '../shared/config'
import type { ArkDonateResult, ArkLaunchView, ArkStatus, PetData } from '../shared/types'
import { actions, clientState, hasPendingHatchling, pushToast, showReward } from './state'
import { applyCreatureSkin } from './creatureSkins'
import { getLocalPet, growthCinematicActive } from './pet'
import { arkHome, resetArk, setArkCounterHidden, setArkDoor, setArkLift, setArkVisible } from './ark'
import { sicknessCinematicOwnsFlow } from './sicknessCinematic'
import { uiPanelOpen } from './ui'

// ---- Hand-over path (world coords, measured from arkRamp01.glb / ark01.glb) ----
// The ramp climbs from z≈219.8 (ground) to z≈210.5 (4.05 m up) along x≈160.14;
// the dome door sits at z≈208.5 and the corridor behind it reaches z≈205.8.
const RAMP_FOOT = Vector3.create(160.14, 0, 221.2)
const RAMP_TOP = Vector3.create(160.14, 4.05, 210.4)
const DOOR = Vector3.create(160.18, 3.75, 208.4)
const INSIDE = Vector3.create(160.18, 3.75, 206)
// Where the pet appears when it isn't already next to the Captain (a stored pet
// from the corral): beside the Captain, at the foot of the ramp.
const SPAWN_BESIDE_CAPTAIN = Vector3.create(161.2, 0, 224)
const SPAWN_FROM_PET_MAX_DIST = 14
const HANDOVER_WALK_SPEED = 2.4 // m/s — a calm walk so the boarding reads
const HANDOVER_CAM_POS = Vector3.create(166, 4, 225.5)
const HANDOVER_LOOK_LIFT = 0.8
// Height correction on the ramp: 0 at its foot, the full value from its top on
// (door + corridor), linear in between. Negative lowers the pet.
const HANDOVER_RAMP_LIFT = -0.45
const DOOR_WAIT_S = 1.1 // pet waits at the top while the door opens
const DOOR_CLOSE_S = 0.9 // door closes behind it before the camera returns
const PENDING_TIMEOUT_MS = 8000

// ---- Launch (placeholder lift-off until the ship GLB ships its own clip) ----
const LAUNCH_CAM_POS = Vector3.create(182, 6, 242)
const LAUNCH_LOOK_HEIGHT = 7 // aim at the dome, not the ship's pivot
const LAUNCH_APPROACH_S = 1.4
const LAUNCH_RUMBLE_S = 1.8
const LAUNCH_LIFT_S = 5
const LAUNCH_LIFT_HEIGHT = 90
const LAUNCH_SHAKE = 0.08

// ---- DEBUG: live tuner for the hand-over shot (ui.tsx ArkHandoverTuner) ----
/** Shows the tuner + a "Test walk" button that replays the hand-over without
 *  donating. Set false to ship. */
export const ARK_HANDOVER_TUNER_ENABLED = false
/** DEBUG: "Test launch" buttons that play the lift-off + card locally, without
 *  filling the Ark (nothing is sent to the server). Set false to ship. */
export const ARK_LAUNCH_DEBUG_ENABLED = false
export type ArkTuneKey = 'camX' | 'camY' | 'camZ' | 'lookLift' | 'rampLift'
const TUNE_DEFAULTS: Record<ArkTuneKey, number> = {
  camX: HANDOVER_CAM_POS.x,
  camY: HANDOVER_CAM_POS.y,
  camZ: HANDOVER_CAM_POS.z,
  lookLift: HANDOVER_LOOK_LIFT,
  rampLift: HANDOVER_RAMP_LIFT
}
const tune: Record<ArkTuneKey, number> = { ...TUNE_DEFAULTS }
let tunePaused = false

const FADE_OUT_MS = 160
const FADE_HOLD_MS = 250
const FADE_IN_MS = 200

// ---------------------------------------------------------------------------
// Shared camera / freeze helpers
// ---------------------------------------------------------------------------
let camera: Entity | null = null
// What the camera aims at. A separate entity (not the pet clone / the ship) so
// the shot holds steady when the clone is parked off-map at the end.
let lookTarget: Entity | null = null

function aimAt(position: Vector3): Entity {
  if (!lookTarget) lookTarget = engine.addEntity()
  Transform.createOrReplace(lookTarget, { position })
  return lookTarget
}

function freezePlayer(): void {
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
}

function useCamera(position: Vector3, lookAt: Entity, transitionS: number): void {
  if (!camera) camera = engine.addEntity()
  Transform.createOrReplace(camera, { position })
  VirtualCamera.createOrReplace(camera, { lookAtEntity: lookAt, defaultTransition: { transitionMode: VirtualCamera.Transition.Time(transitionS) } })
  MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: camera })
}

/** Fade to black, run `onBlack` (camera hand-back, scene reset) under it, fade
 *  back in and give control back — same seam-hiding recipe as the sickness scene. */
function fadeAndRelease(onBlack: () => void, onDone: () => void): void {
  let stage: 'out' | 'hold' | 'in' = 'out'
  let elapsedMs = 0
  const tick = (dt: number): void => {
    elapsedMs += dt * 1000
    if (stage === 'out') {
      clientState.screenFade.alpha = Math.min(1, elapsedMs / FADE_OUT_MS)
      if (elapsedMs < FADE_OUT_MS) return
      clientState.screenFade.alpha = 1
      if (MainCamera.has(engine.CameraEntity)) MainCamera.createOrReplace(engine.CameraEntity, { virtualCameraEntity: undefined })
      onBlack()
      stage = 'hold'
      elapsedMs = 0
      return
    }
    if (stage === 'hold') {
      if (elapsedMs < FADE_HOLD_MS) return
      stage = 'in'
      elapsedMs = 0
      return
    }
    clientState.screenFade.alpha = Math.max(0, 1 - elapsedMs / FADE_IN_MS)
    if (elapsedMs < FADE_IN_MS) return
    clientState.screenFade.alpha = 0
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
    engine.removeSystem(tick)
    onDone()
  }
  engine.addSystem(tick)
}

// ---------------------------------------------------------------------------
// Hand-over
// ---------------------------------------------------------------------------
type Handover = {
  result: ArkDonateResult
  clone: Entity
  pos: Vector3 // position along the path; the clone renders it + the ramp lift
  route: Vector3[] // waypoints still ahead, in order
  yawOffset: number
  phase: 'walk' | 'doorWait' | 'enter' | 'doorClose' | 'releasing'
  timer: number
  debug: boolean // a tuner "Test walk": no server donation, no thanks card
}

let handover: Handover | null = null
let pendingStart: Vector3 | null = null
let pendingSince = 0

/** Ask the server to take `pet`. The cinematic starts on its answer. */
export function requestArkDonation(pet: PetData): void {
  if (clientState.ark.pendingDonation || handover || launch || growthCinematicActive()) return
  clientState.ark.pendingDonation = pet
  pendingSince = Date.now()
  // Remember where the pet is standing so the clone starts there (only the
  // active pet is out in the world next to the player).
  const local = getLocalPet()
  pendingStart = clientState.activePet?.id === pet.id && local && Transform.has(local) ? Vector3.clone(Transform.get(local).position) : null
  actions.donatePet(pet.id)
}

export function onArkDonateResult(result: ArkDonateResult): void {
  const pet = clientState.ark.pendingDonation
  clientState.ark.pendingDonation = null
  if (!result.ok) {
    pushToast(result.message, 'error')
    return
  }
  startHandover(result, pet, pendingStart)
  pendingStart = null
}

function makeClone(species: string, rarity: ArkDonateResult['rarity'], size: number, at: Vector3): Entity {
  const e = engine.addEntity()
  const scale = C.stageScaleFor(size) * C.scaleForSpecies(species)
  Transform.create(e, { position: at, scale: Vector3.create(scale, scale, scale) })
  GltfContainer.create(e, { src: C.modelForSpecies(species), visibleMeshesCollisionMask: ColliderLayer.CL_NONE, invisibleMeshesCollisionMask: ColliderLayer.CL_NONE })
  applyCreatureSkin(e, species, rarity)
  Animator.create(e, {
    states: [
      { clip: C.clipForSpecies(species, 'walk'), playing: true, loop: true, speed: C.PET_WALK_PLAYBACK_SPEED * (HANDOVER_WALK_SPEED / C.PET_MOVE_SPEED), weight: 1 },
      { clip: C.clipForSpecies(species, 'idle'), playing: false, loop: true, speed: 1, weight: 1 }
    ]
  })
  return e
}

/** Toggle the clone between its walk and idle clips. */
function setCloneWalking(e: Entity, walking: boolean): void {
  const [walk, idle] = Animator.getMutable(e).states
  if (walk) walk.playing = walking
  if (idle) idle.playing = !walking
}

function startHandover(result: ArkDonateResult, pet: PetData | null, from: Vector3 | null, debug = false): void {
  const nearCaptain = from && Vector3.distance(Vector3.create(from.x, 0, from.z), RAMP_FOOT) <= SPAWN_FROM_PET_MAX_DIST
  const start = nearCaptain ? Vector3.create(from!.x, C.PET_BASE_Y, from!.z) : Vector3.clone(SPAWN_BESIDE_CAPTAIN)
  const species = pet?.species ?? result.species
  const clone = makeClone(species, result.rarity, pet?.size ?? C.SIZE_MAX, start)
  handover = { result, clone, pos: start, route: [RAMP_FOOT, RAMP_TOP], yawOffset: C.yawOffsetForSpecies(species), phase: 'walk', timer: 0, debug }
  tunePaused = false
  clientState.ark.cinematic = 'handover'
  freezePlayer()
  useCamera(handoverCamPos(), aimAt(handoverAim(start)), 0.8)
}

function handoverCamPos(): Vector3 {
  return Vector3.create(tune.camX, tune.camY, tune.camZ)
}

/** Aim a little above the pet's feet so it sits mid-frame. */
function handoverAim(petPos: Vector3): Vector3 {
  return Vector3.create(petPos.x, petPos.y + tune.lookLift, petPos.z)
}

/** Where the clone is drawn: its path position plus the ramp height correction,
 *  phased in from the foot of the ramp (0) to its top (full). */
function rampLifted(pos: Vector3): Vector3 {
  const k = Math.max(0, Math.min(1, (RAMP_FOOT.z - pos.z) / (RAMP_FOOT.z - RAMP_TOP.z)))
  return Vector3.create(pos.x, pos.y + tune.rampLift * k, pos.z)
}

/** Walk the clone toward the next waypoint. True once the route is done. */
function walkRoute(h: Handover, dt: number): boolean {
  const t = Transform.getMutable(h.clone)
  let budget = HANDOVER_WALK_SPEED * dt
  while (budget > 0 && h.route.length > 0) {
    const target = h.route[0]
    const to = Vector3.subtract(target, h.pos)
    const dist = Vector3.length(to)
    if (dist > 0.001) {
      const flat = Vector3.create(to.x, 0, to.z)
      if (Vector3.length(flat) > 0.001) {
        const yaw = (Math.atan2(flat.x, flat.z) * 180) / Math.PI
        t.rotation = Quaternion.fromEulerDegrees(0, yaw + h.yawOffset, 0)
      }
    }
    if (dist <= budget) {
      h.pos = Vector3.clone(target)
      budget -= dist
      h.route.shift()
    } else {
      h.pos = Vector3.add(h.pos, Vector3.scale(to, budget / dist))
      budget = 0
    }
  }
  t.position = rampLifted(h.pos)
  return h.route.length === 0
}

function parkClone(e: Entity): void {
  // Same reason pet.ts never destroys a skinned creature: removing an entity
  // with a GltfNodeModifiers override crashes the desktop client. Hide + park.
  VisibilityComponent.createOrReplace(e, { visible: false })
  Transform.getMutable(e).position = Vector3.create(0, -100, 0)
  Animator.deleteFrom(e)
}

function tickHandover(dt: number): void {
  const h = handover
  if (!h) return
  // Follow the pet while it's walking; once it's inside, the aim stays at the door.
  const onPath = h.phase === 'walk' || h.phase === 'doorWait' || h.phase === 'enter'
  if (onPath) {
    // Re-applied every frame so tuner nudges show up live, even while paused.
    Transform.getMutable(h.clone).position = rampLifted(h.pos)
    if (lookTarget) Transform.getMutable(lookTarget).position = handoverAim(rampLifted(h.pos))
  }
  if (camera && h.phase !== 'releasing') Transform.getMutable(camera).position = handoverCamPos()
  if (tunePaused) return
  h.timer += dt
  switch (h.phase) {
    case 'walk':
      if (walkRoute(h, dt)) {
        setArkDoor(true)
        h.phase = 'doorWait'
        h.timer = 0
        setCloneWalking(h.clone, false) // wait at the top while the door opens
      }
      return
    case 'doorWait':
      if (h.timer < DOOR_WAIT_S) return
      setCloneWalking(h.clone, true)
      h.route = [DOOR, INSIDE]
      h.phase = 'enter'
      return
    case 'enter':
      if (!walkRoute(h, dt)) return
      parkClone(h.clone)
      setArkDoor(false)
      h.phase = 'doorClose'
      h.timer = 0
      return
    case 'doorClose':
      if (h.timer < DOOR_CLOSE_S) return
      h.phase = 'releasing'
      fadeAndRelease(
        () => {},
        () => {
          clientState.ark.cinematic = 'none'
          if (!h.debug) {
            showReward(h.result.xp, h.result.coins)
            // The floating +XP/+coins is the usual feedback; the card is only for
            // the first donation, to show the wearable it earned.
            if (h.result.firstWearableId) clientState.ark.thanks = h.result
            // Gave away their last pet: point them back to the Caretaker.
            if ((clientState.player?.pets.length ?? 0) === 0) pushToast('Visit the Caretaker at the Care Center to adopt a new companion!')
          }
          handover = null
        }
      )
      return
    case 'releasing':
      return
  }
}

/** The first-donation card was dismissed. */
export function closeArkThanks(): void {
  clientState.ark.thanks = null
}

// ---------------------------------------------------------------------------
// DEBUG tuner (ARK_HANDOVER_TUNER_ENABLED) — every change applies live and is
// logged, ready to paste into the HANDOVER_* constants above.
// ---------------------------------------------------------------------------
export function getArkHandoverTuning(): { values: Record<ArkTuneKey, number>; running: boolean; paused: boolean } {
  return { values: { ...tune }, running: !!handover, paused: tunePaused }
}

function logTuning(): void {
  console.log(
    `[Ark hand-over tuner] HANDOVER_CAM_POS = Vector3.create(${tune.camX.toFixed(2)}, ${tune.camY.toFixed(2)}, ${tune.camZ.toFixed(2)})` +
      ` | HANDOVER_LOOK_LIFT = ${tune.lookLift.toFixed(2)} | HANDOVER_RAMP_LIFT = ${tune.rampLift.toFixed(2)}`
  )
}

export function nudgeArkHandover(key: ArkTuneKey, amount: number): void {
  tune[key] = Math.round((tune[key] + amount) * 100) / 100
  logTuning()
}

export function resetArkHandoverTuning(): void {
  Object.assign(tune, TUNE_DEFAULTS)
  logTuning()
}

export function toggleArkHandoverPause(): void {
  if (!handover) return
  tunePaused = !tunePaused
  setCloneWalking(handover.clone, !tunePaused && handover.phase !== 'doorWait')
}

/** Replay the hand-over with the active pet's look, without donating anything.
 *  Starts beside the Captain, like a pet brought from the corral. */
export function debugPlayArkHandover(): void {
  if (handover || launch || clientState.ark.pendingDonation) return
  const pet = clientState.activePet
  const result: ArkDonateResult = {
    ok: true,
    message: '',
    petName: pet?.name ?? 'Test pet',
    species: pet?.species ?? 'sprout-original',
    rarity: pet?.rarity ?? 'common',
    xp: 0,
    coins: 0,
    firstWearableId: ''
  }
  startHandover(result, pet ? { ...pet, size: C.SIZE_MAX } : null, null, true)
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------
const launchQueue: ArkLaunchView[] = []
const launchHandled = new Set<number>() // eventIds already queued/shown this session

type Launch = { views: ArkLaunchView[]; phase: 'approach' | 'rumble' | 'lift' | 'card' | 'releasing'; timer: number; look: Entity }
let launch: Launch | null = null

/** DEBUG: play the launch as a donor (earns the current event's wearable) or as
 *  a bystander. Local only — fake negative eventIds are never acknowledged, so
 *  the real counter, grants and launchSeen are untouched. */
export function debugPlayArkLaunch(asDonor: boolean): void {
  if (launch || handover) return
  enqueueArkLaunch({
    eventId: asDonor ? -1 : -2,
    launchedAt: Date.now(),
    donatedByMe: asDonor ? 3 : 0,
    wearableId: C.arkLaunchWearable(clientState.ark.status.eventId).id
  })
}

/** Queue a launch to play (live broadcast, or replay from the snapshot). */
export function enqueueArkLaunch(view: ArkLaunchView): void {
  if (launchHandled.has(view.eventId)) return
  if (launchQueue.some((v) => v.eventId === view.eventId)) return
  if (launch && launch.views.some((v) => v.eventId === view.eventId)) return
  launchQueue.push(view)
  // The Ark this player is about to watch lift off is a FULL one: hold the
  // counter at goal/goal until the cinematic has played (see applyArkStatus).
  if (!heldStatus) heldStatus = clientState.ark.status
  clientState.ark.status = { ...heldStatus, donated: heldStatus.goal }
}

// The newest real status received while a launch is queued / playing. The
// server rolls into the next event (0 / goal) the instant the goal is reached,
// so showing that right away would empty the door sign and the HUD before the
// player has seen the Ark leave.
let heldStatus: ArkStatus | null = null

/** Server progress update: applied now, or after the pending launch has played. */
export function applyArkStatus(status: ArkStatus): void {
  if (launch || launchQueue.length > 0) heldStatus = status
  else clientState.ark.status = status
}

/** Wait for a calm moment: never over a minigame, an errand or carry, a pending
 *  keep/discard, another cinematic, a dialog or an open panel — the launch then
 *  takes over the screen. */
function canStartLaunch(): boolean {
  const s = clientState
  return (
    s.serverReady &&
    s.ark.cinematic === 'none' &&
    !handover &&
    !s.ark.pendingDonation &&
    !s.ark.thanks &&
    !s.dialog.open &&
    !s.incomingSwap &&
    !s.petPanelOpen &&
    !s.feedGame.active &&
    !s.bathGame.active &&
    !s.petting.active &&
    !s.hatch.active &&
    !s.fetch.active &&
    !s.pepitoChase.active &&
    !s.breed.active &&
    !s.carryPet.active &&
    !s.carryEgg.active &&
    !s.feedTask.active &&
    !s.sicknessErrand.active &&
    !hasPendingHatchling() &&
    !s.pendingHatchlingDecision &&
    !(s.arkRedeem.active && s.arkRedeem.phase === 'confirm') &&
    !sicknessCinematicOwnsFlow() &&
    !growthCinematicActive() &&
    !uiPanelOpen() &&
    s.screenFade.alpha <= 0
  )
}

function startLaunch(): void {
  const home = arkHome()
  if (!home) return // ship not loaded yet — try again next frame
  const views = launchQueue.splice(0)
  const look = aimAt(Vector3.create(home.x, home.y + LAUNCH_LOOK_HEIGHT, home.z))
  launch = { views, phase: 'approach', timer: 0, look }
  clientState.ark.cinematic = 'launch'
  setArkCounterHidden(true)
  setArkDoor(false)
  freezePlayer()
  useCamera(LAUNCH_CAM_POS, look, LAUNCH_APPROACH_S)
}

function tickLaunch(dt: number): void {
  const l = launch
  if (!l) return
  l.timer += dt
  const home = arkHome()
  switch (l.phase) {
    case 'approach':
      if (l.timer >= LAUNCH_APPROACH_S) {
        l.phase = 'rumble'
        l.timer = 0
      }
      return
    case 'rumble':
      setArkLift(0, LAUNCH_SHAKE * Math.min(1, l.timer / LAUNCH_RUMBLE_S))
      if (l.timer >= LAUNCH_RUMBLE_S) {
        l.phase = 'lift'
        l.timer = 0
      }
      return
    case 'lift': {
      const k = Math.min(1, l.timer / LAUNCH_LIFT_S)
      const lift = LAUNCH_LIFT_HEIGHT * k * k * k // ease-in: slow heave, then away
      setArkLift(lift, LAUNCH_SHAKE * (1 - k))
      // Keep the camera on the ship for most of the climb, then let it go.
      if (home) Transform.getMutable(l.look).position = Vector3.create(home.x, home.y + LAUNCH_LOOK_HEIGHT + Math.min(lift, LAUNCH_LIFT_HEIGHT * 0.45), home.z)
      if (k >= 1) {
        setArkVisible(false)
        clientState.ark.launchCard = l.views
        l.phase = 'card'
      }
      return
    }
    case 'card':
    case 'releasing':
      return
  }
}

/** The "the Ark has lifted off" card was dismissed: mark the launches as seen,
 *  bring the (next) Ark back on its pad and return control. */
export function closeArkLaunchCard(): void {
  const l = launch
  if (!l || l.phase !== 'card') return
  l.phase = 'releasing'
  clientState.ark.launchCard = null
  for (const v of l.views) {
    if (v.eventId < 0) continue // debugPlayArkLaunch: not a real launch, nothing to acknowledge
    launchHandled.add(v.eventId)
    actions.ackArkLaunch(v.eventId)
  }
  fadeAndRelease(
    () => {
      resetArk()
      setArkCounterHidden(false)
      // The next Ark is on the pad: show its real progress, unless another
      // launch is already queued behind this one.
      if (heldStatus && launchQueue.length === 0) {
        clientState.ark.status = heldStatus
        heldStatus = null
      }
    },
    () => {
      clientState.ark.cinematic = 'none'
      launch = null
    }
  )
}

export function setupArkCinematics(): void {
  engine.addSystem((dt: number) => {
    // The server normally answers in well under a second; never leave the
    // Captain flow waiting forever on a lost reply.
    if (clientState.ark.pendingDonation && Date.now() - pendingSince > PENDING_TIMEOUT_MS) {
      clientState.ark.pendingDonation = null
      pendingStart = null
      pushToast('The Captain could not take your pet — please try again.', 'error')
    }
    tickHandover(dt)
    tickLaunch(dt)
    if (!launch && launchQueue.length > 0 && canStartLaunch()) startLaunch()
  })
}

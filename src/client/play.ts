// Play action (Fetch): as soon as Fetch mode is opened, a ball (a plain
// yellow sphere for now — see applyBallShape(), a placeholder for a real
// tennis-ball texture later) appears attached to the player's right hand
// (same AvatarAttach trick pet.ts uses to carry the egg). Holding the Throw
// button charges a throw (clientState.fetch.charge ramps 0→1 over
// CHARGE_TIME) — the ball just sits in the hand while charging, no animation
// change — and releasing plays the throw emote (the ball stays in the hand
// through the wind-up) and, right as the throw is finishing, swaps the held
// ball for a free-flying one whose distance/arc/flight-time/bounce all scale
// with how long it was charged. Then the pet runs to it, grabs it, carries it
// back to the player and drops it — which applies the normal "play" reward,
// and a fresh ball reappears in the hand for the next throw. (The old play
// action — pet walks to the ball — is suspended; see input.ts / ui.tsx.)

import { engine, Entity, Transform, MeshRenderer, Material, AvatarMask, AvatarAttach, AvatarAnchorPointType, inputSystem, PointerEventType } from '@dcl/sdk/ecs'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { triggerSceneEmote } from '~system/RestrictedActions'
import * as C from '../shared/config'
import { getLocalPet, sendPetTo, getLogicalClip } from './pet'
import { applyCareLocal, canPlayNow } from './sim'
import { actions, clientState, pushToast } from './state'
import { FETCH_TOUCH_ACTION, showFetchTouchButton, hideFetchTouchButton } from './touchControls'
import { mobile } from './ui/theme'
import { triggerFetchHintFadeOut } from './ui/anim'

// Native mobile Throw button (see touchControls.ts) icon — kept the same
// (no "searching" swap) the whole time Fetch mode is open.
const THROW_READY_ICON = 'assets/images/throwicon.png'

const TENNIS_YELLOW = Color4.create(0.85, 0.98, 0.2, 1)

/** Placeholder ball look: a plain tennis-yellow sphere. Swap for a textured
 *  sphere (Material.Texture.Common) once real ball art lands. */
export function applyBallShape(entity: Entity): void {
  MeshRenderer.setSphere(entity)
  Material.setPbrMaterial(entity, { albedoColor: TENNIS_YELLOW })
}

// Scene emotes must end in '_emote.glb' (Unity enforces this naming
// convention — see pet.ts's HOLD_EMOTE comment); a differently-named file
// silently gets rejected (triggerSceneEmote resolves success:false, no
// error). This clip (no mesh, same Avatar_* skeleton as the real avatar) is a
// single 0.67s wind-up-and-throw action. Played masked AM_UPPER_BODY like
// every other scene emote in this codebase (holdEmote.ts) — an unmasked
// full-body trigger was rejected the same way (success:false), so masked is
// the only version that actually plays.
const THROW_EMOTE = 'models/throw_ball_emote.glb'
const THROW_RELEASE_DELAY = 0.2 // seconds from triggering the emote to release
const HAND_BALL_X = 0.07 // held-ball offset in the hand anchor's local space — same idea as pet.ts's EGG_HAND_OFFSET
const HAND_BALL_Y = 0.07
const HAND_BALL_Z = -0.01
// Launch point approximation: forward + to the RIGHT of center (a real right
// hand isn't on the centerline) + roughly hand/shoulder height, so the
// released ball reads as leaving the hand instead of popping out of the
// chest. There's no way to read the AvatarAttach hand bone's actual world
// position back out of ECS state, so this is a hand-tuned estimate.
const HAND_FORWARD_OFFSET = 0.17
const HAND_RIGHT_OFFSET = 0.26
const HAND_HEIGHT = 1.68
const CHARGE_TIME = 1.1 // seconds of holding Throw to go from 0 to full charge
// Charge (0..1, how long Throw was held) scales the whole throw between these
// MIN_/MAX_ pairs — a tap throws weak/short, a full hold throws far.
const MIN_FLIGHT_TIME = 0.8
const MAX_FLIGHT_TIME = 1.6
const MIN_THROW_DISTANCE = 6
const MAX_THROW_DISTANCE = 18
const MIN_ARC_HEIGHT = 2.0
const MAX_ARC_HEIGHT = 4.8
const SPIN_SPEED = 540 // deg/sec tumble while flying
const LINGER = 2.0 // seconds resting on the ground if there's no pet to fetch
export const SCALE = 0.14 // ball diameter in metres — was 0.35 (tuned for the old meteorite mesh), way too big for a primitive sphere at scale 1 = 1m
const GROUND_REST_Y = SCALE / 2 // ball's centre height when resting on the ground (its radius) — was a flat 0.35/0.2 tuned for the old, bigger mesh; floated well above the floor once the ball shrank

// Pet-carry offset (where the ball sits relative to the pet while it's
// bringing it back) — PER SPECIES, since the 4 pets have different body
// proportions (see Cfg.SPECIES_SCALE) and one fixed offset didn't fit all of
// them — AND per animation state (idle vs walk), since a walk cycle's bob
// shifts the mouth/hold point vs standing still. Calibrated in-client;
// species/state combos not yet tuned fall back to DEFAULT_CARRY_OFFSET, and
// the 3 sprout-family breeding variants share sprout-original's entry (same
// rig/proportions, see Cfg.SPROUT_SPECIES). In practice the real "pet carries
// the ball back" sequence is in 'walk' almost the whole time (it's actively
// walking home), so 'walk' is the default state when unspecified.
export type AnimState = 'idle' | 'walk'
export type CarryOffset = { forward: number; right: number; height: number }
export const DEFAULT_CARRY_OFFSET: CarryOffset = { forward: 0.6, right: 0, height: 0.45 }
export const CARRY_OFFSET_BY_SPECIES: Partial<Record<string, Partial<Record<AnimState, CarryOffset>>>> = {
  'sprout-original': {
    idle: { forward: 0.18, right: -0.5, height: 0.49 },
    walk: { forward: 0.1, right: -0.58, height: 0.59 }
  },
  'pepito-original': {
    idle: { forward: 0.16, right: -0.38, height: 0.43 },
    walk: { forward: -0.28, right: -0.3, height: 0.35 }
  },
  'amebita-original': {
    idle: { forward: 0.1, right: -0.4, height: 0.53 },
    walk: { forward: -0.14, right: -0.54, height: 0.71 }
  },
  'fluflito-original': {
    idle: { forward: 0.14, right: -0.46, height: 0.59 },
    walk: { forward: -0.08, right: -0.44, height: 0.63 }
  }
}

export function carryOffsetForSpecies(species: string, state: AnimState = 'walk'): CarryOffset {
  const key = C.SPROUT_SPECIES.includes(species) ? C.SPROUT_BASE : species
  return CARRY_OFFSET_BY_SPECIES[key]?.[state] ?? DEFAULT_CARRY_OFFSET
}
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

// Decaying bounces after the primary landing, before the pet is sent to
// fetch it — each bounce keeps BOUNCE_DECAY of the previous one's height,
// forward travel and duration, continuing in the same throw direction. The
// first bounce also scales with charge power, same as the throw itself.
const BOUNCE_COUNT = 2
const BOUNCE_DECAY = 0.4
const MIN_FIRST_BOUNCE_HEIGHT = 0.4
const MAX_FIRST_BOUNCE_HEIGHT = 0.9
const MIN_FIRST_BOUNCE_FORWARD = 0.7
const MAX_FIRST_BOUNCE_FORWARD = 1.8
const MIN_FIRST_BOUNCE_DURATION = 0.25
const MAX_FIRST_BOUNCE_DURATION = 0.45

// 'fly' = arcing through the air. 'bounce' = decaying bounces after landing
// (see BOUNCE_COUNT). 'wait' = grounded (settled), pet running to it.
// 'carry' = pet bringing it back. 'dropped' = left on the floor by the avatar,
// lingering before it disappears. Only one fetch runs at a time.
type Phase = 'fly' | 'bounce' | 'wait' | 'carry' | 'dropped'
type Flight = {
  entity: Entity
  from: Vector3
  to: Vector3
  t: number
  phase: Phase
  spin: number
  flightTime: number // this throw's charge-scaled flight duration
  arcHeight: number // this throw's charge-scaled arc peak height
  dir: Vector3 // throw direction, reused to keep bouncing forward in a straight line
  bounceIndex: number // how many bounces have completed so far
  bounceHeight: number // current/next bounce's peak height
  bounceForward: number // current/next bounce's forward travel
  bounceDuration: number // current/next bounce's duration
}
let flight: Flight | null = null
let handAnchor: Entity | null = null // empty attached to the right-hand bone, alive while Fetch mode is open
let handBall: Entity | null = null // the visible held meteorite, child of handAnchor; absent while one is in flight

/** Throw button held down: start charging (no visual/animation change — the
 *  ball just sits in the hand — see clientState.fetch.charge/charging). */
export function startCharge(): void {
  if (flight || clientState.fetch.busy || clientState.fetch.charging) return
  clientState.fetch.charging = true
  clientState.fetch.charge = 0
}

/** Throw button released: play the throw emote right away — the ball stays in
 *  the hand through the wind-up (see carryBallSystem) — and swap it for a
 *  free-flying one once the emote is finishing (THROW_RELEASE_DELAY later).
 *  How long it was charged (0 for a plain tap) scales the whole throw. The
 *  pet fetches it once it lands. */
export function releaseCharge(): void {
  if (!clientState.fetch.charging) return
  const power = clientState.fetch.charge
  clientState.fetch.charging = false
  clientState.fetch.charge = 0
  beginThrow(power)
}

function chargeSystem(dt: number): void {
  if (!clientState.fetch.charging) return
  clientState.fetch.charge = Math.min(1, clientState.fetch.charge + dt / CHARGE_TIME)
}

function beginThrow(power: number): void {
  if (flight) return // a fetch is already in progress — ignore extra throws
  // Energy gate: each fetch drains PLAY_ENERGY_COST and below PLAY_MIN_ENERGY the
  // pet won't play at all. Checked HERE (at the throw) rather than at the drop,
  // so a round the player was allowed to start always pays out — the server
  // applies the same gate when the reward message lands.
  if (!canPlayNow()) {
    const pet = clientState.activePet
    pushToast(pet ? `${pet.name} is too tired to play — it needs to sleep.` : 'Adopt a pet first!')
    return
  }
  const pt = Transform.getOrNull(engine.PlayerEntity)
  if (!pt) return
  const dir = flatForward(pt.rotation)
  triggerFetchHintFadeOut() // first-ever throw: fade the mobile "Hold to throw" hint out for good
  clientState.fetch.busy = true // block the Fetch button until the pet drops it
  // Masked AM_UPPER_BODY on desktop (Bevy) plays correctly, but on mobile
  // (Godot) the masked version blends/plays wrong — confirmed by comparing
  // masked vs unmasked side by side — so mobile gets it unmasked (full body).
  void triggerSceneEmote({ src: THROW_EMOTE, loop: false, mask: mobile() ? undefined : AvatarMask.AM_UPPER_BODY }).catch(() => {})

  let t = 0
  const fire = (dt: number): void => {
    t += dt
    if (t >= THROW_RELEASE_DELAY) {
      launchMeteor(dir, power)
      engine.removeSystem(fire)
    }
  }
  engine.addSystem(fire)
}

/** Actually spawns the meteorite and starts its flight, in the given (flat,
 *  normalized) direction, scaled by `power` (0..1, how long Throw was
 *  charged) — split out from beginThrow() so the spawn can be delayed to
 *  match the throw emote's release point. */
function launchMeteor(dir: Vector3, power: number): void {
  if (flight) return
  const pt = Transform.getOrNull(engine.PlayerEntity)
  if (!pt) return
  const distance = lerp(MIN_THROW_DISTANCE, MAX_THROW_DISTANCE, power)
  const arcHeight = lerp(MIN_ARC_HEIGHT, MAX_ARC_HEIGHT, power)
  const flightTime = lerp(MIN_FLIGHT_TIME, MAX_FLIGHT_TIME, power)
  const right = flatRight(pt.rotation)
  const from = Vector3.create(
    pt.position.x + dir.x * HAND_FORWARD_OFFSET + right.x * HAND_RIGHT_OFFSET,
    pt.position.y + HAND_HEIGHT,
    pt.position.z + dir.z * HAND_FORWARD_OFFSET + right.z * HAND_RIGHT_OFFSET
  )
  const to = Vector3.create(pt.position.x + dir.x * distance, C.PET_BASE_Y + GROUND_REST_Y, pt.position.z + dir.z * distance)

  const entity = engine.addEntity()
  Transform.createOrReplace(entity, { position: from, scale: Vector3.scale(Vector3.One(), SCALE) })
  applyBallShape(entity)
  flight = {
    entity,
    from,
    to,
    t: 0,
    phase: 'fly',
    spin: 0,
    flightTime,
    arcHeight,
    dir,
    bounceIndex: 0,
    bounceHeight: lerp(MIN_FIRST_BOUNCE_HEIGHT, MAX_FIRST_BOUNCE_HEIGHT, power),
    bounceForward: lerp(MIN_FIRST_BOUNCE_FORWARD, MAX_FIRST_BOUNCE_FORWARD, power),
    bounceDuration: lerp(MIN_FIRST_BOUNCE_DURATION, MAX_FIRST_BOUNCE_DURATION, power)
  }
}

/** Forward from a rotation, flattened to the ground plane and normalized. */
export function flatForward(rotation: Quaternion): Vector3 {
  const fwd = Vector3.rotate(Vector3.create(0, 0, 1), rotation)
  return Vector3.normalize(Vector3.create(fwd.x, 0, fwd.z))
}

/** Right from a rotation, flattened to the ground plane and normalized. */
export function flatRight(rotation: Quaternion): Vector3 {
  const r = Vector3.rotate(Vector3.create(1, 0, 0), rotation)
  return Vector3.normalize(Vector3.create(r.x, 0, r.z))
}

/** World position for a carry offset relative to a pet's (position, rotation)
 *  — deliberately NOT scaled by the pet's own render scale (Junior/Teenager/
 *  Adult, species multiplier): the ball is a fixed real-world size held near
 *  the mouth, not something that grows with the pet. */
function carryWorldPos(petTransform: { position: Vector3; rotation: Quaternion }, off: CarryOffset): Vector3 {
  const flat = flatForward(petTransform.rotation)
  const right = flatRight(petTransform.rotation)
  return Vector3.create(
    petTransform.position.x + flat.x * off.forward + right.x * off.right,
    petTransform.position.y + off.height,
    petTransform.position.z + flat.z * off.forward + right.z * off.right
  )
}

/** Position the carried meteorite at the pet's "mouth" (in front + up a bit). */
function carryPose(pet: Entity, species: string): Vector3 {
  const t = Transform.get(pet)
  const state: AnimState = getLogicalClip(pet) === 'idle' ? 'idle' : 'walk'
  return carryWorldPos(t, carryOffsetForSpecies(species, state))
}

/** Pet reached the player: drop the ball on the floor, grant the play reward,
 *  and re-enable the Fetch button. The ball lingers a moment, then disappears. */
function dropFetch(): void {
  if (!flight) return
  const pet = getLocalPet()
  const at = pet ? Transform.get(pet).position : flight.to
  Transform.getMutable(flight.entity).position = Vector3.create(at.x, C.PET_BASE_Y + GROUND_REST_Y, at.z)
  flight.phase = 'dropped'
  flight.t = 0
  clientState.fetch.busy = false // ready to throw again
  // +happiness / -energy plus the XP + coin payout (optimistic; the server
  // recomputes and the snapshot corrects). Only tell the server if the local
  // gate let it through — it applies the same rules and would just refuse.
  if (!applyCareLocal('play', false)) return
  actions.care('play', false)
  // That fetch may have been the one that emptied the tank: say so once here
  // rather than letting the player discover it by tapping a dead button.
  if (!canPlayNow()) {
    const active = clientState.activePet
    pushToast(`${active ? active.name : 'Your pet'} is worn out — time for bed.`)
  }
}

function flightSystem(dt: number): void {
  if (!flight) return
  flight.t += dt

  if (flight.phase === 'fly') {
    flight.spin += SPIN_SPEED * dt
    const u = Math.min(1, flight.t / flight.flightTime)
    const p = Vector3.lerp(flight.from, flight.to, u)
    p.y += 4 * flight.arcHeight * u * (1 - u) // parabolic arc: 0 at ends, peak at u=0.5
    const t = Transform.getMutable(flight.entity)
    t.position = p
    t.rotation = Quaternion.fromEulerDegrees(flight.spin, flight.spin * 0.6, 0)
    if (u >= 1) {
      // Primary arc landed — start decaying forward bounces from here instead
      // of stopping dead (see BOUNCE_COUNT).
      flight.phase = 'bounce'
      flight.t = 0
      flight.from = flight.to
      flight.to = Vector3.create(flight.to.x + flight.dir.x * flight.bounceForward, flight.to.y, flight.to.z + flight.dir.z * flight.bounceForward)
    }
  } else if (flight.phase === 'bounce') {
    flight.spin += SPIN_SPEED * dt // keep "rolling" through the bounces
    const u = Math.min(1, flight.t / flight.bounceDuration)
    const p = Vector3.lerp(flight.from, flight.to, u)
    p.y += 4 * flight.bounceHeight * u * (1 - u)
    const t = Transform.getMutable(flight.entity)
    t.position = p
    t.rotation = Quaternion.fromEulerDegrees(flight.spin, flight.spin * 0.6, 0)
    if (u >= 1) {
      flight.bounceIndex++
      if (flight.bounceIndex >= BOUNCE_COUNT) {
        landed() // settled — send the pet to fetch it from here
      } else {
        // Set up the next, smaller bounce.
        flight.t = 0
        flight.bounceHeight *= BOUNCE_DECAY
        flight.bounceForward *= BOUNCE_DECAY
        flight.bounceDuration *= BOUNCE_DECAY
        flight.from = flight.to
        flight.to = Vector3.create(flight.to.x + flight.dir.x * flight.bounceForward, flight.to.y, flight.to.z + flight.dir.z * flight.bounceForward)
      }
    }
  } else if (flight.phase === 'carry') {
    const pet = getLocalPet()
    if (pet) Transform.getMutable(flight.entity).position = carryPose(pet, clientState.activePet?.species ?? '')
  } else if (flight.phase === 'dropped') {
    if (flight.t >= LINGER) {
      engine.removeEntity(flight.entity)
      flight = null
    }
  }
}

/** The meteorite touched down — send the pet to fetch it (or let it linger). */
function landed(): void {
  if (!flight) return
  const pet = getLocalPet()
  if (!pet) {
    // No pet to fetch it — leave it a moment, then remove it and free the button.
    flight.phase = 'wait'
    let t = 0
    const gone = (dt: number): void => {
      t += dt
      if (t >= LINGER) {
        if (flight) {
          engine.removeEntity(flight.entity)
          flight = null
        }
        clientState.fetch.busy = false
        engine.removeSystem(gone)
      }
    }
    engine.addSystem(gone)
    return
  }
  flight.phase = 'wait'
  const landingPos = flight.to
  // Leg 1: run to the meteorite and "grab" it (eat clip on arrival).
  sendPetTo(
    landingPos,
    () => {
      if (!flight) return
      flight.phase = 'carry'
      // Leg 2: carry it back to where the player is now, then drop it on the floor.
      const player = Transform.getOrNull(engine.PlayerEntity)
      const home = player ? Vector3.create(player.position.x, C.PET_BASE_Y, player.position.z) : landingPos
      sendPetTo(home, () => dropFetch(), 'gesture-positive')
    },
    'eat'
  )
}

/** Keeps a meteorite visibly in the player's right hand for the whole time
 *  Fetch mode is open and no ball is currently in flight/being fetched —
 *  same AvatarAttach(AAPT_RIGHT_HAND) approach pet.ts uses for the carried
 *  egg. `handAnchor` stays alive for the Fetch session; `handBall` (the
 *  visible model) comes and goes each throw. */
function carryBallSystem(): void {
  const wantAnchor = clientState.fetch.active
  if (wantAnchor && !handAnchor) {
    handAnchor = engine.addEntity()
    Transform.createOrReplace(handAnchor, {})
    AvatarAttach.createOrReplace(handAnchor, { anchorPointId: AvatarAnchorPointType.AAPT_RIGHT_HAND })
  } else if (!wantAnchor && handAnchor) {
    if (handBall) {
      engine.removeEntity(handBall)
      handBall = null
    }
    engine.removeEntity(handAnchor)
    handAnchor = null
  }

  const wantBall = wantAnchor && !flight
  if (wantBall && !handBall && handAnchor) {
    handBall = engine.addEntity()
    Transform.createOrReplace(handBall, {
      parent: handAnchor,
      position: Vector3.create(HAND_BALL_X, HAND_BALL_Y, HAND_BALL_Z),
      scale: Vector3.scale(Vector3.One(), SCALE)
    })
    applyBallShape(handBall)
  } else if (!wantBall && handBall) {
    engine.removeEntity(handBall)
    handBall = null
  }
}

// Whether the native Throw button is currently shown. Tracked so we only
// touch TouchScreenControls when something actually changed, not every
// frame. Reading the button itself is unconditional (isTriggered on a
// TouchScreenControls action is a no-op on desktop, per the SDK's own docs,
// but the underlying InputAction still works from the keyboard — E doubles
// as a desktop shortcut for the same charge/release).
let touchButtonShown = false

function fetchTouchInputSystem(): void {
  const st = clientState.fetch
  if (st.active) {
    if (!touchButtonShown) {
      showFetchTouchButton(THROW_READY_ICON)
      touchButtonShown = true
    }
    if (inputSystem.isTriggered(FETCH_TOUCH_ACTION, PointerEventType.PET_DOWN)) startCharge()
    if (inputSystem.isTriggered(FETCH_TOUCH_ACTION, PointerEventType.PET_UP)) releaseCharge()
  } else if (touchButtonShown) {
    hideFetchTouchButton()
    touchButtonShown = false
  }
}

export function setupPlay(): void {
  engine.addSystem(flightSystem)
  engine.addSystem(carryBallSystem)
  engine.addSystem(chargeSystem)
  engine.addSystem(fetchTouchInputSystem)
}

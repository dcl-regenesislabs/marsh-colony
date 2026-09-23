// Floating PNG "emote" icon above EACH of the player's own pets — not just
// the active one — a single always-on readout of that pet's dominant status.
// Only one emote plays per pet at a time; see `dominantEmote` below for the
// full priority order (sleeping beats "just got love" beats the needs-based
// face/icon).
//
// Supersedes the 4-icon mood bar (pet.ts's makeTag(false) for owned pets) and
// the text speech bubble (speech.ts, left unwired rather than deleted — see
// setup.ts) as the pet's overhead status readout.
//
// "Just got treated/petted" (the heart) is inferred rather than tracked by
// real game data — see updateHeartTriggers below. It, and the fruit-catch
// happy flash, only apply to the ACTIVE pet — those are reactions to
// interactions (petting, treats, the Feed minigame) that only ever happen to
// whichever pet is out and active.

import { engine, Entity, Transform, Billboard, MeshRenderer, Material, VisibilityComponent } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import * as C from '../shared/config'
import type { PetData, StatKey } from '../shared/types'
import { clientState } from './state'
import { getLocalPet, getInactivePetEntity, petIsPresent, TAG_MIN, TAG_SIZE_MULT } from './pet'
import { petOverheadTuning } from './petOverheadCalibration'

type EmoteId = 'food' | 'clean' | 'play' | 'sick' | 'happy' | 'sad' | 'angry' | 'heart' | 'music' | 'sleep1' | 'sleep2'

const EMOTE_SRC: Record<EmoteId, string> = {
  food: 'assets/images/emotes/emote_Food.png',
  clean: 'assets/images/emotes/emote_Clean.png',
  play: 'assets/images/emotes/emote_Play.png',
  sick: 'assets/images/emotes/emote_Sick.png',
  happy: 'assets/images/emotes/emote_faceHappy.png',
  sad: 'assets/images/emotes/emote_faceSad.png',
  angry: 'assets/images/emotes/emote_faceAngry.png',
  heart: 'assets/images/emotes/emote_heart.png',
  music: 'assets/images/emotes/emote_music.png',
  sleep1: 'assets/images/emotes/emote_sleep.png',
  sleep2: 'assets/images/emotes/emote_sleeps.png'
}

/** The single-need icon shown when exactly one stat is low. Energy reuses the
 *  static sleep frame — there's no separate "tired but awake" art yet. */
const NEED_TO_EMOTE: Record<StatKey, EmoteId> = {
  hunger: 'food',
  hygiene: 'clean',
  energy: 'sleep1',
  happiness: 'play'
}
const NEEDS: StatKey[] = ['hunger', 'hygiene', 'energy', 'happiness']

const EMOTE_SIZE = 0.5 // plane width/height in world metres
/** Extra clearance above the name tag + mood icon row so this doesn't overlap them. */
const EMOTE_EXTRA_LIFT = 0.65

/** How long the heart shows after a petting session ends or a treat lands. */
const HEART_HOLD_S = 5
/** How long the happy "nice catch" flash holds during the fruit-catch minigame. */
const CATCH_HAPPY_HOLD_S = 0.5
/** How long each frame of the sleeping animation holds before swapping. */
const SLEEP_FRAME_S = 0.6
const CYCLE_STEP_S = 1.2

/** Per-pet emote billboard + its own animation/cycle state, so two pets
 *  sleeping or nagging at once don't share a single timer. */
type EmoteState = {
  entity: Entity
  currentSrc: string
  visible: boolean
  sleepFrameT: number
  sleepFrameToggle: boolean
  cycleKey: string
  cycleT: number
  cycleIndex: number
}

const emotes = new Map<string, EmoteState>()

// Unlit (Basic), same as speech.ts's bubble — a PBR material with a full-white
// emissive layer (the previous approach) self-illuminates the icon, which reads
// as a glow/shine on top of the art, worse on mobile's bloom. Unlit sidesteps
// lighting entirely instead of fighting it with emissive.
function makeMaterial(src: string): Parameters<typeof Material.setBasicMaterial>[1] {
  return {
    texture: Material.Texture.Common({ src }),
    alphaTexture: Material.Texture.Common({ src }),
    // Unity blends pixels that pass a partial alpha mask. Keep only fully
    // opaque icon pixels so the mood bubble matches the solid mobile render.
    alphaTest: 1
  }
}

function ensureEmoteState(petId: string): EmoteState {
  let st = emotes.get(petId)
  if (st) return st
  const entity = engine.addEntity()
  Transform.create(entity, { position: Vector3.create(0, -100, 0), scale: Vector3.create(EMOTE_SIZE, EMOTE_SIZE, 1) })
  Billboard.create(entity, {}) // full billboard, same as the name tag (makeTag) it sits above
  MeshRenderer.setPlane(entity)
  Material.setBasicMaterial(entity, makeMaterial(EMOTE_SRC.happy))
  // Starts hidden (visible: false, matching the created VisibilityComponent
  // below) — the first real update() call decides the true state.
  VisibilityComponent.create(entity, { visible: false })
  st = { entity, currentSrc: EMOTE_SRC.happy, visible: false, sleepFrameT: 0, sleepFrameToggle: false, cycleKey: '', cycleT: 0, cycleIndex: 0 }
  emotes.set(petId, st)
  return st
}

function setTexture(st: EmoteState, src: string): void {
  if (src === st.currentSrc) return
  st.currentSrc = src
  Material.setBasicMaterial(st.entity, makeMaterial(src))
}

// ---------------------------------------------------------------------------
// "Just got love" detection (ACTIVE pet only) — tied to the actual pet
// actions, not a happiness delta (that also fires from Play and premium food,
// which is why the heart used to show almost constantly):
//   - self-petting: edge-detect clientState.petting.celebrationUntil going
//     0 -> nonzero, which ONLY completePetting() ever does (pet.ts) — the
//     moment the gesture actually finishes. NOT petting.active going true ->
//     false: cancelPetting() also flips that on the BACK button and on the
//     pet-vanishing bail-out, neither of which completed anything, and both
//     reset celebrationUntil back to 0 without ever having set it.
//   - treated by another player: clientState.lastTreatedAt, set from the
//     server's 'treated' notify (see server/state.ts petOther + setup.ts's
//     'notify' handler) — a real signal, not a guess.
// ---------------------------------------------------------------------------
let heartUntil = 0
let wasCelebrating = false
let lastSeenTreatedAt = 0

function updateHeartTriggers(now: number): void {
  const celebrating = clientState.petting.celebrationUntil > 0
  if (celebrating && !wasCelebrating) heartUntil = now + HEART_HOLD_S * 1000
  wasCelebrating = celebrating

  if (clientState.lastTreatedAt !== lastSeenTreatedAt) {
    lastSeenTreatedAt = clientState.lastTreatedAt
    if (lastSeenTreatedAt > 0) heartUntil = now + HEART_HOLD_S * 1000
  }
}

// ---------------------------------------------------------------------------
// Fruit-catch reaction (ACTIVE pet only) — a brief happy flash each time a
// fruit is caught during the Feed minigame (clientState.feedGame.caught
// increments once per catch — see fruitGame.ts), instead of sitting on the
// music note the whole time.
// ---------------------------------------------------------------------------
let lastSeenCaught = -1
let catchHappyUntil = 0

function updateCatchTrigger(now: number): void {
  if (!clientState.feedGame.active) {
    lastSeenCaught = -1
    return
  }
  const caught = clientState.feedGame.caught
  if (lastSeenCaught >= 0 && caught > lastSeenCaught) catchHappyUntil = now + CATCH_HAPPY_HOLD_S * 1000
  lastSeenCaught = caught
}

/** Alternate the two sleep frames while a pet is sleeping. */
function sleepingEmote(st: EmoteState, dt: number): EmoteId {
  st.sleepFrameT += dt
  if (st.sleepFrameT >= SLEEP_FRAME_S) {
    st.sleepFrameT = 0
    st.sleepFrameToggle = !st.sleepFrameToggle
  }
  return st.sleepFrameToggle ? 'sleep2' : 'sleep1'
}

/** With 2+ needs low, alternate the mood face with each of those needs' own
 *  icon (face, need A, face, need B, ...) instead of sitting on a static face,
 *  so it reads like the pet listing what's wrong. */
function cycledMoodEmote(st: EmoteState, face: EmoteId, lowNeeds: StatKey[], dt: number): EmoteId {
  const key = face + ':' + lowNeeds.join(',')
  if (key !== st.cycleKey) {
    st.cycleKey = key
    st.cycleIndex = 0
    st.cycleT = 0
  }
  const seq: EmoteId[] = []
  for (const k of lowNeeds) {
    seq.push(face)
    seq.push(NEED_TO_EMOTE[k])
  }
  st.cycleT += dt
  if (st.cycleT >= CYCLE_STEP_S) {
    st.cycleT = 0
    st.cycleIndex = (st.cycleIndex + 1) % seq.length
  }
  return seq[st.cycleIndex]
}

/**
 * What a pet shows right now, highest priority first:
 *  1. sleeping — animated between the two sleep frames (checked first: energy
 *               is expected to be near-bottom right when sleep starts, which
 *               would otherwise read as a needs-based icon every time)
 *  2. (active pet only) playing the fruit-catch minigame — music note, with a
 *     brief happy flash on each catch (see updateCatchTrigger above)
 *  3. (active pet only) just got love (see updateHeartTriggers above) — heart
 *  4. needs-based face/icon: 0 low = happy, 1 low = that need's icon alone,
 *     2+ low = the mood face (sad at 2, angry at 3+) cycling with each low
 *     need's icon in turn (see cycledMoodEmote above)
 *
 * "sick" has no priority step here — there's no sickness mechanic in the game
 * yet (see #148), so nothing should ever show it. EMOTE_SRC.sick is kept for
 * when that feature lands and this gets a real branch.
 */
function dominantEmote(st: EmoteState, pet: PetData, now: number, dt: number, isActive: boolean): EmoteId {
  if (pet.sleeping) return sleepingEmote(st, dt)
  if (isActive) {
    if (clientState.feedGame.active) return now < catchHappyUntil ? 'happy' : 'music'
    if (now < heartUntil) return 'heart'
  }

  const lowNeeds = NEEDS.filter((k) => pet[k] <= C.PET_SPEECH_NEED_THRESHOLD)
  if (lowNeeds.length === 0) return 'happy'
  if (lowNeeds.length === 1) return NEED_TO_EMOTE[lowNeeds[0]]
  const face: EmoteId = lowNeeds.length === 2 ? 'sad' : 'angry'
  return cycledMoodEmote(st, face, lowNeeds, dt)
}

/** Moments a cinematic/overlay already owns the ACTIVE pet's head — keep its
 *  emote off screen. Doesn't apply to roaming/inactive pets, which are never
 *  involved in these. Deliberately NOT using pet.ts's isBusy(): that also
 *  covers mode === 'asleep', and sleeping is exactly the state the active
 *  pet's emote needs to stay visible for (to show the sleep-frame cycle),
 *  not hide during. */
function activePetMomentIsTaken(): boolean {
  return clientState.hatch.active || clientState.carryEgg.active || clientState.carryPet.active || clientState.breed.active || clientState.petting.active || clientState.fetch.active || clientState.dialog.open
}

function update(dt: number): void {
  const now = Date.now()
  // Tracked unconditionally (not just while visible) so an edge — petting
  // finishing, a treat landing — isn't missed while an overlay is hiding
  // the active pet's emote.
  updateHeartTriggers(now)
  updateCatchTrigger(now)

  const player = clientState.player
  const activeId = clientState.activePet?.id
  const rosterIds = new Set<string>()

  if (player) {
    for (const pet of player.pets) {
      rosterIds.add(pet.id)
      const isActive = pet.id === activeId
      const petEntity = isActive ? getLocalPet() : getInactivePetEntity(pet.id)
      const hidden = petEntity === null || (isActive && (!petIsPresent() || activePetMomentIsTaken()))

      const st = ensureEmoteState(pet.id)
      if (hidden || petEntity === null) {
        if (st.visible) {
          st.visible = false
          VisibilityComponent.getMutable(st.entity).visible = false
        }
        continue
      }

      if (!st.visible) {
        st.visible = true
        VisibilityComponent.getMutable(st.entity).visible = true
      }
      setTexture(st, EMOTE_SRC[dominantEmote(st, pet, now, dt, isActive)])

      const pos = Transform.get(petEntity).position
      const tune = petOverheadTuning(pet.species, pet.size)
      const y = pos.y + TAG_MIN + TAG_SIZE_MULT * C.stageScaleFor(pet.size) + tune.nameLift + EMOTE_EXTRA_LIFT
      Transform.getMutable(st.entity).position = Vector3.create(pos.x, y, pos.z)
    }
  }

  // A pet that left the roster (swapped/discarded) loses its emote entity for good.
  for (const [id, st] of emotes) {
    if (!rosterIds.has(id)) {
      engine.removeEntity(st.entity)
      emotes.delete(id)
    }
  }
}

export function setupPetEmotes(): void {
  engine.addSystem(update)
}

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
// The Caretaker is the only voice that teaches, always through the normal
// dialog (tagged "Chapter x/6"). Each objective is said once when the screen is
// free; after the dialog it stays on screen as a sticky toast until it is done
// (FirstSessionTask in ui.tsx), and throbs if the player sits on it. No new guide
// arrows: the player finds things; only the right button pulses.

import {
  engine,
  Transform,
  GltfContainer,
  MeshCollider,
  VisibilityComponent,
  ColliderLayer,
  pointerEventsSystem,
  InputAction,
  type Entity
} from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { clientState, actions } from './state'
import { PLAY_MIN_ENERGY } from '../shared/config'
import { getEggPending, setFirstSessionBreedPartner } from './pet'
import { EntityNames } from '../../assets/scene/entity-names'
import { dailyClaimable } from './sim'
import { slotPrice, petStage, firstSessionPartnerSpecies, speciesLabel } from '../shared/config'
import { openDialog } from './state'
import { mobile } from './ui/theme'
import { petTouchControlsAreVisible } from './touchControls'
import { trackEvent } from '../shared/analytics'
import { DEBUG_FORCE_FIRST_SESSION } from '../shared/config'

export function firstSessionActive(): boolean {
  return clientState.firstSession && step !== 'done'
}

// ---------------------------------------------------------------------------
// Steps. Client-only and never saved: they just follow what the player does.
// ---------------------------------------------------------------------------
export type FirstSessionStep =
  | 'intro' // Caretaker intro → adopt → carry the egg → hatch → keep (existing flow)
  | 'meet' // breathing beat: the pet greets you, nothing asked
  | 'feed' // "Feed your pet": tap it, choose Feed
  | 'feeding' // the Feed errand / minigame owns the screen; the first round ends with poison
  | 'sick' // sickness arc: Caretaker, Care Center, Pepito, rock throw, cure (existing flows guide it)
  | 'cured' // breathing beat: the cured pet dances (cureCelebration), nothing asked
  | 'bath' // chapter 3 starts: the chase left it muddy
  | 'play' // fetch until it is worn out (the server tires it if the player stalls)
  | 'rest' // let it sleep on the bed
  | 'slot' // chapter 4: while it naps, unlock slot 2 in My Pets
  | 'adopt2' // go to the Caretaker and adopt a second egg
  | 'hatch2' // collect the egg, carry it home, hatch, keep (existing flows guide it)
  | 'freeTime' // ~30 s to enjoy the new pet (the meteor gets a mention if it is down)
  | 'switch' // chapter 5: back to pet 1 in My Pets
  | 'grow' // the Caretaker's gift: find the mushroom in the woods, it grows pet 1 to Adult
  | 'nest' // the Caretaker's breeding lesson: his pet now waits in the nest's bowl B
  | 'slot3' // the baby needs room: unlock slot 3
  | 'breed' // tap pet 1, choose Breed, carry it to the nest (existing errand)
  | 'breeding' // the breed errand / cinematic owns the screen
  | 'hatch3' // carry the hybrid egg home, hatch, keep (existing flows)
  | 'wrapup' // chapter 6: the Caretaker's closing words
  | 'done' // the rest of the visit is the normal game

/** Chapter shown on the bar ("Chapter 1/6"), per step. */
const CHAPTER: Record<FirstSessionStep, number> = {
  intro: 1,
  meet: 1,
  feed: 2,
  feeding: 2,
  sick: 2,
  cured: 2,
  bath: 3,
  play: 3,
  rest: 3,
  slot: 4,
  adopt2: 4,
  hatch2: 4,
  freeTime: 4,
  switch: 5,
  grow: 5,
  nest: 5,
  slot3: 5,
  breed: 5,
  breeding: 5,
  hatch3: 5,
  wrapup: 6,
  done: 6
}
export const FIRST_SESSION_CHAPTERS = 6

/** What the Caretaker asks for while the step is waiting on the player. */
const OBJECTIVE: Partial<Record<FirstSessionStep, string>> = {
  feed: 'Your pet is hungry! {tap} and choose Feed.',
  bath: "It's covered in mud from the chase! {tap} and choose Bath.",
  play: "It's feeling better. Let's play! {tap} and choose Play.",
  rest: "It's worn out. Let it rest on the bed. {tap} and choose Sleep.",
  adopt2: 'Your new slot is ready. Come see me and adopt a second egg!',
  switch: 'Open My Pets and pick your first pet again. I have something for it!',
  grow: 'Find the mushroom in the woods and tap it. Your pet will grow up!',
  breed: '{tap} and choose Breed, then carry it to the breeding nest in the house.'
}

const GROW_DIALOG = [
  "Since it's your first time, I've granted you a Grow Potion.",
  'Go find a mushroom in the woods. One bite and your pet will be all grown up!'
]

const CLOSING_DIALOG = [
  'Look at that: your very first hybrid!',
  'Babies need lots of care to grow up. Feed it, bathe it and play with it.',
  "Next time you won't need my pet. Raise your two to Adult and breed them yourselves.",
  'Come back tomorrow: your daily streak reward will be waiting!'
]

/** Objectives whose wording depends on the moment. */
function objectiveFor(s: FirstSessionStep): string {
  const p = clientState.player
  if ((s === 'slot' || s === 'slot3') && p) {
    const price = slotPrice(p.petSlots)
    return p.currency >= price
      ? s === 'slot3'
        ? 'Open My Pets and unlock one more slot for the baby.'
        : 'While it naps, open My Pets and unlock a new slot.'
      : `A new slot costs ${price} coins. Yours are piling up while your pet is happy!`
  }
  if (s === 'grow' && !growIntroDone) return '' // the Caretaker speaks first
  if (s === 'breed' && clientState.activePet?.sleeping) return withTap("It's still asleep. {tap} and wake it up.")
  if (s === 'freeTime') {
    return dailyClaimable() ? 'A meteor fell nearby! Go take a look while they get to know each other.' : ''
  }
  return withTap(OBJECTIVE[s] ?? '')
}

/** How the pet's actions open on this device: the native Pet Actions button on
 *  mobile (pointed at by a bubble, see PetActionsHint in ui.tsx), the pet itself
 *  on desktop. */
function withTap(line: string): string {
  return line.replace('{tap}', mobile() ? 'Tap Pet Actions' : 'Click your pet')
}

/** Free time with the new pet before the Caretaker calls you back. */
const FREE_TIME_SECONDS = 30

/** The pet-panel button each step asks for (arrow to the pet, then this pulses). */
export type FirstSessionPulse = 'feed' | 'bath' | 'play' | 'sleep' | 'breed' | 'myPets'
const BUTTON: Partial<Record<FirstSessionStep, FirstSessionPulse>> = {
  feed: 'feed',
  bath: 'bath',
  play: 'play',
  rest: 'sleep',
  slot: 'myPets',
  switch: 'myPets',
  slot3: 'myPets',
  breed: 'breed'
}


// ---------------------------------------------------------------------------
// The grow mushroom ("Gypsy mushroom", placed in Creator Hub). It only exists for a
// first-session player on the 'grow' step: everyone else never sees it, so the
// scene is unchanged for returning players.
// ---------------------------------------------------------------------------
let growIntroDone = false
let mushroom: Entity | null = null
let mushroomShown: boolean | null = null
let mushroomEaten = false
/** Seconds into the eaten pop, or -1 when not popping. */
let mushroomPop = -1
let mushroomScale = Vector3.One()
const MUSHROOM_POP_S = 0.7
/** The model is small (~0.5 m): an invisible box makes it easy to tap... */
const MUSHROOM_HIT_SIZE = 1.6
/** ...and walking right up to it picks it too, so nobody gets stuck. */
const MUSHROOM_PICK_REACH = 1.8
let mushroomHit: Entity | null = null

function findMushroom(): Entity | null {
  if (mushroom !== null) return mushroom
  const e = engine.getEntityOrNullByName(EntityNames.Gypsy_mushroom)
  if (e === null || !Transform.has(e) || !GltfContainer.has(e)) return null
  mushroom = e
  mushroomScale = Vector3.clone(Transform.get(e).scale)
  // Click target: an invisible box around the mushroom (pointer layer only, so
  // it never blocks walking). Its collider is switched off while hidden.
  const pos = Transform.get(e).position
  const hit = engine.addEntity()
  Transform.create(hit, {
    position: Vector3.create(pos.x, pos.y + MUSHROOM_HIT_SIZE / 2, pos.z),
    scale: Vector3.create(MUSHROOM_HIT_SIZE, MUSHROOM_HIT_SIZE, MUSHROOM_HIT_SIZE)
  })
  MeshCollider.setBox(hit, ColliderLayer.CL_NONE)
  pointerEventsSystem.onPointerDown(
    { entity: hit, opts: { button: InputAction.IA_POINTER, hoverText: 'Pick the mushroom', maxDistance: 16 } },
    () => eatMushroom()
  )
  mushroomHit = hit
  return e
}

function eatMushroom(): void {
  if (step !== 'grow' || mushroomEaten || clientState.dialog.open) return
  const pet = clientState.activePet
  if (!pet || pet.id !== firstPetId) {
    say(['That mushroom is for your first pet. Pick it in My Pets first!'])
    return
  }
  mushroomEaten = true
  mushroomPop = 0
  actions.firstSessionGrow(pet.id) // the server grows it; the snapshot brings the new size
}

/** Show or hide the mushroom (visuals AND colliders) and run its pop. */
function updateMushroom(dt: number): void {
  const e = findMushroom()
  if (e === null) return
  if (mushroomPop >= 0) {
    mushroomPop += dt
    const p = Math.min(1, mushroomPop / MUSHROOM_POP_S)
    // A quick swell, then it shrinks away.
    const k = p < 0.3 ? 1 + (p / 0.3) * 0.35 : 1.35 * (1 - (p - 0.3) / 0.7)
    Transform.getMutable(e).scale = Vector3.scale(mushroomScale, Math.max(0, k))
    if (p >= 1) mushroomPop = -1
    else return
  }
  const want = firstSessionActive() && step === 'grow' && !mushroomEaten
  if (want && growIntroDone && playerDistanceTo(Transform.get(e).position) <= MUSHROOM_PICK_REACH) eatMushroom()
  if (want === mushroomShown) return
  mushroomShown = want
  VisibilityComponent.createOrReplace(e, { visible: want })
  const g = GltfContainer.getMutable(e)
  g.visibleMeshesCollisionMask = want ? ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE
  g.invisibleMeshesCollisionMask = want ? ColliderLayer.CL_PHYSICS | ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE
  if (want) Transform.getMutable(e).scale = Vector3.clone(mushroomScale)
  if (mushroomHit !== null) MeshCollider.setBox(mushroomHit, want ? ColliderLayer.CL_POINTER : ColliderLayer.CL_NONE)
}

/** Pet 1, the one adopted at the start: chapter 5 grows and breeds it. */
let firstPetId = ''

function playerDistanceTo(target: { x: number; z: number }): number {
  if (!Transform.has(engine.PlayerEntity)) return Infinity
  const pp = Transform.get(engine.PlayerEntity).position
  return Math.hypot(pp.x - target.x, pp.z - target.z)
}

function hasFreeSlot(): boolean {
  const p = clientState.player
  return !!p && p.pets.length < p.petSlots
}

/** Seconds in 'play' without a single fetch before the server tires the pet anyway. */
const PLAY_FALLBACK_SECONDS = 120

/** Breathing room after a reward before the next instruction shows up. */
const BREATHE_SECONDS = 10

// Counted from when the Caretaker said the objective (dialog closed, not in Fetch).
/** If the player sits on the objective this long, its toast throbs once. */
const NUDGE_REPEAT_SECONDS = 50

// ---------------------------------------------------------------------------
// State read by the UI
// ---------------------------------------------------------------------------
export const firstSessionHud = {
  chapter: 1,
  /** The sticky objective toast: what to do now, '' when nothing is asked.
   *  It appears once the Caretaker's dialog is closed and stays until done. */
  task: '',
  /** Mobile: point a bubble at the native Pet Actions button. */
  pointPetActions: false,
  /** Bumped when the player sits on it: the toast throbs for a moment. */
  nudgedAt: 0,
  /** Button to pulse for the current objective, if any. */
  pulse: null as FirstSessionPulse | null
}

let step: FirstSessionStep = 'intro'
/** The first Feed round's forced poison has been handed out (once per visit). */
let poisonTaken = false
/** Seconds the Feed flow has been over while still in 'feeding'. */
let feedOverFor = 0

/** First session only, once: the Feed round being submitted must end with the
 *  pet poisoned (fruitGame.ts). Returns false for everyone else. */
export function takeFirstSessionPoison(): boolean {
  if (!firstSessionActive() || poisonTaken) return false
  poisonTaken = true
  return true
}
/** Counter values when the current step started, to spot the new action. */
let bathsAtStart = 0
let playsAtStart = 0
/** Seconds spent in 'play'; and whether the tire fallback was already asked for. */
let playTime = 0
/** Seconds of free time left. */
let freeLeft = 0
let tireAsked = false
let breatheLeft = 0
let objectiveTime = 0
let repeated = false

/** Steps where the third creature must come from breeding, not adoption. */
const BREED_ONLY: Partial<Record<FirstSessionStep, boolean>> = {
  freeTime: true,
  switch: true,
  grow: true,
  nest: true,
  slot3: true,
  breed: true,
  breeding: true,
  hatch3: true
}

/** First session, after the second pet: adopting is closed so the third
 *  creature comes from breeding. Opening Adopt gets a Caretaker line instead. */
export function firstSessionAdoptLocked(): boolean {
  if (!firstSessionActive() || !BREED_ONLY[step]) return false
  say(["Not another egg this time! Your next creature will be born from breeding. Let's get your first pet ready for it."])
  return true
}

export function firstSessionStep(): FirstSessionStep {
  return step
}

function goTo(next: FirstSessionStep, breathe = 0): void {
  step = next
  breatheLeft = breathe
  said = ''
  resetNudges()
  const c = clientState.player?.counters ?? {}
  bathsAtStart = c['bathCount'] ?? 0
  playsAtStart = c['playCount'] ?? 0
  playTime = 0
  console.log('[FirstSession] step ->', next)
  reportStep(next)
}

/** Every step reached goes to PostHog, so the funnel shows how far first
 *  visits get. Forced debug sessions stay out of the stats. */
let sessionClock = 0
let stepIndex = 0
function reportStep(next: FirstSessionStep): void {
  stepIndex += 1
  if (DEBUG_FORCE_FIRST_SESSION) return
  trackEvent('first_session_step', clientState.player?.address ?? '', {
    step: next,
    step_index: stepIndex,
    chapter: CHAPTER[next],
    seconds_in_session: Math.round(sessionClock)
  })
}

/** Any progress on the objective restarts the nudge ladder. */
function resetNudges(): void {
  objectiveTime = 0
  repeated = false
}

// ---------------------------------------------------------------------------
// Step transitions — each one watches the real game state, nothing is faked.
// ---------------------------------------------------------------------------
function advance(dt: number): void {
  const p = clientState.player
  switch (step) {
    case 'intro':
      // The first pet has been kept: it is in the roster and nothing is pending.
      if (p && p.pets.length > 0 && !p.hatchling && clientState.activePet && !clientState.hatch.active) {
        firstPetId = clientState.activePet.id
        goTo('meet', BREATHE_SECONDS)
      }
      return
    case 'meet':
      if (breatheLeft <= 0) goTo('feed')
      return
    case 'feed':
      if (clientState.feedTask.active || clientState.feedGame.active) goTo('feeding')
      return
    case 'feeding': {
      if (clientState.activePet?.sick) {
        goTo('sick')
        return
      }
      // The round is over but no sickness came back (e.g. nothing caught, so
      // nothing was eaten): don't strand the player, move on to chapter 3.
      const feedOver = !clientState.feedTask.active && !clientState.feedGame.active
      feedOverFor = feedOver ? feedOverFor + dt : 0
      if (feedOver && feedOverFor > 3 && !clientState.sicknessErrand.active) goTo('bath', BREATHE_SECONDS)
      return
    }
    case 'sick':
      // Cured: the server cleared the flag (the dance and the gift come with it).
      if (clientState.activePet && !clientState.activePet.sick && !clientState.sicknessErrand.active && !clientState.dialog.open) {
        goTo('cured', BREATHE_SECONDS)
      }
      return
    case 'cured':
      if (breatheLeft <= 0) goTo('bath')
      return
    case 'bath':
      if ((p?.counters['bathCount'] ?? 0) > bathsAtStart) goTo('play', 6)
      return
    case 'play': {
      const pet = clientState.activePet
      if (pet && pet.energy < PLAY_MIN_ENERGY) {
        goTo('rest')
        return
      }
      if (breatheLeft <= 0) playTime += dt
      const rounds = (p?.counters['playCount'] ?? 0) - playsAtStart
      // One fetch is enough: when the player leaves Fetch (or stalls), the
      // server wears the pet out once and the step above moves on to 'rest'.
      if (!tireAsked && !clientState.fetch.active && (rounds >= 1 || playTime >= PLAY_FALLBACK_SECONDS)) {
        tireAsked = true
        actions.firstSessionTire()
      }
      return
    }
    case 'rest':
      if (clientState.activePet?.sleeping) goTo('slot', 3) // short: the nap itself is the pause
      return
    case 'slot':
      if (p && p.pets.length < p.petSlots) goTo('adopt2')
      return
    case 'adopt2':
      // Adopt! confirmed: the existing pickup/carry/hatch flows take it from here.
      if (getEggPending() || clientState.carryEgg.active || p?.hatchling) goTo('hatch2')
      return
    case 'hatch2': {
      if (!p) return
      const eggFlow = getEggPending() || clientState.carryEgg.active || clientState.hatch.active || !!p.hatchling
      if (eggFlow) return
      if (p.pets.length >= 2) {
        freeLeft = FREE_TIME_SECONDS
        goTo('freeTime', BREATHE_SECONDS)
      } else if (p.pets.length < p.petSlots) {
        goTo('adopt2') // cancelled or discarded: the slot is still free, adopt again
      }
      return
    }
    case 'freeTime':
      if (breatheLeft <= 0 && !clientState.fetch.active) freeLeft -= dt
      if (freeLeft <= 0) goTo('switch')
      return
    case 'switch':
      if (clientState.activePet && clientState.activePet.id === firstPetId) goTo('grow', 3)
      return
    case 'grow': {
      if (!growIntroDone && breatheLeft <= 0 && canInterrupt()) {
        growIntroDone = true
        say(GROW_DIALOG, "I'm on it!")
        return
      }
      const pet = clientState.activePet
      if (pet && pet.id === firstPetId && petStage(pet.size) === 'ADULT') {
        setFirstSessionBreedPartner(firstSessionPartnerSpecies(pet)) // already waiting in bowl B
        goTo('nest', 3)
      }
      return
    }
    case 'nest': {
      if (breatheLeft > 0 || !canInterrupt()) return
      const pet = clientState.activePet
      const partner = speciesLabel(firstSessionPartnerSpecies(pet ?? { species: '' }))
      const needSlot = !hasFreeSlot()
      say(
        [
          'Look how big it is! Now it is ready for the best part: breeding.',
          `In the house there is a breeding nest. My ${partner} is waiting in its second bowl: this time it will be your pet's partner.`,
          ...(needSlot ? ['The baby will need a home of its own, so unlock one more slot in My Pets first.'] : [])
        ],
        'Got it!'
      )
      goTo(needSlot ? 'slot3' : 'breed')
      return
    }
    case 'slot3':
      if (hasFreeSlot()) goTo('breed')
      return
    case 'breed':
      if (clientState.breed.active) goTo('breeding')
      return
    case 'breeding':
      if (clientState.breed.active) return
      if (clientState.carryEgg.active || p?.hatchling) {
        setFirstSessionBreedPartner(null) // the Caretaker takes his pet back
        goTo('hatch3')
      } else {
        goTo('breed') // BACK before breeding: try again
      }
      return
    case 'hatch3':
      if (getEggPending() || clientState.carryEgg.active || clientState.hatch.active || p?.hatchling) return
      goTo('wrapup', 4)
      return
    case 'wrapup':
      if (breatheLeft > 0 || !canInterrupt()) return
      say(CLOSING_DIALOG, 'Thanks!')
      goTo('done')
      return
    case 'done':
      return
  }
}

/** Nothing else owns the screen right now, so the Caretaker can speak. */
function canInterrupt(): boolean {
  const c = clientState
  return (
    !c.dialog.open &&
    !c.petPanelOpen &&
    !c.fetch.active &&
    !c.feedTask.active &&
    !c.feedGame.active &&
    !c.bathGame.active &&
    !c.carryEgg.active &&
    !c.carryPet.active &&
    !c.breed.active &&
    !c.hatch.active &&
    !c.pepitoChase.active &&
    !c.sicknessErrand.active
  )
}

/** The Caretaker speaks through the normal dialog, tagged with the chapter. */
function say(pages: string[], finalLabel = 'Got it!'): void {
  openDialog('Caretaker', pages, finalLabel)
  clientState.dialog.tag = `Chapter ${CHAPTER[step]}/${FIRST_SESSION_CHAPTERS}`
}

/** The objective line last said for this step ('' = not said yet). */
let said = ''

function firstSessionSystem(dt: number): void {
  updateMushroom(dt) // also hides it for everyone who is not on the 'grow' step
  if (!firstSessionActive()) {
    firstSessionHud.pulse = null
    firstSessionHud.task = ''
    firstSessionHud.pointPetActions = false
    return
  }
  if (stepIndex === 0 && clientState.player) reportStep('intro') // the visit starts
  sessionClock += dt
  if (breatheLeft > 0) breatheLeft -= dt
  advance(dt)

  const objective = breatheLeft > 0 ? '' : objectiveFor(step)
  // Every Caretaker dialog in the first session carries the chapter (intro, cure...).
  const d = clientState.dialog
  if (d.open && d.npcName === 'Caretaker' && !d.tag) d.tag = `Chapter ${CHAPTER[step]}/${FIRST_SESSION_CHAPTERS}`

  // The Caretaker says the objective in his dialog once it can be heard (and
  // again whenever its wording changes, e.g. enough coins now, or it woke up).
  if (objective && objective !== said && canInterrupt()) {
    said = objective
    objectiveTime = 0
    repeated = false
    say([objective])
  }
  const heard = !!objective && said === objective

  // Waiting on the player: if they sit on it, the sticky toast throbs once.
  const paused = clientState.dialog.open || clientState.fetch.active
  if (heard && !paused) objectiveTime += dt
  if (heard && !repeated && objectiveTime >= NUDGE_REPEAT_SECONDS) {
    repeated = true
    firstSessionHud.nudgedAt = Date.now() // the sticky toast throbs instead of another dialog
  }

  // Once the dialog is closed, the objective stays on screen until it is done.
  firstSessionHud.task = heard && !clientState.dialog.open ? objective : ''

  // No arrows: the player finds things. Only the right button pulses — the pet
  // panel's once it is open, My Pets right away.
  const button = heard ? BUTTON[step] : undefined
  firstSessionHud.chapter = CHAPTER[step]
  firstSessionHud.pulse = button && (button === 'myPets' || clientState.petPanelOpen) ? button : null
  // The step wants a pet action and its panel is still closed: on mobile, point
  // at the button that opens it (like Fetch's "Hold to throw" bubble).
  firstSessionHud.pointPetActions =
    !!button && button !== 'myPets' && mobile() && petTouchControlsAreVisible() && !clientState.petPanelOpen && !clientState.dialog.open
}

export function setupFirstSession(): void {
  engine.addSystem(firstSessionSystem, undefined, 'first-session')
}

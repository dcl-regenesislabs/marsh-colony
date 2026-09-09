// Central tuning + content tables. Everything tweakable lives here so the
// "tuning pass" in mvp.md never has to hunt through logic files.

import type { CareAction, Rarity, StatKey } from './types'

export const DAY_MS = 24 * 60 * 60 * 1000

/**
 * No message from the authoritative server in this long -> treat the connection
 * as down. The server pushes a snapshot every ~3s and presence every ~5s, so
 * this allows a couple of missed beats before warning.
 */
export const SERVER_TIMEOUT_MS = 10000

/**
 * DEV ONLY: skip the "Loading server..." gate and unfreeze the player
 * immediately, without waiting for the authoritative server's first snapshot.
 * Lets you preview/edit 3D scene visuals without the server running. Gameplay
 * state (pets, currency, etc.) won't load while this is on. Set back to
 * `false` before testing real gameplay or multiplayer.
 */
export const DEV_SKIP_SERVER_GATE = false

// ---------------------------------------------------------------------------
// Pet speech — what the pet says over its head to nudge the player into a care
// action. The bubble is NOT on a timer: `need` names the stat that drives the
// line, and the pet only speaks when that stat has actually dropped (see
// client/speech.ts). `id` is the dedupe key that stops the same nag repeating
// back-to-back.
// ---------------------------------------------------------------------------
export interface PetSpeechLine {
  id: string
  need: StatKey | 'love'
  text: string
}

export const PET_SPEECH_LINES: PetSpeechLine[] = [
  { id: 'hungry', need: 'hunger', text: "I'm hungry, please feed me!" },
  { id: 'dirty', need: 'hygiene', text: 'I feel dirty... bath time?' },
  { id: 'sleepy', need: 'energy', text: "I'm sleepy, take me to bed!" },
  { id: 'bored', need: 'happiness', text: "I'm bored! Let's play together!" },
  { id: 'love', need: 'love', text: 'Pet me, I missed you!' }
]

/**
 * The line that OVERRIDES every other need once energy drops under
 * PLAY_MIN_ENERGY: at that point the pet can no longer play at all, so sleep is
 * genuinely the most urgent thing regardless of which stat happens to be
 * numerically lowest. See client/speech.ts (neededLine).
 */
export const PET_SPEECH_EXHAUSTED_LINE: PetSpeechLine = {
  id: 'exhausted',
  need: 'energy',
  text: "I'm worn out — I can't play any more. Bed, please!"
}

/**
 * A stat at or below this asks for its care action. Sits well above
 * NEGLECT_THRESHOLD (15) on purpose: the pet should ask BEFORE it is suffering,
 * and above NEW_PET_STATS.hunger (see below) so a fresh hatchling asks to be fed
 * the moment it is placed.
 */
export const PET_SPEECH_NEED_THRESHOLD = 45
/** Seconds a message stays on screen. */
export const PET_SPEECH_HOLD_SECONDS = 5
/** Seconds of silence before the pet may speak again. */
export const PET_SPEECH_GAP_SECONDS = 3
/**
 * Seconds before the SAME line may be repeated. A stat crawls down slowly
 * (DECAY_PER_SEC), so without this the pet would re-ask every few seconds for as
 * long as it stayed hungry. A DIFFERENT need still speaks after the gap above.
 */
export const PET_SPEECH_REPEAT_SECONDS = 45
/**
 * Nothing needed: the pet is content, so it only asks for attention ("love")
 * this often. Set to 0 to keep a content pet silent.
 */
export const PET_SPEECH_IDLE_SECONDS = 120

// ---------------------------------------------------------------------------
// Colony — the shared Mars population everyone is building toward. Teaser for
// now: the server counts pets across the players it knows about and broadcasts
// the total, so every client shows the same number. Real persistent aggregation
// (Storage.world) comes with the colony ring.
// ---------------------------------------------------------------------------
export const COLONY_GOAL = 100 // target population for the current milestone

// ---------------------------------------------------------------------------
// Pet roster — species a player can ADOPT. Derived / breeding-only species
// (see SPROUT_DERIVATIVES) are deliberately NOT in this list: the server
// validates adoption against it (server/state.ts), so they can only ever be
// produced by breeding.
// ---------------------------------------------------------------------------
export const SPECIES: string[] = [
  'sprout-original',
  'pepito-original',
  'amebita-original',
  'fluflito-original'
]

/** The Sprout family: the adoptable base + the variants breeding will roll.
 *  All four share one rig and one clip set (SPROUT_CLIPS below). */
export const SPROUT_BASE = 'sprout-original'
export const SPROUT_DERIVATIVES: string[] = ['sprout-amebita', 'sprout-fluflito', 'sprout-pepito']
export const SPROUT_SPECIES: string[] = [SPROUT_BASE, ...SPROUT_DERIVATIVES]

// Creature models live under assets/Models/creatures/<head-family>/, named
// <family>.glb for an original and <head>_<body>.glb for a cross. The path is
// derived from each pet's head/body, so there's no per-species table to keep in
// sync — every family original and all 12 crosses resolve by the same rule. The
// mesh ships textureless; the base-color skin is applied at runtime (creatureSkins.ts).
// NB: the "Models" segment is capitalised to match the rest of assets/Models (props),
// so the path is case-exact on DCL's case-sensitive asset resolver.
function creatureModelFile(head: Family, body: Family): string {
  const file = head === body ? head : `${head}_${body}`
  return `assets/Models/creatures/${head}/${file}.glb`
}

export function modelForSpecies(species: string): string {
  const { head, body } = speciesParts(species)
  if (isFamily(head) && isFamily(body)) return creatureModelFile(head, body)
  return `assets/scene/Models/${species}/${species}.glb` // non-family fallback
}

// Display-name overrides for ids that don't read well raw (the species id is
// what's persisted in save data, so it stays stable while the label can change).
const SPECIES_LABEL: Record<string, string> = {
  'sprout-original': 'Sprout',
  'sprout-amebita': 'Amebita',
  'sprout-fluflito': 'Fluflito',
  'sprout-pepito': 'Pepito',
  'pepito-original': 'Pepito',
  'amebita-original': 'Amebita',
  'fluflito-original': 'Fluflito'
}

/** Display name for a species — an explicit override wins, else a LEADING "Pet"
 *  is stripped (PetPanda -> Panda), else the id is left intact. */
export function speciesLabel(species: string): string {
  return SPECIES_LABEL[species] ?? (species.startsWith('Pet') ? species.slice(3) : species)
}

// ---------------------------------------------------------------------------
// Animation clips. The pet code (client/pet.ts) asks for LOGICAL clips — idle,
// walk, run… — and each species maps them onto whatever its GLB actually calls
// them. Species with no entry here are assumed to use the logical names as-is
// (that's the alien models), with `sleep` falling back to idle.
// ---------------------------------------------------------------------------
export type PetClip = 'idle' | 'walk' | 'run' | 'eat' | 'dance' | 'gesture-positive' | 'gesture-negative' | 'sleep' | 'sit'

/** Every logical clip, in the order the Animator states are declared. */
export const PET_CLIPS: PetClip[] = ['idle', 'walk', 'run', 'eat', 'dance', 'gesture-positive', 'gesture-negative', 'sleep', 'sit']

// All four families share one rig LAYOUT — the same seven clips, each just
// prefixed with the family name: <Fam>_Idle / _Walk / _Eat / _Happy / _SitIdle
// / _Sad / _Sleep. No dedicated run clip -> reuse walk. So the clip map is
// generated from the prefix instead of hand-listing each family.
function familyClips(prefix: string): Record<PetClip, string> {
  return {
    idle: `${prefix}_Idle`,
    walk: `${prefix}_Walk`,
    run: `${prefix}_Walk`,
    eat: `${prefix}_Eat`,
    dance: `${prefix}_Happy`,
    'gesture-positive': `${prefix}_Happy`,
    'gesture-negative': `${prefix}_Sad`,
    sleep: `${prefix}_Sleep`,
    sit: `${prefix}_SitIdle`
  }
}

const SPECIES_CLIPS: Record<string, Partial<Record<PetClip, string>>> = {
  'sprout-original': familyClips('Sprout'),
  'sprout-amebita': familyClips('Sprout'),
  'sprout-fluflito': familyClips('Sprout'),
  'sprout-pepito': familyClips('Sprout'),
  'pepito-original': familyClips('Pepito'),
  'amebita-original': familyClips('Amebita'),
  'fluflito-original': familyClips('Fluflito')
}

/** The GLB clip name a species uses for a logical clip. Unmapped clips fall back
 *  to that species' idle, so a missing animation never freezes the pet. */
export function clipForSpecies(species: string, clip: PetClip): string {
  const map = SPECIES_CLIPS[species]
  if (map) return map[clip] ?? map.idle ?? 'idle'
  return clip === 'sleep' || clip === 'sit' ? 'idle' : clip // default convention: logical name IS the clip name
}

/** Distinct GLB clip names for a species — what its Animator states are built from. */
export function clipsForSpecies(species: string): string[] {
  const out: string[] = []
  for (const c of PET_CLIPS) {
    const name = clipForSpecies(species, c)
    if (out.indexOf(name) === -1) out.push(name)
  }
  return out
}

// Per-species scale multiplier (× the pet's grown size). Default 1.
const SPECIES_SCALE: Record<string, number> = {
  // Family creatures are authored ~1 m tall: scale up so an ADULT reads at a
  // comparable size next to the other pets.
  'sprout-original': 1.6,
  'sprout-amebita': 1.6,
  'sprout-fluflito': 1.6,
  'sprout-pepito': 1.6,
  'pepito-original': 1.6,
  'amebita-original': 1.6,
  'fluflito-original': 1.6
}

export function scaleForSpecies(species: string): number {
  return SPECIES_SCALE[species] ?? 1
}

// ---------------------------------------------------------------------------
// Breeding genetics — head/body crosses.
//
// Every pet has a HEAD family and a BODY family. Originals share both; a bred
// offspring takes the active parent's head and the partner's body. The rendered
// `species` id encodes the pair (`head_body`, or `head-original` when they match)
// and every one of the 16 combinations is wired below — model, clips, scale — so a
// cross renders on ANY client (needed because pets are swapped between players).
//
// The model files follow one rule: assets/Models/creatures/<head>/<file>.glb,
// where <file> is <family> for an original and <head>_<body> for a cross (see
// creatureModelFile / modelForSpecies). The animation clips of a cross GLB always
// use the HEAD family's prefix, so clips = familyClips(<Head>).
// ---------------------------------------------------------------------------
export const FAMILIES = ['sprout', 'pepito', 'amebita', 'fluflito'] as const
export type Family = (typeof FAMILIES)[number]

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
function isFamily(s: string): s is Family {
  return (FAMILIES as readonly string[]).indexOf(s) !== -1
}

// Legacy/base species id -> (head, body). Backfills head/body for pets saved before
// those fields existed, and lets us read a parent's genetics from its species.
const SPECIES_PARTS: Record<string, [Family, Family]> = {
  'sprout-original': ['sprout', 'sprout'],
  'pepito-original': ['pepito', 'pepito'],
  'amebita-original': ['amebita', 'amebita'],
  'fluflito-original': ['fluflito', 'fluflito'],
  // old scaffolding ids (all rode the Sprout rig)
  'sprout-amebita': ['sprout', 'amebita'],
  'sprout-fluflito': ['sprout', 'fluflito'],
  'sprout-pepito': ['sprout', 'pepito']
}

/** The (head, body) families a species id represents. */
export function speciesParts(species: string): { head: Family; body: Family } {
  const p = SPECIES_PARTS[species]
  if (p) return { head: p[0], body: p[1] }
  const us = species.indexOf('_')
  if (us >= 0) {
    const h = species.slice(0, us)
    const b = species.slice(us + 1)
    if (isFamily(h) && isFamily(b)) return { head: h, body: b }
  }
  return { head: species as Family, body: species as Family } // non-family (alien): itself
}

/** A pet's head/body — the stored fields, or parsed from its species (legacy). */
export function petHead(pet: { head?: string; species: string }): Family {
  return (pet.head as Family | undefined) ?? speciesParts(pet.species).head
}
export function petBody(pet: { body?: string; species: string }): Family {
  return (pet.body as Family | undefined) ?? speciesParts(pet.species).body
}

/** Render species id for a head/body pair (originals collapse to `<fam>-original`). */
export function crossSpecies(head: Family, body: Family): string {
  return head === body ? `${head}-original` : `${head}_${body}`
}

// Wire every cross (head !== body) into the render maps. The model path is derived
// on the fly by modelForSpecies (creatureModelFile), so only the clip/scale/label
// maps need filling here — for every one of the 12 crossings, so a bred/swapped
// pet renders on any client.
for (const head of FAMILIES) {
  for (const body of FAMILIES) {
    if (head === body) continue
    const id = `${head}_${body}`
    SPECIES_CLIPS[id] = familyClips(cap(head)) // cross clips use the HEAD family's prefix
    SPECIES_SCALE[id] = 1.6
    SPECIES_LABEL[id] = `${cap(head)}-${cap(body)}`
  }
}

// Per-species yaw offset (degrees) — corrects models whose "forward" axis differs
// from the walk direction. Default 0 (all current family models face forward).
const SPECIES_YAW_OFFSET: Record<string, number> = {}

export function yawOffsetForSpecies(species: string): number {
  return SPECIES_YAW_OFFSET[species] ?? 0
}

// Ball01.glb (the fetch-minigame ball, client/play.ts) ships one static
// "Ball_Base" pose plus a per-family "carried in mouth while walking" clip —
// Ball_<Fam>_Walk — keyed off the pet's HEAD family, same convention crosses
// use for their own SPECIES_CLIPS above (the head family "wins").
export const BALL_BASE_CLIP = 'Ball_Base'

export function ballWalkClip(species: string): string {
  return `Ball_${cap(speciesParts(species).head)}_Walk`
}

// Optional thumbnail shown in the adoption card circle. Add image paths as the
// art lands; species without one fall back to a colored disc.
const SPECIES_IMAGE: Record<string, string> = {
  'sprout-original': 'assets/images/pets/sprout.png',
  'pepito-original': 'assets/images/pets/pepito.png',
  'amebita-original': 'assets/images/pets/amebita.png',
  'fluflito-original': 'assets/images/pets/fluflito.png'
}

export function speciesImage(species: string): string | undefined {
  return SPECIES_IMAGE[species]
}

// ---------------------------------------------------------------------------
// NOTE: scene object positions (PetFeeder, PetPool, PetBed, Dome01/home,
// Caretaker, Shop) are NOT hardcoded here anymore — they used to be, and
// drifted out of sync with the Creator Hub composite (assets/scene/main.composite)
// whenever an object got moved in the editor. They're now read live from each
// entity's Transform via client/objects.ts (objectPosition / actionObjectPosition),
// so the code always matches wherever the object actually is in the scene.
// ---------------------------------------------------------------------------

export const HOME_RADIUS = 6 // metres from the Dome01 house entity within which the Hatch button shows

// ---------------------------------------------------------------------------
// Birth stats — what a brand-new pet (adopted, hatched, or bred) starts with.
// Everything is comfortable EXCEPT hunger, deliberately: a newborn is hungry, so
// the speech bubble greets the player with "I'm hungry, please feed me!" the
// moment they accept it. That makes Feed the obvious first care action instead
// of the player being handed a pet that needs nothing and standing there.
//
// Keep hunger BELOW PET_SPEECH_NEED_THRESHOLD (45) or the newborn stays silent,
// and ABOVE NEGLECT_THRESHOLD (15) so it isn't born already counting as
// neglected and bleeding happiness.
// ---------------------------------------------------------------------------
export const NEW_PET_STATS: Record<StatKey, number> = {
  hunger: 30,
  hygiene: 85,
  energy: 85,
  happiness: 85
}

// ---------------------------------------------------------------------------
// Stat decay — points lost per real second. Hunger fastest, happiness slowest.
// Tuned for a relaxed cadence: the player is expected back every 2-3 days, so a
// pet left alone that long is hungry and sad but still recoverable.
// ---------------------------------------------------------------------------
export const DECAY_PER_SEC: Record<StatKey, number> = {
  hunger: 0.0004, // ~2.9 days to empty from full
  hygiene: 0.0003, // ~3.9 days
  energy: 0.00033, // ~3.5 days
  happiness: 0.00023 // ~5 days
}

/**
 * Extra happiness penalty per second, per neglected stat. Kept in scale with the
 * decay rates above: fully neglected (3 stats down) drains happiness in ~28h —
 * a real consequence, but not an instant wipe.
 */
export const HAPPINESS_NEGLECT_PENALTY = 0.00025
export const NEGLECT_THRESHOLD = 15 // a stat below this counts as "neglected"

// ---------------------------------------------------------------------------
// Play (Fetch) — the reward loop and its energy gate.
//
// Playing is the ACTIVE way to earn: every completed fetch pays XP + coins, more
// than a passive care action does. What stops it from being an infinite coin
// press isn't a flat cooldown — it's the pet's own energy. Each fetch drains
// PLAY_ENERGY_COST, so from a full tank you get ~6 rounds, and below
// PLAY_MIN_ENERGY the pet is too tired and refuses to play at all.
//
// From there the only way back is sleep, which is deliberately slow
// (SLEEP_FILL_PER_SEC: ~1h from empty on the Bed) and, for the first
// SLEEP_LOCK_MS, uninterruptible — see the sleep lock below. Net effect: play
// is bursty and generous, then the pet needs real downtime, which is exactly
// the care loop this game is about.
// ---------------------------------------------------------------------------
/** Energy spent per completed fetch. 100 -> below the gate in ~6 rounds. */
export const PLAY_ENERGY_COST = 12
/**
 * Below this energy the pet refuses to play. Sits above NEGLECT_THRESHOLD (15)
 * so play stops BEFORE the pet is actually suffering, and below
 * PET_SPEECH_NEED_THRESHOLD (45) so the pet has already been asking for bed for
 * a while by the time it flat-out refuses.
 */
export const PLAY_MIN_ENERGY = 20
/** Pet XP for a completed fetch (vs PET_XP_PER_ACTION for passive care). */
export const PLAY_XP_REWARD = 14
/** Coins for a completed fetch (vs COINS_PER_ACTION for passive care). */
export const PLAY_COINS_REWARD = 9

/** True if the pet has the energy to play right now. Single source of truth for
 *  the gate — server (state.ts), client sim, Fetch flow and HUD all call this. */
export function canPlay(pet: { energy: number; sleeping: boolean }): boolean {
  return !pet.sleeping && pet.energy >= PLAY_MIN_ENERGY
}

/** True if the pet is too tired to play (energy under the gate). ONLY an
 *  exhaustion nap gets the uninterruptible SLEEP_LOCK; a rested pet sent to bed
 *  is a normal toggle you can undo right away. */
export function isExhausted(pet: { energy: number }): boolean {
  return pet.energy < PLAY_MIN_ENERGY
}

/** How much each care action refills. Energy is drained by play.
 *  feed's entry is dead on the direct-trigger path (Feed now runs the fruit
 *  minigame — see FEED_HUNGER_PER_FRUIT — instead of an instant flat effect);
 *  kept because ACTION_COOLDOWN_MS.feed and the CareAction union still use it. */
export const ACTION_EFFECT: Record<CareAction, Partial<Record<StatKey, number>>> = {
  feed: { hunger: 35 },
  clean: { hygiene: 45 },
  sleep: {}, // sleep is a State, not an instant effect — see SLEEP_FILL_PER_SEC
  play: { happiness: 30, energy: -PLAY_ENERGY_COST }
}

/** Hunger restored per fruit caught in the Feed tree minigame (fruitGame.ts).
 *  ~6 catches matches the old flat feed effect; a strong run tops the pet off. */
export const FEED_HUNGER_PER_FRUIT = 6

/** Three deliberately unhurried bites; the pet and fruit path slow together. */
export const FEED_EAT_CINEMATIC_S = 6.6

/** Server-side per-action cooldown (ms) to stop spam. */
export const ACTION_COOLDOWN_MS: Record<CareAction, number> = {
  feed: 8000,
  clean: 12000,
  sleep: 2000, // just a toggle now (sleep/wake), so keep it responsive
  play: 8000
}

// ---------------------------------------------------------------------------
// Sleep — a duration state. The pet stays asleep and energy refills in real
// time; you wake it (or it wakes itself once rested). Leaving it asleep before
// you log off is the intended play: come back to a rested pet.
// ---------------------------------------------------------------------------
/** Energy refilled per second while asleep on the Bed: 0 -> 100 in ~1 hour. */
export const SLEEP_FILL_PER_SEC = 100 / 3600
/** Sleeping somewhere other than the Bed refills at this fraction (~2h). */
export const SLEEP_OFF_BED_FACTOR = 0.5
/** Everything else decays at this fraction while the pet sleeps. */
export const SLEEP_DECAY_FACTOR = 0.5
/**
 * Sleep LOCK: an EXHAUSTED pet sent to bed (energy under the play gate, see
 * isExhausted) cannot be woken for this long. A rested pet you send to bed is
 * NOT locked — it's a normal toggle you can undo right away. Without the lock on
 * the exhaustion nap the energy gate is trivially bypassed — sleep for a second,
 * tap Wake, keep fetching — so the lock is what turns "out of energy" into real
 * downtime. It is a hard lock, not reduced wake sensitivity: Wake is refused
 * outright (and the button + a floating countdown show the time left) until it
 * expires.
 *
 * 3 minutes buys back ~5 energy on the Bed, i.e. not even one fetch — the lock
 * is a pacing beat, not the refill itself. The pet still auto-wakes the moment
 * energy hits 100, whether or not the lock has expired.
 */
export const SLEEP_LOCK_MS = 3 * 60 * 1000

/** Milliseconds left on a pet's sleep lock (0 once it can be woken). */
export function sleepLockRemaining(pet: { sleeping: boolean; sleepLockUntil?: number }, atMs: number): number {
  if (!pet.sleeping) return 0
  return Math.max(0, (pet.sleepLockUntil ?? 0) - atMs)
}

/** "2:41" — a sleep-lock countdown for buttons/toasts. */
export function formatLockCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec < 10 ? '0' : ''}${sec}`
}

// Petting (own pet): instant small happiness, lightly rate-limited.
export const PET_SELF_HAPPINESS = 4
export const PET_SELF_COOLDOWN_MS = 1500

// Pet gesture (Adopt-Me style): clicking Pet locks the camera on the pet and you
// swipe left/right across it to fill a progress bar. Progress advances only while
// actively swiping; it ebbs back when you stop.
export const PET_GESTURE_SECONDS = 3 // swipe time to fill from empty to full
export const PET_GESTURE_DECAY_FACTOR = 0.5 // ebb rate (× fill rate) while idle
export const PET_SWIPE_EPS = 2 // min |screenDelta.x| (px) counted as swiping
/** Celebration beat after completing the petting gesture. */
export const PETTING_HAPPY_CINEMATIC_S = 3
// Mobile fallback: the app has no cursor-drag yet, so the bar fills by TAPPING
// the pet instead of swiping. Each tap adds this much (≈ 1/PET_TAP_FILL taps).
export const PET_TAP_FILL = 0.16

// Pet swaps — offering your active pet to another player for theirs. An offer
// left unanswered this long expires, freeing the target to receive new offers.
export const SWAP_OFFER_TTL_MS = 60000

// Treating / petting other players' pets.
export const PET_OTHER_HAPPINESS = 5
export const PET_OTHER_GIVING_POINTS = 2
export const PET_OTHER_DAILY_CAP = 3 // per giver->pet pair per day
export const PET_OTHER_COOLDOWN_MS = 4000

// ---------------------------------------------------------------------------
// Currency — passive income, accrued per second. Happiness is the ONLY source:
// a neglected pet earns nothing ("caring well IS the economy"). Since happiness
// decays while you're away, a long absence self-limits what you earn.
// Calibrated against the shop scale (kibble 15 / feast 40 / first extra slot 50).
// ---------------------------------------------------------------------------
export const CURRENCY_BASE_PER_SEC = 0 // no floor: an unhappy pet earns zero
export const CURRENCY_HAPPINESS_BONUS_PER_SEC = 0.0028 // multiplied by happiness/100

/** Max seconds of passive income paid out for a single absence (anti-hoarding). */
export const CURRENCY_OFFLINE_CAP_SEC = 8 * 3600 // 8h
export const STARTING_CURRENCY = 50

// ---------------------------------------------------------------------------
// Shop — 2 food tiers.
// ---------------------------------------------------------------------------
export interface ShopItem {
  tier: 1 | 2
  label: string
  price: number
  hunger: number
  happiness: number
}
export const SHOP_ITEMS: ShopItem[] = [
  { tier: 1, label: 'Basic Kibble', price: 15, hunger: 35, happiness: 0 },
  { tier: 2, label: 'Premium Feast', price: 40, hunger: 100, happiness: 10 }
]

// ---------------------------------------------------------------------------
// Pet storage slots — UNLIMITED. There is no cap: the colony grows as far as a
// player is willing to pay for it. Slot 1 is free, and every extra slot is
// bought with an egg whose price steps up, so early pets are cheap enough to
// keep the first session moving while a big roster stays a long-term goal.
//
// Pacing: passive income is ~0.28 coins/sec at full happiness plus
// COINS_PER_ACTION per care action, so the 50-coin second egg lands a few
// minutes in (and the coin counter visibly climbs toward it from second one).
// ---------------------------------------------------------------------------
export const STARTING_SLOTS = 1
/** Price of the first purchasable slot (slot 2). */
export const SLOT_PRICE_BASE = 50
/** Added to the price for each slot already bought past the free starting one. */
export const SLOT_PRICE_STEP = 25

/** Coin price to unlock the NEXT slot for a player who currently has `slots`.
 *  50 -> 75 -> 100 -> ... — linear per slot, so the running total to reach N
 *  pets grows quadratically. Tune with the two constants above. */
export function slotPrice(slots: number): number {
  const bought = Math.max(0, slots - STARTING_SLOTS)
  return SLOT_PRICE_BASE + SLOT_PRICE_STEP * bought
}

// ---------------------------------------------------------------------------
// XP & leveling — data-driven so unlock rewards can grow post-MVP.
// ---------------------------------------------------------------------------
export const PET_XP_PER_ACTION = 8
export const PET_XP_PASSIVE_PER_SEC = 0.007 // scaled by happiness/100; ~2-3 days to reach the breeding unlock level
// Flat coin reward for each care action (feed/bath/sleep/play), on top of the
// passive happiness income. Instant, gamified payout so activities feel rewarding.
export const COINS_PER_ACTION = 5

// ---------------------------------------------------------------------------
// Breeding rarity — the offspring's tier is a random d10 (the "surprise") plus a
// bonus from how well both parents were cared for. Well-kept pets don't
// guarantee a legendary, but they multiply the odds. See shared/breeding.ts.
// ---------------------------------------------------------------------------
/** Extra points added to the d10 when both parents are at full condition (0-100
 *  average health scales this from 0 up to this max). */
export const BREEDING_CARE_BONUS_MAX = 3
/** Min (dice + care bonus) score for each tier, highest first. Below the last
 *  entry falls through to 'common'. Tunable. */
export const BREEDING_RARITY_THRESHOLDS: [Rarity, number][] = [
  ['legendary', 10],
  ['rare', 6]
]

// ---------------------------------------------------------------------------
// Rarity potion — a purchasable coin sink that tilts ONE breeding roll toward
// the rare end. Bought in the Shop, consumed by the breed that uses it.
// ---------------------------------------------------------------------------
export const RARITY_POTION_LABEL = 'Rarity Potion'
export const RARITY_POTION_PRICE = 150
/** Points the potion adds to the breeding score (same scale as the d10 + care
 *  bonus). Deliberately NOT a multiple of the 2-point gap between thresholds:
 *  a potion shifts the odds (roughly doubles the legendary chance) instead of
 *  guaranteeing a flat one-tier jump, so the roll stays a surprise. */
export const BREEDING_POTION_BONUS = 1.5

/** Display name for each rarity tier (shown on the pet, colored by RARITY_COLOR). */
export function rarityLabel(r: Rarity): string {
  const labels: Record<Rarity, string> = {
    common: 'Common',
    rare: 'Rare',
    legendary: 'Legendary'
  }
  return labels[r] ?? labels.common
}
/** Color per rarity tier (RGB 0-1), used for the pet's floating rarity label. */
export const RARITY_COLOR: Record<Rarity, { r: number; g: number; b: number }> = {
  common: { r: 0.95, g: 0.55, b: 0.72 }, // pink (pastel rose)
  rare: { r: 0.35, g: 0.62, b: 0.98 }, // blue
  legendary: { r: 1, g: 0.8, b: 0.2 } // gold
}
export const CARETAKER_XP_PER_ACTION = 5
export const CARETAKER_XP_PER_GIVING = 3

/** XP needed to reach level n (1-indexed). Quadratic-ish idle curve. */
export function xpForLevel(level: number): number {
  return Math.floor(50 * level * level)
}
export function levelForXp(xp: number): number {
  let lvl = 1
  while (xp >= xpForLevel(lvl + 1)) lvl++
  return lvl
}

/** Size growth: pet scales up with cumulative care, capped. */
export const SIZE_BASE = 0.55 // pets start small & cute, grow with care
export const SIZE_PER_CARE = 0.008
export const SIZE_MAX = 1.1
export function sizeForCareCount(careCount: number): number {
  return Math.min(SIZE_MAX, SIZE_BASE + careCount * SIZE_PER_CARE)
}
/** Grow a pet's size by one care step, capped. Care actions use THIS (not
 *  sizeForCareCount) so growth is monotonic: a care action can only ever grow
 *  the pet, never shrink it. Recomputing size from careCount instead would snap
 *  the size DOWN whenever the two drifted apart (migrated saves, breeding, the
 *  debug grow, ...), which showed up as pets shrinking to Junior on bath. */
export function growSize(size: number): number {
  return Math.min(SIZE_MAX, size + SIZE_PER_CARE)
}

// ---------------------------------------------------------------------------
// Growth stages (Adopt-Me style): a pet's SIZE grows with cumulative care
// (see sizeForCareCount) and crosses 3 thresholds over a couple of days. Each
// stage renders at a fixed, chunky size; the pet passport shows the current stage
// and how close it is to the next one (see petGrowthFraction + the growth bar).
// ---------------------------------------------------------------------------
export type PetStage = 'JUNIOR' | 'TEENAGER' | 'ADULT'

// Size thresholds along the SIZE_BASE..SIZE_MAX (0.55..1.1) growth range.
export const PET_STAGE_TEEN_SIZE = 0.73 // grown this big -> TEENAGER
export const PET_STAGE_ADULT_SIZE = 0.92 // grown this big -> ADULT

/** Which growth stage a pet's current size falls into. */
export function petStage(size: number): PetStage {
  if (size >= PET_STAGE_ADULT_SIZE) return 'ADULT'
  if (size >= PET_STAGE_TEEN_SIZE) return 'TEENAGER'
  return 'JUNIOR'
}

/** Overall growth 0..1 across the whole SIZE_BASE..ADULT range — 0 at a newborn,
 *  1 once fully grown (ADULT). Drives the growth progress bar's fill. */
export function petGrowthFraction(size: number): number {
  return Math.max(0, Math.min(1, (size - SIZE_BASE) / (PET_STAGE_ADULT_SIZE - SIZE_BASE)))
}

/** Where the TEENAGER threshold sits along that 0..1 bar (so its label/marker can
 *  be placed proportionally). Junior is at 0, Adult at 1. */
export const PET_STAGE_TEEN_FRACTION = (PET_STAGE_TEEN_SIZE - SIZE_BASE) / (PET_STAGE_ADULT_SIZE - SIZE_BASE)

// Each stage renders at one fixed size, so pets visibly snap between 3 sizes.
// The range is deliberately wide so a JUNIOR reads as a tiny baby next to an ADULT.
const STAGE_SCALE: Record<PetStage, number> = { JUNIOR: 0.7, TEENAGER: 0.9, ADULT: 1.4 }

/** Discrete display scale for a pet's current growth stage. */
export function stageScaleFor(size: number): number {
  return STAGE_SCALE[petStage(size)]
}


// Caretaker level -> reward table (data-driven; stubbed rewards).
export interface LevelReward {
  level: number
  kind: 'currency' | 'slot' | 'spinTicket' | 'foodTier1' | 'foodTier2'
  amount: number
  label: string
}
export const CARETAKER_LEVEL_REWARDS: LevelReward[] = [
  { level: 2, kind: 'currency', amount: 50, label: '+50 coins' },
  { level: 3, kind: 'spinTicket', amount: 1, label: '+1 spin ticket' },
  { level: 4, kind: 'foodTier2', amount: 2, label: '2x Premium Feast' },
  { level: 5, kind: 'slot', amount: 1, label: '+1 pet slot' },
  { level: 7, kind: 'currency', amount: 200, label: '+200 coins' },
  { level: 10, kind: 'slot', amount: 1, label: '+1 pet slot' }
]

// ---------------------------------------------------------------------------
// Achievements — system is MVP; this list is content and can grow.
// ---------------------------------------------------------------------------
export interface Achievement {
  id: string
  label: string
  description: string
  counter: string // which PlayerData.counters key it tracks
  goal: number
  rewardCurrency: number
  rewardSpins: number
}
export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first_feed', label: 'First Meal', description: 'Feed your pet once', counter: 'feedCount', goal: 1, rewardCurrency: 10, rewardSpins: 0 },
  { id: 'feed_50', label: 'Chef', description: 'Feed your pet 50 times', counter: 'feedCount', goal: 50, rewardCurrency: 100, rewardSpins: 1 },
  { id: 'clean_25', label: 'Squeaky Clean', description: 'Bathe your pet 25 times', counter: 'cleanCount', goal: 25, rewardCurrency: 80, rewardSpins: 1 },
  { id: 'play_25', label: 'Playful', description: 'Play with your pet 25 times', counter: 'playCount', goal: 25, rewardCurrency: 80, rewardSpins: 1 },
  { id: 'giver_10', label: 'Good Neighbor', description: 'Pet 10 other pets', counter: 'givingCount', goal: 10, rewardCurrency: 120, rewardSpins: 1 },
  { id: 'caretaker_5', label: 'Seasoned Caretaker', description: 'Reach Caretaker Level 5', counter: 'caretakerLevel', goal: 5, rewardCurrency: 200, rewardSpins: 2 }
]

// ---------------------------------------------------------------------------
// Daily streak milestones.
// ---------------------------------------------------------------------------
export interface StreakMilestone {
  day: number
  currency: number
  spins: number
}
export const STREAK_MILESTONES: StreakMilestone[] = [
  { day: 3, currency: 30, spins: 1 },
  { day: 7, currency: 100, spins: 2 },
  { day: 14, currency: 250, spins: 3 },
  { day: 30, currency: 600, spins: 5 }
]
export const STREAK_DAILY_BONUS = 10 // currency just for logging in

// 7-day login reward calendar. The streak cycles every 7 days; day 7 is the
// jackpot. Logging in on a new consecutive day advances it; missing a day
// resets the streak to day 1.
export interface StreakDayReward {
  day: number
  currency: number
  spins: number
  label: string
}
export const STREAK_WEEK_REWARDS: StreakDayReward[] = [
  { day: 1, currency: 20, spins: 0, label: '20' },
  { day: 2, currency: 35, spins: 0, label: '35' },
  { day: 3, currency: 50, spins: 1, label: '50 +1 spin' },
  { day: 4, currency: 75, spins: 0, label: '75' },
  { day: 5, currency: 110, spins: 1, label: '110 +1 spin' },
  { day: 6, currency: 150, spins: 1, label: '150 +1 spin' },
  { day: 7, currency: 300, spins: 2, label: '300 +2 spins' }
]

// ---------------------------------------------------------------------------
// Spin wheel — generic weighted reward pool. Reusable by streak/achievements.
// ---------------------------------------------------------------------------
export interface SpinReward {
  kind: 'currency' | 'spinTicket' | 'slotChance' | 'cosmetic' | 'foodTier2'
  amount: number
  weight: number
  rarity: 'common' | 'rare' | 'jackpot'
  label: string
}
export const SPIN_REWARDS: SpinReward[] = [
  { kind: 'currency', amount: 20, weight: 40, rarity: 'common', label: '20 coins' },
  { kind: 'currency', amount: 50, weight: 25, rarity: 'common', label: '50 coins' },
  { kind: 'foodTier2', amount: 1, weight: 15, rarity: 'common', label: 'Premium Feast' },
  { kind: 'spinTicket', amount: 1, weight: 10, rarity: 'rare', label: 'Free Spin' },
  { kind: 'currency', amount: 200, weight: 6, rarity: 'rare', label: '200 coins' },
  // cosmetics not built yet -> defaults to a currency-equivalent payout
  { kind: 'cosmetic', amount: 100, weight: 3, rarity: 'jackpot', label: 'Mystery Prize' },
  { kind: 'slotChance', amount: 1, weight: 1, rarity: 'jackpot', label: 'PET SLOT!' }
]

// Navigation / follow tuning (client-side).
export const PET_FOLLOW_DISTANCE = 2.2
export const PET_MOVE_SPEED = 4.0 // m/s
export const PET_ARRIVE_DISTANCE = 0.6
export const PET_BASE_Y = 0

// ---------------------------------------------------------------------------
// Analytics (PostHog) — see dev-docs/posthog-analytics-integration.md.
// The project API key is a write-only public capture token: safe to ship.
// ---------------------------------------------------------------------------
// Master on/off switch. OFF by default so local dev / preview runs never
// pollute the stats. Flip to `true` to test tracking locally, AND remember to
// set it `true` for the production deploy — otherwise production sends nothing.
export const ANALYTICS_ENABLED = false
export const GAME_ID = 'mydearpet' // deadsurge | cozyfarm | mydearpet
export const POSTHOG_HOST = 'eu.i.posthog.com' // EU Cloud
export const POSTHOG_PROJECT_API_KEY = 'phc_vnCGXbvJSyfA5qVW7QKGLnMipCMpqUhTZkMFRBKayKUp'

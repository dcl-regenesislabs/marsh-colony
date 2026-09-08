// Server-authoritative game state: load/save per-player data, apply decay
// (including offline), run care actions, currency, XP, achievements, streak,
// and the spin wheel. All money/stat mutations live here so they can be
// validated and persisted in one place.

import { Storage } from '@dcl/sdk/server'
import type { CareAction, PetData, PlayerData, PresenceEntry, Rarity, StatKey } from '../shared/types'
import * as C from '../shared/config'
import { rollRarity } from '../shared/breeding'

const STORAGE_KEY = 'petdata-v1'
const STAT_KEYS: StatKey[] = ['hunger', 'hygiene', 'energy', 'happiness']

// In-memory cache of loaded players (address -> data). Persisted to Storage.
const players = new Map<string, PlayerData>()
// Per-action cooldown tracking (address -> action -> last ts).
const actionCooldowns = new Map<string, Record<string, number>>()
// Treat farming guard: giver -> "targetAddr|day" -> count.
const treatCounts = new Map<string, Record<string, number>>()
// Addresses whose data was created fresh this server lifetime (no prior save).
const freshPlayers = new Set<string>()
// Per-player pet follow state (Whistle/Stay), reported by the client. Ephemeral
// (session-only) — used to broadcast `following` in presence. Defaults to true.
const followState = new Map<string, boolean>()

/** Record a player's pet follow state so presence can broadcast it. */
export function setFollowState(address: string, following: boolean): void {
  followState.set(address.toLowerCase(), following)
}

// Player display names (from getPlayer().name, reported on requestState). Client-
// supplied, so it is trimmed, stripped of line breaks, and length-capped before it
// ever labels the leaderboard (rendered on other players' screens).
const playerNames = new Map<string, string>()
const NAME_MAX = 20

/** Remember a player's display name for the leaderboard (sanitized). */
export function setPlayerName(address: string, name: string): void {
  const n = (name ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, NAME_MAX)
  if (n) playerNames.set(address.toLowerCase(), n)
}

function shortAddress(address: string): string {
  return address.length > 10 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address
}

// Persisted, scene-scoped leaderboard index (Storage.world) — NOT the in-memory
// player cache. This is what makes the board "across the colony": every player who
// has ever saved has a row here, ranked even after the headless server restarts and
// the cache is empty. Kept in memory, hydrated once from storage, and re-persisted
// on each savePlayer (see upsertLeaderIndex).
type LeaderRow = { name: string; coins: number; creatures: number }
const LEADER_KEY = 'leaderboard-v1'
const LEADER_MAX = 200 // cap the persisted set so the record can't grow unbounded
let leaderIndex: Map<string, LeaderRow> | null = null

type LeaderStored = { address: string } & LeaderRow

async function ensureLeaderIndex(): Promise<Map<string, LeaderRow>> {
  if (leaderIndex) return leaderIndex
  const idx = new Map<string, LeaderRow>()
  try {
    const arr = await Storage.get<LeaderStored[]>(LEADER_KEY)
    if (arr) for (const e of arr) idx.set(e.address.toLowerCase(), { name: e.name, coins: e.coins, creatures: e.creatures })
  } catch (e) {
    console.log('[Server] leaderboard index load failed', e)
  }
  leaderIndex = idx
  return idx
}

/** Upsert a player's row into the persisted leaderboard index. Called from
 *  savePlayer, so the board reflects each player's latest saved coins/creatures.
 *  skipIfUnchanged avoids a network write when nothing actually moved. */
async function upsertLeaderIndex(p: PlayerData): Promise<void> {
  const idx = await ensureLeaderIndex()
  idx.set(p.address.toLowerCase(), {
    name: playerNames.get(p.address.toLowerCase()) ?? shortAddress(p.address),
    coins: Math.floor(p.currency),
    creatures: p.pets.length
  })
  try {
    const arr: LeaderStored[] = [...idx.entries()]
      .map(([address, r]) => ({ address, ...r }))
      .sort((a, b) => b.coins - a.coins)
      .slice(0, LEADER_MAX)
    await Storage.set(LEADER_KEY, arr, { skipIfUnchanged: true })
  } catch (e) {
    console.log('[Server] leaderboard index save failed', e)
  }
}

/** Top players by coins across the colony, highest first (from the persisted index). */
export async function leaderboard(limit = 10): Promise<{ address: string; name: string; coins: number; creatures: number }[]> {
  const idx = await ensureLeaderIndex()
  return [...idx.entries()]
    .map(([address, r]) => ({ address, name: r.name, coins: r.coins, creatures: r.creatures }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, limit)
}

/** True if this wallet had no saved state when first loaded (a new user). */
export function isFreshPlayer(address: string): boolean {
  return freshPlayers.has(address)
}

export type Notify = { kind: string; message: string }

function now(): number {
  return Date.now()
}

function newPet(species: string, name: string): PetData {
  const t = now()
  const parts = C.speciesParts(species) // head/body families (originals: head === body)
  return {
    id: `pet_${t}_${Math.floor(Math.random() * 100000)}`,
    species,
    head: parts.head,
    body: parts.body,
    name: name || C.speciesLabel(species),
    rarity: 'common',
    hunger: C.NEW_PET_STATS.hunger,
    hygiene: C.NEW_PET_STATS.hygiene,
    energy: C.NEW_PET_STATS.energy,
    happiness: C.NEW_PET_STATS.happiness,
    petXp: 0,
    petLevel: 1,
    size: C.SIZE_BASE,
    careCount: 0,
    generation: 0,
    sleeping: false,
    sleepOnBed: false,
    sleepLockUntil: 0,
    bornAt: t,
    lastUpdated: t
  }
}

function newPlayer(address: string): PlayerData {
  const t = now()
  return {
    address,
    currency: C.STARTING_CURRENCY,
    inventory: { tier1: 1, tier2: 0, rarityPotions: 0 },
    caretakerXp: 0,
    caretakerLevel: 1,
    givingScore: 0,
    spinTickets: 1,
    streakCount: 0,
    lastLoginDay: 0,
    meteorDay: -1,
    achievements: [],
    counters: {},
    petSlots: C.STARTING_SLOTS,
    activePetId: '',
    pets: [],
    hatchling: null,
    createdAt: t,
    lastUpdated: t
  }
}

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v))
}

function activePet(p: PlayerData): PetData | null {
  // A just-hatched pet (not yet placed) is what you see/care for until you keep
  // or discard it; otherwise it's the selected slotted pet.
  return p.hatchling ?? p.pets.find((pet) => pet.id === p.activePetId) ?? null
}

// ---------------------------------------------------------------------------
// Decay — applied to every pet a player owns (active and stored both decay).
// ---------------------------------------------------------------------------
/** End the sleep state. Always go through this so the lock can never outlive
 *  the sleep it belongs to (a stale lock would block the NEXT wake). */
function wake(pet: PetData): void {
  pet.sleeping = false
  pet.sleepLockUntil = 0
}

function decayPet(pet: PetData, atMs: number): void {
  const elapsedSec = Math.max(0, (atMs - pet.lastUpdated) / 1000)
  if (elapsedSec <= 0) return

  // While asleep the pet rests: energy refills instead of draining, and
  // everything else decays at a reduced rate.
  const slow = pet.sleeping ? C.SLEEP_DECAY_FACTOR : 1
  for (const k of STAT_KEYS) {
    if (k === 'happiness') continue
    if (k === 'energy' && pet.sleeping) continue // refilled below
    pet[k] = clamp(pet[k] - C.DECAY_PER_SEC[k] * elapsedSec * slow)
  }
  if (pet.sleeping) {
    const fill = C.SLEEP_FILL_PER_SEC * (pet.sleepOnBed ? 1 : C.SLEEP_OFF_BED_FACTOR)
    pet.energy = clamp(pet.energy + fill * elapsedSec)
    if (pet.energy >= 100) wake(pet) // wakes up rested (the lock ends with it)
  }
  // Happiness decays slowly, with extra penalty if other stats are neglected.
  let happinessLoss = C.DECAY_PER_SEC.happiness * elapsedSec * slow
  let neglected = 0
  if (pet.hunger < C.NEGLECT_THRESHOLD) neglected++
  if (pet.hygiene < C.NEGLECT_THRESHOLD) neglected++
  if (pet.energy < C.NEGLECT_THRESHOLD) neglected++
  happinessLoss += neglected * C.HAPPINESS_NEGLECT_PENALTY * elapsedSec
  pet.happiness = clamp(pet.happiness - happinessLoss)

  // Passive pet XP scaled by happiness (rewards sustained good care).
  pet.petXp += C.PET_XP_PASSIVE_PER_SEC * elapsedSec * (pet.happiness / 100)
  pet.petLevel = C.levelForXp(pet.petXp)

  pet.lastUpdated = atMs
}

/** Recompute all pets + accrue currency for the active pet's happiness. */
export function tickPlayer(p: PlayerData, atMs = now()): void {
  for (const pet of p.pets) {
    const before = pet.lastUpdated
    decayPet(pet, atMs)
    void before
  }
  // Currency accrues from the active pet's happiness.
  const active = activePet(p)
  const elapsedSec = Math.max(0, (atMs - p.lastUpdated) / 1000)
  if (active && elapsedSec > 0) {
    // Cap what a single absence pays out — being away for days shouldn't bank a
    // fortune. While online this is a no-op (each tick's elapsed is a few secs).
    const paidSec = Math.min(elapsedSec, C.CURRENCY_OFFLINE_CAP_SEC)
    const rate = C.CURRENCY_BASE_PER_SEC + C.CURRENCY_HAPPINESS_BONUS_PER_SEC * (active.happiness / 100)
    p.currency += rate * paidSec
  }
  p.lastUpdated = atMs
}

export function deriveMood(pet: PetData): number {
  const min = Math.min(pet.hunger, pet.hygiene, pet.energy)
  // Mood is dominated by happiness but tanks if any stat bottoms out.
  return clamp(pet.happiness * 0.6 + min * 0.4)
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------
export async function loadPlayer(address: string): Promise<PlayerData> {
  if (players.has(address)) {
    const cached = players.get(address)!
    tickPlayer(cached)
    return cached
  }
  let data: PlayerData | null = null
  try {
    data = await Storage.player.get<PlayerData>(address, STORAGE_KEY)
  } catch (e) {
    console.log('[Server] Storage load failed for', address, e)
  }
  if (!data || !data.address) {
    data = newPlayer(address)
    freshPlayers.add(address) // no prior saved state -> new user (for analytics)
  } else {
    // Migrate/sanitize loaded data, then apply offline decay.
    data = sanitize(address, data)
    tickPlayer(data)
  }
  applyDailyStreak(data)
  players.set(address, data)
  await savePlayer(address)
  return data
}

/** Collapse legacy 5-tier rarities into the current 3 tiers: uncommon -> common,
 *  ultraRare -> rare. Common/rare/legendary (and anything unexpected) pass through
 *  to their nearest valid tier so old saves never carry a dead rarity value. */
function normalizeRarity(r: unknown): Rarity {
  if (r === 'legendary') return 'legendary'
  if (r === 'rare' || r === 'ultraRare') return 'rare'
  return 'common'
}

// A species whose head/body aren't real families (the removed alien pets, or any
// unknown legacy id) would resolve to a deleted GLB and render as an INVISIBLE
// pet. Remap those saves onto a valid adoptable species so the pet still shows up;
// family originals and crosses pass through untouched. Also collapses the rarity.
const FAMILY_SET = new Set<string>(C.FAMILIES)
function migratePet<T extends PetData>(pet: T): T {
  const cur = C.speciesParts(pet.species)
  const species = FAMILY_SET.has(cur.head) && FAMILY_SET.has(cur.body) ? pet.species : 'sprout-original'
  const parts = C.speciesParts(species)
  return { ...pet, species, head: parts.head, body: parts.body, rarity: normalizeRarity(pet.rarity) }
}

function sanitize(address: string, d: PlayerData): PlayerData {
  const base = newPlayer(address)
  return {
    ...base,
    ...d,
    address,
    inventory: { ...base.inventory, ...(d.inventory ?? {}) },
    counters: d.counters ?? {},
    achievements: d.achievements ?? [],
    pets: (d.pets ?? []).map((pet) => migratePet({ ...newPet(pet.species, pet.name), ...pet })),
    hatchling: d.hatchling ? migratePet({ ...newPet(d.hatchling.species, d.hatchling.name), ...d.hatchling }) : null
  }
}

export async function savePlayer(address: string): Promise<void> {
  const p = players.get(address)
  if (!p) return
  try {
    await Storage.player.set<PlayerData>(address, STORAGE_KEY, p)
  } catch (e) {
    console.log('[Server] Storage save failed for', address, e)
  }
  // Keep the cross-colony leaderboard index in step with this player's save.
  await upsertLeaderIndex(p)
}

export function getCached(address: string): PlayerData | undefined {
  return players.get(address)
}

export function allCached(): PlayerData[] {
  return [...players.values()]
}

// ---------------------------------------------------------------------------
// Daily streak
// ---------------------------------------------------------------------------
function applyDailyStreak(p: PlayerData): Notify[] {
  const today = Math.floor(now() / C.DAY_MS)
  const notes: Notify[] = []
  if (p.lastLoginDay === today) return notes
  if (p.lastLoginDay === today - 1) {
    p.streakCount += 1
  } else {
    p.streakCount = 1
  }
  p.lastLoginDay = today
  p.currency += C.STREAK_DAILY_BONUS
  notes.push({ kind: 'streak', message: `Day ${p.streakCount} streak! +${C.STREAK_DAILY_BONUS} coins` })
  const milestone = C.STREAK_MILESTONES.find((m) => m.day === p.streakCount)
  if (milestone) {
    p.currency += milestone.currency
    p.spinTickets += milestone.spins
    notes.push({ kind: 'streak', message: `Streak milestone day ${milestone.day}! +${milestone.currency} coins, +${milestone.spins} spins` })
  }
  return notes
}

// ---------------------------------------------------------------------------
// Progression helpers
// ---------------------------------------------------------------------------
function bump(p: PlayerData, counter: string, by = 1): void {
  p.counters[counter] = (p.counters[counter] ?? 0) + by
}

function grantCaretakerXp(p: PlayerData, xp: number, notes: Notify[]): void {
  p.caretakerXp += xp
  const newLevel = C.levelForXp(p.caretakerXp)
  while (p.caretakerLevel < newLevel) {
    p.caretakerLevel += 1
    p.counters['caretakerLevel'] = p.caretakerLevel
    const reward = C.CARETAKER_LEVEL_REWARDS.find((r) => r.level === p.caretakerLevel)
    if (reward) applyLevelReward(p, reward, notes)
    notes.push({ kind: 'level', message: `Caretaker Level ${p.caretakerLevel}!` })
  }
}

function applyLevelReward(p: PlayerData, r: C.LevelReward, notes: Notify[]): void {
  switch (r.kind) {
    case 'currency':
      p.currency += r.amount
      break
    case 'slot':
      p.petSlots += r.amount
      break
    case 'spinTicket':
      p.spinTickets += r.amount
      break
    case 'foodTier1':
      p.inventory.tier1 += r.amount
      break
    case 'foodTier2':
      p.inventory.tier2 += r.amount
      break
  }
  notes.push({ kind: 'reward', message: `Level reward: ${r.label}` })
}

function checkAchievements(p: PlayerData, notes: Notify[]): void {
  for (const a of C.ACHIEVEMENTS) {
    if (p.achievements.indexOf(a.id) !== -1) continue
    const progress = p.counters[a.counter] ?? 0
    if (progress >= a.goal) {
      p.achievements.push(a.id)
      p.currency += a.rewardCurrency
      p.spinTickets += a.rewardSpins
      notes.push({ kind: 'achievement', message: `Achievement: ${a.label}! +${a.rewardCurrency} coins` })
    }
  }
}

function grantPetXp(pet: PetData, xp: number): void {
  pet.petXp += xp * (0.5 + 0.5 * (pet.happiness / 100)) // happiness multiplier
  pet.petLevel = C.levelForXp(pet.petXp)
}

// ---------------------------------------------------------------------------
// Actions (each returns notifications for the caller to forward)
// ---------------------------------------------------------------------------
function cooldownOk(address: string, action: string, ms: number): boolean {
  const map = actionCooldowns.get(address) ?? {}
  const last = map[action] ?? 0
  if (now() - last < ms) return false
  map[action] = now()
  actionCooldowns.set(address, map)
  return true
}

export function adopt(p: PlayerData, species: string, name: string): Notify[] {
  if (C.SPECIES.indexOf(species) === -1) {
    return [{ kind: 'error', message: 'Unknown species' }]
  }
  if (p.hatchling) {
    return [{ kind: 'error', message: 'Place or discard your current pet first' }]
  }
  if (p.pets.length >= p.petSlots) {
    return [{ kind: 'error', message: 'No free pet slots' }]
  }
  // A newly adopted pet hatches into `hatchling` — the player then keeps it (into
  // a slot) or discards it. Not added to the roster yet.
  p.hatchling = newPet(species, name)
  return []
}

/** Keep the hatchling: place it in a free slot and make it the active pet. */
export function keepPet(p: PlayerData): Notify[] {
  if (!p.hatchling) return [{ kind: 'error', message: 'Nothing to keep' }]
  if (p.pets.length >= p.petSlots) {
    return [{ kind: 'error', message: 'No free pet slots' }]
  }
  const pet = p.hatchling
  p.hatchling = null
  p.pets.push(pet)
  p.activePetId = pet.id
  bump(p, 'adoptCount')
  return [{ kind: 'adopt', message: `${pet.name} joined your colony!` }]
}

/** Discard the hatchling: it goes back to the Care Center — you keep nothing. */
export function discardPet(p: PlayerData): Notify[] {
  if (!p.hatchling) return []
  const name = p.hatchling.name
  p.hatchling = null
  return [{ kind: 'adopt', message: `${name} was sent back to the Care Center.` }]
}

// ---------------------------------------------------------------------------
// Breeding — cross the active pet with a partner into a new offspring. Rarity is
// rolled from both parents' condition + luck (see shared/breeding.ts). For now
// the partner is another pet the player owns; cross-player (async registry) is
// the follow-up. Offspring inherits a parent's species (random for now — real
// genetics later) and starts fresh.
// ---------------------------------------------------------------------------
export function breed(p: PlayerData, partnerId: string, name = '', usePotion = false): { notes: Notify[]; rarity: Rarity | null; species?: string; name?: string } {
  tickPlayer(p)
  const a = activePet(p)
  if (!a) return { notes: [{ kind: 'error', message: 'No active pet' }], rarity: null }
  const b = p.pets.find((x) => x.id === partnerId && x.id !== a.id)
  if (!b) return { notes: [{ kind: 'error', message: 'Pick a different pet to breed with' }], rarity: null }
  if (C.petStage(a.size) !== 'ADULT' || C.petStage(b.size) !== 'ADULT') {
    return { notes: [{ kind: 'error', message: 'Both pets must be Adult to breed' }], rarity: null }
  }
  if (p.hatchling) {
    return { notes: [{ kind: 'error', message: 'Place or discard your current egg first' }], rarity: null }
  }
  if (p.pets.length >= p.petSlots) {
    return { notes: [{ kind: 'error', message: 'No free pet slots for the offspring' }], rarity: null }
  }
  // Asked for a potion but has none: refuse rather than silently breed without
  // the boost — the roll can't be taken back.
  if (usePotion && p.inventory.rarityPotions <= 0) {
    return { notes: [{ kind: 'error', message: `No ${C.RARITY_POTION_LABEL} in your inventory` }], rarity: null }
  }

  // Consumed here, after every check passed, so a rejected breed never eats it.
  if (usePotion) p.inventory.rarityPotions -= 1
  const rarity = rollRarity(a, b, usePotion)
  // Genetics: the offspring wears the ACTIVE pet's head and the PARTNER's body
  // (config.crossSpecies encodes the pair; newPet reads head/body back from it).
  const species = C.crossSpecies(C.petHead(a), C.petBody(b))
  const gen = Math.max(a.generation, b.generation) + 1 // Gen-1 for the first cross
  const chosen = name.trim() || C.speciesLabel(species)
  const child = newPet(species, `Gen-${gen} ${chosen}`)
  child.rarity = rarity
  child.generation = gen
  // Offspring is delivered as an EGG: it becomes the hatchling (carried home and
  // hatched, then kept into a slot), exactly like a fresh adoption.
  p.hatchling = child
  bump(p, 'breedCount')

  const potionNote = usePotion ? ` (${C.RARITY_POTION_LABEL} used)` : ''
  return { notes: [{ kind: 'breed', message: `You bred a ${C.rarityLabel(rarity)} egg${potionNote} — carry it home to hatch!` }], rarity, species: child.species, name: child.name }
}

/** DEBUG/testing: grow the active pet straight to Adult + level 5 so breeding
 *  can be tested without days of care. Sets careCount/size and XP to match. */
export function debugGrowAdult(p: PlayerData): Notify[] {
  const pet = activePet(p)
  if (!pet) return [{ kind: 'error', message: 'No active pet' }]
  pet.careCount = Math.max(pet.careCount, 70) // keeps size maxed even after care
  pet.size = C.SIZE_MAX // Adult (>= PET_STAGE_ADULT_SIZE)
  pet.petXp = Math.max(pet.petXp, C.xpForLevel(5))
  pet.petLevel = C.levelForXp(pet.petXp)
  const nextSlot = C.slotPrice(p.petSlots)
  p.currency = Math.max(p.currency, nextSlot) // enough to unlock the next pet slot
  return [{ kind: 'adopt', message: `DEBUG: ${pet.name} is now Adult (Lv ${pet.petLevel}), ${nextSlot} coins — breeding + slot ${p.petSlots + 1} unlocked.` }]
}

/** Shared tail for a completed (non-sleep) care action: apply the stat effects,
 *  grow/level/reward the pet + caretaker, and check achievements. Shared by
 *  careAction and feedFromMinigame so this logic can't drift between them. */
function applyCompletedCare(
  p: PlayerData,
  pet: PetData,
  effects: Partial<Record<StatKey, number>>,
  counterKey: string,
  notes: Notify[],
  // Play pays more than passive care because it costs energy and takes a whole
  // fetch round to earn — see the Play section in config.
  xp = C.PET_XP_PER_ACTION,
  coins = C.COINS_PER_ACTION
): void {
  wake(pet)
  for (const key of Object.keys(effects) as StatKey[]) {
    pet[key] = clamp(pet[key] + effects[key]!)
  }
  pet.careCount += 1
  // Monotonic growth (never recompute from careCount) so a care action can only
  // grow the pet, never shrink it — recomputing from careCount snapped size down
  // to Junior after a bath when size/careCount had drifted apart (breeding, debug
  // grow, migration). See growSize in config.
  pet.size = C.growSize(pet.size)
  grantPetXp(pet, xp)
  grantCaretakerXp(p, C.CARETAKER_XP_PER_ACTION, notes)
  p.currency += coins
  bump(p, counterKey)
  bump(p, 'careCount')
  checkAchievements(p, notes)
}

export function careAction(p: PlayerData, action: CareAction, onBed: boolean): Notify[] {
  const notes: Notify[] = []
  const pet = activePet(p)
  if (!pet) return [{ kind: 'error', message: 'No active pet' }]
  tickPlayer(p) // decay first, so the gates below judge CURRENT energy/sleep

  // Sleep lock: for the first SLEEP_LOCK_MS of a nap nothing gets through —
  // not Wake, and not another care action (which would implicitly wake it via
  // applyCompletedCare). This is what stops the play energy gate from being
  // bypassed with a one-second nap. Checked BEFORE cooldownOk, which consumes
  // the action's cooldown slot as a side effect — a refusal here shouldn't also
  // cost the player their next legitimate attempt once the lock expires.
  const lockLeft = C.sleepLockRemaining(pet, now())
  if (lockLeft > 0) {
    return [{ kind: 'sleep', message: `${pet.name} is fast asleep — ${C.formatLockCountdown(lockLeft)} left.` }]
  }
  if (!cooldownOk(p.address, action, C.ACTION_COOLDOWN_MS[action])) {
    return [{ kind: 'cooldown', message: 'Pet is still busy...' }]
  }

  // Sleep is a toggle into/out of a state, not a completed care action — it
  // earns no XP/coins/careCount in either direction. Its cooldown is short
  // ("responsive" toggle) so a payout here would let players farm currency
  // and careCount-gated growth by flipping it on/off.
  if (action === 'sleep') {
    if (pet.sleeping) {
      wake(pet)
      return [{ kind: 'sleep', message: `${pet.name} woke up.` }]
    }
    pet.sleeping = true
    pet.sleepOnBed = onBed
    // Only an EXHAUSTION nap is locked (can't play -> must rest). A rested pet
    // sent to bed is a normal toggle you can undo right away.
    const locked = C.isExhausted(pet)
    if (locked) pet.sleepLockUntil = now() + C.SLEEP_LOCK_MS
    const where = onBed ? 'is asleep in bed' : 'dozed off — not in bed, so it rests slower'
    const lockNote = locked ? ` It can't be woken for ${C.formatLockCountdown(C.SLEEP_LOCK_MS)}.` : ''
    return [{ kind: 'sleep', message: `${pet.name} ${where}.${lockNote}` }]
  }

  // Play (Fetch) is energy-gated: too tired -> no play, no reward. The refusal
  // is the nudge toward the bed, which the speech bubble is already making.
  if (action === 'play' && !C.canPlay(pet)) {
    return [{ kind: 'energy', message: `${pet.name} is too tired to play — it needs to sleep first.` }]
  }

  // Play pays more than a passive care action — it costs energy and takes a
  // whole fetch round. No success notify here on purpose: the client already
  // shows the "+XP +coins" popup and the worn-out nudge (client/play.ts), and a
  // server toast on top of them would just double up.
  const xp = action === 'play' ? C.PLAY_XP_REWARD : C.PET_XP_PER_ACTION
  const coins = action === 'play' ? C.PLAY_COINS_REWARD : C.COINS_PER_ACTION
  applyCompletedCare(p, pet, C.ACTION_EFFECT[action], `${action}Count`, notes, xp, coins)
  return notes
}

/** Feed tree minigame result: hunger restored scales with fruit caught (client-
 *  submitted, so `caught` isn't trusted beyond this — but clamp(0,100) already
 *  ceilings any inflated value at the same cap a legitimate great run reaches). */
export function feedFromMinigame(p: PlayerData, caught: number): Notify[] {
  const notes: Notify[] = []
  const pet = activePet(p)
  if (!pet) return [{ kind: 'error', message: 'No active pet' }]
  tickPlayer(p)
  // Same sleep lock as careAction — applyCompletedCare wakes the pet, so a
  // minigame result must not be a back door out of the nap either.
  const lockLeft = C.sleepLockRemaining(pet, now())
  if (lockLeft > 0) {
    return [{ kind: 'sleep', message: `${pet.name} is fast asleep — ${C.formatLockCountdown(lockLeft)} left.` }]
  }
  if (!cooldownOk(p.address, 'feed', C.ACTION_COOLDOWN_MS.feed)) {
    return [{ kind: 'cooldown', message: 'Pet is still busy...' }]
  }
  applyCompletedCare(p, pet, { hunger: caught * C.FEED_HUNGER_PER_FRUIT }, 'feedCount', notes)
  return notes
}

export function petSelf(p: PlayerData): Notify[] {
  const pet = activePet(p)
  if (!pet) return []
  if (!cooldownOk(p.address, 'petSelf', C.PET_SELF_COOLDOWN_MS)) return []
  pet.happiness = clamp(pet.happiness + C.PET_SELF_HAPPINESS)
  grantPetXp(pet, 1)
  return []
}

export function petOther(giver: PlayerData, target: PlayerData): Notify[] {
  const notes: Notify[] = []
  const targetPet = activePet(target)
  if (!targetPet) return [{ kind: 'error', message: 'That player has no pet' }]
  if (!cooldownOk(giver.address, `petOther_${target.address}`, C.PET_OTHER_COOLDOWN_MS)) return []
  // Daily cap per giver->target pair.
  const day = Math.floor(now() / C.DAY_MS)
  const key = `${target.address}|${day}`
  const counts = treatCounts.get(giver.address) ?? {}
  if ((counts[key] ?? 0) >= C.PET_OTHER_DAILY_CAP) {
    return [{ kind: 'cooldown', message: 'Daily treats for this pet reached' }]
  }
  counts[key] = (counts[key] ?? 0) + 1
  treatCounts.set(giver.address, counts)

  targetPet.happiness = clamp(targetPet.happiness + C.PET_OTHER_HAPPINESS)
  giver.givingScore += C.PET_OTHER_GIVING_POINTS
  bump(giver, 'givingCount')
  grantCaretakerXp(giver, C.CARETAKER_XP_PER_GIVING, notes)
  checkAchievements(giver, notes)
  notes.push({ kind: 'giving', message: `You petted ${target.address.slice(0, 6)}'s pet! +${C.PET_OTHER_GIVING_POINTS} Giving` })
  return notes
}

// ---------------------------------------------------------------------------
// Pet swaps — a player offers their active pet to another player for that
// player's active pet. One pending offer per target address; the target accepts
// or declines. On accept the two pets change rosters intact (name/stats/rarity
// preserved), each becoming the receiver's active pet.
// ---------------------------------------------------------------------------
export type SwapOffer = { from: string; fromPetId: string; to: string; toPetId: string; at: number }
const pendingSwaps = new Map<string, SwapOffer>() // keyed by target (to) address, lowercased

/** The active *slotted* pet (never a hatchling) a player would swap. */
function slottedActivePet(p: PlayerData): PetData | null {
  if (p.hatchling) return null
  return p.pets.find((pet) => pet.id === p.activePetId) ?? null
}

export function getPendingSwap(targetAddress: string): SwapOffer | undefined {
  const offer = pendingSwaps.get(targetAddress.toLowerCase())
  if (offer && now() - offer.at >= C.SWAP_OFFER_TTL_MS) {
    pendingSwaps.delete(targetAddress.toLowerCase())
    return undefined
  }
  return offer
}

/** Propose swapping my active pet for the target's active pet. Returns the pets
 *  (for the server to forward to the target) or notes on failure. */
export function proposeSwap(
  from: PlayerData,
  target: PlayerData
): { notes: Notify[]; offeredPet: PetData | null; wantedPet: PetData | null } {
  if (from.address.toLowerCase() === target.address.toLowerCase()) {
    return { notes: [{ kind: 'error', message: "You can't swap with yourself" }], offeredPet: null, wantedPet: null }
  }
  const mine = slottedActivePet(from)
  if (!mine) return { notes: [{ kind: 'error', message: 'Select one of your pets to offer first' }], offeredPet: null, wantedPet: null }
  const theirs = slottedActivePet(target)
  if (!theirs) return { notes: [{ kind: 'error', message: 'That player has no pet to swap' }], offeredPet: null, wantedPet: null }
  const key = target.address.toLowerCase()
  if (getPendingSwap(key)) {
    return { notes: [{ kind: 'error', message: 'That player is reviewing another offer — try again shortly' }], offeredPet: null, wantedPet: null }
  }
  pendingSwaps.set(key, { from: from.address, fromPetId: mine.id, to: target.address, toPetId: theirs.id, at: now() })
  return { notes: [], offeredPet: mine, wantedPet: theirs }
}

/** Target answers the pending offer to them. Executes the swap on accept. */
export function respondSwap(
  target: PlayerData,
  proposer: PlayerData | null,
  accept: boolean
): { notes: Notify[]; proposerNote: Notify | null; swapped: boolean } {
  const key = target.address.toLowerCase()
  const offer = pendingSwaps.get(key)
  if (!offer) return { notes: [{ kind: 'error', message: 'No pending swap offer' }], proposerNote: null, swapped: false }
  pendingSwaps.delete(key)

  if (!accept) {
    return { notes: [{ kind: 'swap', message: 'Swap declined.' }], proposerNote: { kind: 'swap', message: 'Your swap offer was declined.' }, swapped: false }
  }
  if (!proposer) {
    return { notes: [{ kind: 'error', message: 'That player is no longer around' }], proposerNote: null, swapped: false }
  }
  tickPlayer(proposer)
  tickPlayer(target)
  const fromIdx = proposer.pets.findIndex((x) => x.id === offer.fromPetId)
  const toIdx = target.pets.findIndex((x) => x.id === offer.toPetId)
  if (fromIdx === -1 || toIdx === -1) {
    return {
      notes: [{ kind: 'error', message: 'The swap fell through — a pet was no longer available' }],
      proposerNote: { kind: 'swap', message: 'The swap fell through — a pet was no longer available.' },
      swapped: false
    }
  }
  // Move the two pets between rosters, each becoming the receiver's active pet.
  const fromPet = proposer.pets.splice(fromIdx, 1)[0]
  const toPet = target.pets.splice(toIdx, 1)[0]
  proposer.pets.push(toPet)
  target.pets.push(fromPet)
  proposer.activePetId = toPet.id
  target.activePetId = fromPet.id
  bump(proposer, 'swapCount')
  bump(target, 'swapCount')
  return {
    notes: [{ kind: 'swap', message: `Swap complete — you got ${fromPet.name}!` }],
    proposerNote: { kind: 'swap', message: `Swap accepted — you got ${toPet.name}!` },
    swapped: true
  }
}

/** Drop any pending offer addressed to this target (e.g. when they leave). */
export function clearPendingSwap(targetAddress: string): void {
  pendingSwaps.delete(targetAddress.toLowerCase())
}

export function buyItem(p: PlayerData, tier: number): Notify[] {
  const item = C.SHOP_ITEMS.find((i) => i.tier === tier)
  if (!item) return [{ kind: 'error', message: 'No such item' }]
  if (p.currency < item.price) return [{ kind: 'error', message: 'Not enough coins' }]
  p.currency -= item.price
  if (tier === 1) p.inventory.tier1 += 1
  else p.inventory.tier2 += 1
  return [{ kind: 'shop', message: `Bought ${item.label}` }]
}

export function useItem(p: PlayerData, tier: number): Notify[] {
  const notes: Notify[] = []
  const pet = activePet(p)
  if (!pet) return [{ kind: 'error', message: 'No active pet' }]
  const have = tier === 1 ? p.inventory.tier1 : p.inventory.tier2
  if (have <= 0) return [{ kind: 'error', message: 'You have none of that food' }]
  const item = C.SHOP_ITEMS.find((i) => i.tier === tier)!
  if (tier === 1) p.inventory.tier1 -= 1
  else p.inventory.tier2 -= 1
  tickPlayer(p)
  pet.hunger = clamp(pet.hunger + item.hunger)
  pet.happiness = clamp(pet.happiness + item.happiness)
  pet.careCount += 1
  pet.size = C.growSize(pet.size)
  grantPetXp(pet, C.PET_XP_PER_ACTION)
  grantCaretakerXp(p, C.CARETAKER_XP_PER_ACTION, notes)
  p.currency += C.COINS_PER_ACTION
  bump(p, 'feedCount')
  checkAchievements(p, notes)
  notes.push({ kind: 'feed', message: `Fed ${pet.name} ${item.label}` })
  return notes
}

export function switchPet(p: PlayerData, petId: string): Notify[] {
  if (!p.pets.find((pet) => pet.id === petId)) return [{ kind: 'error', message: 'No such pet' }]
  p.activePetId = petId
  return [{ kind: 'roster', message: 'Switched active pet' }]
}

/** Buy one rarity potion — a pure coin sink; it is spent on a breeding roll. */
export function buyPotion(p: PlayerData): Notify[] {
  if (p.currency < C.RARITY_POTION_PRICE) return [{ kind: 'error', message: 'Not enough coins' }]
  p.currency -= C.RARITY_POTION_PRICE
  p.inventory.rarityPotions += 1
  return [{ kind: 'shop', message: `Bought a ${C.RARITY_POTION_LABEL}` }]
}

/** Buy the next pet slot. Slots are unlimited — each one just costs more than
 *  the last (see C.slotPrice), so the price read here MUST be the one for the
 *  player's current slot count, not a flat constant. */
export function buySlot(p: PlayerData): Notify[] {
  const price = C.slotPrice(p.petSlots)
  if (p.currency < price) return [{ kind: 'error', message: 'Not enough coins' }]
  p.currency -= price
  p.petSlots += 1
  return [{ kind: 'shop', message: `Unlocked pet slot ${p.petSlots}!` }]
}

/** Roll a weighted reward from the pool and apply it. Shared by spin + meteor. */
function rollAndApplyReward(p: PlayerData): { reward: C.SpinReward; index: number } {
  const total = C.SPIN_REWARDS.reduce((s, r) => s + r.weight, 0)
  let roll = Math.random() * total
  let index = 0
  for (let i = 0; i < C.SPIN_REWARDS.length; i++) {
    roll -= C.SPIN_REWARDS[i].weight
    if (roll <= 0) {
      index = i
      break
    }
  }
  const reward = C.SPIN_REWARDS[index]
  switch (reward.kind) {
    case 'currency':
    case 'cosmetic': // cosmetics not built -> pay out as currency-equivalent
      p.currency += reward.amount
      break
    case 'spinTicket':
      p.spinTickets += reward.amount
      break
    case 'foodTier2':
      p.inventory.tier2 += reward.amount
      break
    case 'slotChance':
      p.petSlots += reward.amount
      break
  }
  return { reward, index }
}

export function spin(p: PlayerData): { notes: Notify[]; reward: C.SpinReward | null; index: number } {
  if (p.spinTickets <= 0) return { notes: [{ kind: 'error', message: 'No spin tickets' }], reward: null, index: -1 }
  p.spinTickets -= 1
  const { reward, index } = rollAndApplyReward(p)
  return { notes: [{ kind: 'spin', message: `Spin: ${reward.label}!` }], reward, index }
}

/** The daily meteor: one free roll from the same pool per day. Server-authoritative
 *  — the claimed day lives on PlayerData so it survives reloads and can't be farmed. */
export function openMeteorReward(p: PlayerData): { notes: Notify[]; reward: C.SpinReward | null; index: number } {
  const today = Math.floor(now() / C.DAY_MS)
  if (p.meteorDay === today) {
    return { notes: [{ kind: 'error', message: "Today's meteor is already collected." }], reward: null, index: -1 }
  }
  p.meteorDay = today
  const { reward, index } = rollAndApplyReward(p)
  return { notes: [{ kind: 'meteor', message: `Meteor: ${reward.label}!` }], reward, index }
}

/** Which day of the 7-day daily-reward ladder the player is on (1..7). The day-7
 *  step is the jackpot in STREAK_WEEK_REWARDS. */
function dailyLadderDay(p: PlayerData): number {
  return (((p.streakCount - 1) % 7) + 7) % 7 + 1
}

/** Claim today's fixed daily-reward ladder step. Gated by meteorDay (once per
 *  day), server-authoritative so the coins actually persist. */
export function claimDailyReward(p: PlayerData): { notes: Notify[]; currency: number; spins: number; day: number } {
  const today = Math.floor(now() / C.DAY_MS)
  if (p.meteorDay === today) {
    return { notes: [{ kind: 'error', message: 'Daily reward already claimed today.' }], currency: 0, spins: 0, day: 0 }
  }
  p.meteorDay = today
  const day = dailyLadderDay(p)
  const r = C.STREAK_WEEK_REWARDS[day - 1]
  p.currency += r.currency
  p.spinTickets += r.spins
  return {
    notes: [{ kind: 'daily', message: `Daily reward: +${r.currency} coins${r.spins ? ` +${r.spins} spins` : ''}!` }],
    currency: r.currency,
    spins: r.spins,
    day
  }
}

// ---------------------------------------------------------------------------
// Presence (broadcast)
// ---------------------------------------------------------------------------
export function presenceFor(p: PlayerData): PresenceEntry | null {
  const pet = activePet(p)
  if (!pet) return null
  return {
    address: p.address,
    species: pet.species,
    name: pet.name,
    rarity: pet.rarity,
    size: pet.size,
    mood: deriveMood(pet),
    level: pet.petLevel,
    following: followState.get(p.address.toLowerCase()) ?? true
  }
}

export function snapshotFor(p: PlayerData): { player: PlayerData; activePet: PetData | null } {
  return { player: p, activePet: activePet(p) }
}

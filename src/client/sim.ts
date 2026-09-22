// Client-side game simulation. The server stays authoritative WHEN it answers
// (snapshots snap us to its values), but messaging can be unreliable, so the
// client also seeds a default player and simulates locally — this guarantees
// the full HUD always renders and the game stays responsive/playable.

import * as Cfg from '../shared/config'
import type { CareAction, PetData, PlayerData, StatKey } from '../shared/types'
import { clientState, showReward } from './state'

const STAT_KEYS: StatKey[] = ['hunger', 'hygiene', 'energy', 'happiness']

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Overall mood: dominated by happiness, tanks if any stat bottoms out. */
export function deriveMood(pet: { hunger: number; hygiene: number; energy: number; happiness: number }): number {
  const min = Math.min(pet.hunger, pet.hygiene, pet.energy)
  return clamp(pet.happiness * 0.6 + min * 0.4)
}

/** Create a default player so the UI renders before/without a server snapshot. */
export function seedLocalPlayer(): void {
  if (clientState.player) return
  const t = Date.now()
  clientState.player = {
    address: clientState.myAddress || 'local',
    currency: Cfg.STARTING_CURRENCY,
    inventory: { tier1: 1, tier2: 0, rarityPotions: 0 },
    caretakerXp: 0,
    caretakerLevel: 1,
    givingScore: 0,
    spinTickets: 1,
    streakCount: 1,
    lastLoginDay: Math.floor(t / Cfg.DAY_MS),
    meteorDay: -1,
    achievements: [],
    counters: {},
    petSlots: Cfg.STARTING_SLOTS,
    activePetId: '',
    pets: [],
    hatchling: null,
    createdAt: t,
    lastUpdated: t
  }
}

/** Per-frame local simulation: decay the active pet + accrue currency/xp. */
export function simTick(dt: number): void {
  const p = clientState.player
  if (!p) return
  const pet = clientState.activePet
  if (!pet) return

  // Mirrors the server: asleep -> energy refills, everything else slows down.
  const slow = pet.sleeping ? Cfg.SLEEP_DECAY_FACTOR : 1
  for (const k of STAT_KEYS) {
    if (k === 'happiness') continue
    if (k === 'energy' && pet.sleeping) continue // refilled below
    pet[k] = clamp(pet[k] - Cfg.DECAY_PER_SEC[k] * dt * slow)
  }
  if (pet.sleeping) {
    const fill = Cfg.SLEEP_FILL_PER_SEC * (pet.sleepOnBed ? 1 : Cfg.SLEEP_OFF_BED_FACTOR)
    pet.energy = clamp(pet.energy + fill * dt)
    if (pet.energy >= 100) wakeLocal(pet) // wakes up rested (the lock ends with it)
  }
  let happinessLoss = Cfg.DECAY_PER_SEC.happiness * dt * slow
  let neglected = 0
  if (pet.hunger < Cfg.NEGLECT_THRESHOLD) neglected++
  if (pet.hygiene < Cfg.NEGLECT_THRESHOLD) neglected++
  if (pet.energy < Cfg.NEGLECT_THRESHOLD) neglected++
  happinessLoss += neglected * Cfg.HAPPINESS_NEGLECT_PENALTY * dt
  pet.happiness = clamp(pet.happiness - happinessLoss)

  pet.petXp += Cfg.PET_XP_PASSIVE_PER_SEC * dt * (pet.happiness / 100)
  pet.petLevel = Cfg.levelForXp(pet.petXp)

  p.currency += (Cfg.CURRENCY_BASE_PER_SEC + Cfg.CURRENCY_HAPPINESS_BONUS_PER_SEC * (pet.happiness / 100)) * dt
}

// ---------------------------------------------------------------------------
// 7-day login streak
// ---------------------------------------------------------------------------
function todayIndex(): number {
  return Math.floor(Date.now() / Cfg.DAY_MS)
}

/** Advance / reset the streak based on the current day. Call once on login. */
export function evaluateStreak(): void {
  const s = clientState.streak
  const today = todayIndex()
  if (s.lastDay === today) return // already counted today
  if (s.lastDay === 0) {
    s.count = Math.max(1, s.count) // very first login
  } else if (s.lastDay === today - 1) {
    s.count += 1 // consecutive day
  } else {
    s.count = 1 // missed a day -> reset
  }
  s.lastDay = today
  if (clientState.player) clientState.player.streakCount = s.count
}

/** Which day of the 7-day cycle today is (1..7). */
export function streakWeekDay(): number {
  return ((clientState.streak.count - 1) % 7 + 7) % 7 + 1
}

export function streakClaimable(): boolean {
  return clientState.streak.claimedDay !== todayIndex()
}

// --- Server-authoritative daily reward (the meteor ladder). Day + claimed state
// come from the SERVER snapshot (streakCount + meteorDay), so claims persist.
/** True if today's daily reward hasn't been claimed yet (server meteorDay gate). */
export function dailyClaimable(): boolean {
  const p = clientState.player
  return !!p && p.meteorDay !== todayIndex()
}
/** Which day of the 6-day ladder the player is on (1..6), from server streakCount. */
// 7-day ladder so the day-7 jackpot in STREAK_WEEK_REWARDS is actually reachable.
export function dailyLadderDay(): number {
  const c = clientState.player?.streakCount ?? 1
  return (((c - 1) % 7) + 7) % 7 + 1
}

/** Claim today's reward. Returns the reward, or null if already claimed. */
export function claimStreak(): { currency: number; spins: number; day: number } | null {
  if (!streakClaimable()) return null
  const day = streakWeekDay()
  const r = Cfg.STREAK_WEEK_REWARDS[day - 1]
  clientState.streak.claimedDay = todayIndex()
  const p = clientState.player
  if (p) {
    p.currency += r.currency
    p.spinTickets += r.spins
    p.streakCount = clientState.streak.count
  }
  return { currency: r.currency, spins: r.spins, day }
}

/** Grant care XP locally; returns the pet XP gained (rounded) for the reward UI. */
function grantXp(p: PlayerData, base = Cfg.PET_XP_PER_ACTION): number {
  const pet = clientState.activePet
  if (!pet) return 0
  const gain = base * (0.5 + 0.5 * (pet.happiness / 100))
  pet.petXp += gain
  pet.petLevel = Cfg.levelForXp(pet.petXp)
  p.caretakerXp += Cfg.CARETAKER_XP_PER_ACTION
  p.caretakerLevel = Cfg.levelForXp(p.caretakerXp)
  return Math.round(gain)
}

function bumpCounter(p: PlayerData, key: string): void {
  p.counters[key] = (p.counters[key] ?? 0) + 1
}

// ---------------------------------------------------------------------------
// Local economy (applies immediately; the server snapshot corrects when alive)
// ---------------------------------------------------------------------------
/** Mirrors server buySlot: no cap, and the price steps up per slot owned. */
export function buySlotLocal(): boolean {
  const p = clientState.player
  if (!p) return false
  const price = Cfg.slotPrice(p.petSlots)
  if (p.currency < price) return false
  p.currency -= price
  p.petSlots += 1
  return true
}

/** Optimistic mirror of the server's buyPotion (coins -> one rarity potion). */
export function buyPotionLocal(): boolean {
  const p = clientState.player
  if (!p || p.currency < Cfg.RARITY_POTION_PRICE) return false
  p.currency -= Cfg.RARITY_POTION_PRICE
  p.inventory.rarityPotions += 1
  return true
}

export function buyItemLocal(tier: number): boolean {
  const p = clientState.player
  const item = Cfg.SHOP_ITEMS.find((i) => i.tier === tier)
  if (!p || !item || p.currency < item.price) return false
  p.currency -= item.price
  if (tier === 1) p.inventory.tier1 += 1
  else p.inventory.tier2 += 1
  return true
}

export function useItemLocal(tier: number): boolean {
  const p = clientState.player
  const pet = clientState.activePet
  const item = Cfg.SHOP_ITEMS.find((i) => i.tier === tier)
  if (!p || !pet || !item) return false
  const have = tier === 1 ? p.inventory.tier1 : p.inventory.tier2
  if (have <= 0) return false
  if (tier === 1) p.inventory.tier1 -= 1
  else p.inventory.tier2 -= 1
  pet.hunger = clamp(pet.hunger + item.hunger)
  pet.happiness = clamp(pet.happiness + item.happiness)
  // Mirror the server: feeding is a care action — grow, gain XP + coins, cheer it.
  pet.careCount += 1
  pet.size = Cfg.growSize(pet.size)
  const xpGain = grantXp(p)
  p.currency += Cfg.COINS_PER_ACTION
  showReward(xpGain, Cfg.COINS_PER_ACTION)
  return true
}

/** Roll a weighted reward from the pool and apply it to the player. */
function rollReward(): { reward: Cfg.SpinReward; index: number } {
  const p = clientState.player!
  const total = Cfg.SPIN_REWARDS.reduce((s, r) => s + r.weight, 0)
  let roll = Math.random() * total
  let index = 0
  for (let i = 0; i < Cfg.SPIN_REWARDS.length; i++) {
    roll -= Cfg.SPIN_REWARDS[i].weight
    if (roll <= 0) {
      index = i
      break
    }
  }
  const reward = Cfg.SPIN_REWARDS[index]
  switch (reward.kind) {
    case 'currency':
    case 'cosmetic':
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

export function spinLocal(): { reward: Cfg.SpinReward; index: number } | null {
  const p = clientState.player
  if (!p || p.spinTickets <= 0) return null
  p.spinTickets -= 1
  return rollReward()
}

/**
 * Whether today's meteor is still up for grabs. Read from the server-owned
 * `meteorDay` on PlayerData (arrives in the snapshot), NOT from local state —
 * the server rolls and persists the reward, so a reload can't farm it.
 * Returns null while we're still waiting for the first snapshot.
 */
export function meteorAvailable(): boolean | null {
  const p = clientState.player
  if (!p) return null
  return p.meteorDay !== todayIndex()
}

// ---------------------------------------------------------------------------
// Sleep lock — local mirror of the server rule (server/state.ts careAction):
// a pet just sent to bed can't be woken, or otherwise interrupted, for
// SLEEP_LOCK_MS. Read through these helpers so the HUD, the Fetch flow and the
// optimistic care path all agree on one answer.
// ---------------------------------------------------------------------------
function wakeLocal(pet: PetData): void {
  pet.sleeping = false
  pet.sleepLockUntil = 0
}

/** Milliseconds left before the active pet may be woken (0 = free / awake). */
export function sleepLockLeft(): number {
  const pet = clientState.activePet
  if (!pet) return 0
  return Cfg.sleepLockRemaining(pet, Date.now())
}

/** True while the active pet is locked in its nap. */
export function sleepLocked(): boolean {
  return sleepLockLeft() > 0
}

/** True if the active pet has the energy to play (Fetch) right now. */
export function canPlayNow(): boolean {
  const pet = clientState.activePet
  return !!pet && Cfg.canPlay(pet)
}

/** Apply a care action's effect locally (optimistic; server snapshot corrects).
 *  Returns false when the action was refused — the caller should NOT send it to
 *  the server, since the server applies the same gates and would refuse too. */
export function applyCareLocal(action: CareAction, onBed: boolean): boolean {
  const p = clientState.player
  const pet = clientState.activePet
  if (!p || !pet) return false
  // Nothing gets through the sleep lock, including the wake toggle itself.
  if (sleepLocked()) return false
  // Sleep toggles the rest state; it's not a completed care action, so it
  // earns no XP/coins/careCount in either direction (matches the server —
  // see careAction — otherwise its short toggle cooldown is farmable).
  if (action === 'sleep') {
    if (pet.sleeping) {
      wakeLocal(pet)
      return true
    }
    pet.sleeping = true
    pet.sleepOnBed = onBed
    // Only an exhaustion nap locks (mirrors the server) — a rested pet you sent
    // to bed can be woken again immediately.
    if (Cfg.isExhausted(pet)) pet.sleepLockUntil = Date.now() + Cfg.SLEEP_LOCK_MS
    return true
  }
  // Play is energy-gated: a worn-out pet earns nothing until it has slept.
  if (action === 'play' && !Cfg.canPlay(pet)) return false
  wakeLocal(pet)
  const effects = Cfg.ACTION_EFFECT[action]
  for (const key of Object.keys(effects) as StatKey[]) {
    pet[key] = clamp(pet[key] + effects[key]!)
  }
  pet.careCount += 1
  pet.size = Cfg.growSize(pet.size)
  const coins = action === 'play' ? Cfg.PLAY_COINS_REWARD : Cfg.COINS_PER_ACTION
  const xpGain = grantXp(p, action === 'play' ? Cfg.PLAY_XP_REWARD : Cfg.PET_XP_PER_ACTION)
  p.currency += coins // instant coin reward (matches the server)
  bumpCounter(p, `${action}Count`)
  bumpCounter(p, 'careCount')
  showReward(xpGain, coins) // gamified "+XP +coins" popup
  return true
}

/** Apply the Feed tree minigame's result locally (optimistic; server snapshot
 *  corrects). Mirrors applyCareLocal's tail, but the hunger delta scales with
 *  fruit caught instead of a flat ACTION_EFFECT. Poison only turns sickness on;
 *  clearing it remains an authoritative Caretaker action. */
export function applyFeedMinigameLocal(caught: number, poisoned: boolean): void {
  const p = clientState.player
  const pet = clientState.activePet
  if (!p || !pet || caught <= 0) return
  if (sleepLocked()) return // the nap is uninterruptible — mirrors feedFromMinigame
  wakeLocal(pet)
  pet.hunger = clamp(pet.hunger + caught * Cfg.FEED_HUNGER_PER_FRUIT)
  pet.careCount += 1
  pet.size = Cfg.growSize(pet.size) // monotonic — never shrink (mirrors the server)
  const xpGain = grantXp(p)
  p.currency += Cfg.COINS_PER_ACTION
  bumpCounter(p, 'feedCount')
  bumpCounter(p, 'careCount')
  showReward(xpGain, Cfg.COINS_PER_ACTION)
  if (poisoned && !pet.sick) pet.sick = true
}

/** Optimistic mirror of the Caretaker cure. The server immediately follows with
 * the authoritative snapshot and can reject a stale/repeated request. */
export function applyCureLocal(): void {
  const p = clientState.player
  const pet = clientState.activePet
  if (!p || !pet || !pet.sick || sleepLocked()) return
  pet.sick = false
  pet.careCount += 1
  pet.size = Cfg.growSize(pet.size)
  const xpGain = grantXp(p, Cfg.SICKNESS_CURE_XP)
  p.currency += Cfg.SICKNESS_CURE_COINS
  bumpCounter(p, 'cureCount')
  bumpCounter(p, 'careCount')
  showReward(xpGain, Cfg.SICKNESS_CURE_COINS)
}

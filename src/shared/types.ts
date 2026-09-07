// Shared data model. These plain interfaces are the authoritative shape of game
// state owned by the server and mirrored (read-only) on the client for UI.

export type CareAction = 'feed' | 'clean' | 'sleep' | 'play'
export type StatKey = 'hunger' | 'hygiene' | 'energy' | 'happiness'

/** Offspring cosmetic rarity tiers, common -> legendary (à la Adopt Me). */
export type Rarity = 'common' | 'uncommon' | 'rare' | 'ultraRare' | 'legendary'

/** Per-pet state. Every pet (active or stored) carries its own stats & XP. */
export interface PetData {
  id: string
  species: string // the RENDER id (model/clips/scale key). For a cross it's `head_body`.
  // Breeding genetics: which family the HEAD and the BODY come from ('sprout' |
  // 'pepito' | 'amebita' | 'fluflito'). Originals have head === body. An offspring
  // takes its head from the active parent and its body from the partner; `species`
  // is then derived from this pair. Optional so pets saved before the fields
  // existed still load — they fall back to being parsed from `species`.
  head?: string
  body?: string
  name: string
  rarity: Rarity // cosmetic tier; 'common' for adopted starters, rolled for offspring
  // Core stats, 0-100
  hunger: number
  hygiene: number
  energy: number
  happiness: number
  // Progression
  petXp: number
  petLevel: number
  size: number // visual scale multiplier (1.0 = base), grows with care milestones
  careCount: number // cumulative care actions, drives size growth
  generation: number // 0 = adopted; a bred offspring is max(parents)+1 (Gen-1, Gen-2, ...)
  // Sleep — a state, not an instant top-up: energy refills over time while true.
  sleeping: boolean
  sleepOnBed: boolean // resting on the Bed refills at full rate, elsewhere slower
  // Sleep lock: ms timestamp until which the pet CANNOT be woken (0 = free to
  // wake). Set when it is sent to bed, cleared whenever it stops sleeping. This
  // is what makes the play energy gate stick — see SLEEP_LOCK_MS.
  sleepLockUntil: number
  // Bookkeeping
  bornAt: number // ms timestamp
  lastUpdated: number // ms timestamp of last decay calculation
}

/** Per-player account. Persists across pets. Keyed by wallet address. */
export interface PlayerData {
  address: string
  // Economy
  currency: number
  inventory: { tier1: number; tier2: number; rarityPotions: number } // food consumables + rarity potions
  // Progression
  caretakerXp: number
  caretakerLevel: number
  givingScore: number
  spinTickets: number
  // Daily streak
  streakCount: number
  lastLoginDay: number // day index (floor(ms / DAY_MS))
  meteorDay: number // day index of the last collected meteor (-1 = never)
  // Achievements
  achievements: string[] // unlocked ids
  counters: Record<string, number> // generic counters that feed achievements (feedCount, etc.)
  // Roster
  petSlots: number
  activePetId: string
  pets: PetData[]
  // A just-hatched pet not yet placed in a slot: keep it (-> pets) or discard it.
  hatchling: PetData | null
  // Bookkeeping
  createdAt: number
  lastUpdated: number
}

/** Lightweight broadcast entry so every client can render every player's pet. */
export interface PresenceEntry {
  address: string
  species: string
  name: string
  rarity: Rarity // cosmetic tier — synced so everyone sees the colored label
  size: number
  mood: number // 0-100 derived overall mood, drives sad/happy idle
  level: number
  following?: boolean // is the owner's pet currently following them?
}

/** One row of the coins leaderboard (server-ranked, top N by currency). */
export interface LeaderboardEntry {
  address: string // to mark "you" on the client
  name: string // player display name (from getPlayer().name at requestState)
  coins: number
  creatures: number // how many pets the player has raised (from persisted storage)
}

/** Snapshot sent to the owning client to drive the HUD. */
export interface PlayerSnapshot {
  player: PlayerData
  activePet: PetData | null
}

/** A pending pet-swap offer, sent to the target so they can review + decide. */
export interface SwapOfferPayload {
  fromAddress: string
  fromName: string // proposer's display name (falls back to a short address)
  offeredPet: PetData // full profile of the pet being offered (name, rarity, stats…)
  wantedPetName: string // the target's pet the proposer wants in return
}

// Miniature full avatars of the 6 richest players, shown on the LeaderBoard01 model.
// Headpoint01 = rank 1 … Headpoint06 = rank 6 (empty markers placed in the composite).
// Each slot is a seated AvatarShape built from the player's Catalyst profile
// (wearables + colours). The avatar is a child of its Headpoint with an identity
// local transform, so it follows the Headpoint's position, rotation and scale live:
// move/rotate/scale the Headpoint in the editor to seat the avatar on the ledge
// (Headpoint = the avatar's origin, i.e. the floor point under the seated avatar).
// The standings come from the same server leaderboard the HUD panel uses
// (clientState.leaderboard).

import { AvatarShape, engine, Entity, executeTask, GltfContainer, Transform } from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { Color3, Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { actions, clientState } from './state'

const HEAD_POINTS = [
  EntityNames.Headpoint01,
  EntityNames.Headpoint02,
  EntityNames.Headpoint03,
  EntityNames.Headpoint04,
  EntityNames.Headpoint05,
  EntityNames.Headpoint06
]

const AVATAR_SCALE = 0.42 // avatar scale in the Headpoint's LOCAL space. The Headpoints are children of LeaderBoard01 (parent scale 2.1), so the real seated height is ~1.75 m × 0.42 × 2.1 ≈ 1.54 m.
// Slots alternate poses (1st/3rd/5th use the first, 2nd/4th/6th the second) for variety.
// Built-ins: sittingChair1/2, sittingGround1/2.
const SIT_EMOTES = ['sittingChair1', 'sittingChair2']
const SIT_RETRIGGER_S = 3 // emotes on an AvatarShape play once — replay it so the avatar stays seated
// DEBUG: show the LOCAL player in all 6 slots — works offline (no server / leaderboard
// needed), to lay the Headpoints out without 6 real players. Set false for the real top 6.
const DEBUG_ALL_FIRST_PLAYER = false
// DEBUG: give every slot a different random avatar (random base body, hair, clothes,
// accessories and colours from the Catalyst base-avatars catalog) to sanity-check the
// layout against many body shapes. Takes precedence over DEBUG_ALL_FIRST_PLAYER.
const DEBUG_RANDOM_AVATARS = false
const RANDOM_PREFIX = 'random-'
const BASE_CATALOG_URL = 'https://peer.decentraland.org/lambdas/collections/wearables?collectionId=urn:decentraland:off-chain:base-avatars'
const BASE_BODIES = ['urn:decentraland:off-chain:base-avatars:BaseMale', 'urn:decentraland:off-chain:base-avatars:BaseFemale']
const SKIN_COLORS = ['#F5D5BC', '#F2C2A5', '#D4A277', '#B3805B', '#8D5524', '#5C3A21']
const HAIR_COLORS = ['#1C1C1C', '#5A3825', '#C8A24A', '#A83232', '#E8E2D0', '#3B6EA5', '#7A3EA5']
const EYE_COLORS = ['#3A5A8C', '#2F6B3A', '#6B4423', '#4A4A4A']
const SHOW_NAMEPLATE = false // AvatarShape has no hide flag — an empty name shows no tag
const REFRESH_S = 30 // standings refresh (server also rate-limits requests)
const FIRST_REQUEST_S = 3
const PROFILE_URL = 'https://peer.decentraland.org/lambdas/profiles/'
const DEFAULT_BODY = 'urn:decentraland:off-chain:base-avatars:BaseMale'
const DEFAULT_WEARABLES = [
  'urn:decentraland:off-chain:base-avatars:eyebrows_00',
  'urn:decentraland:off-chain:base-avatars:mouth_00',
  'urn:decentraland:off-chain:base-avatars:eyes_00',
  'urn:decentraland:off-chain:base-avatars:blue_tshirt',
  'urn:decentraland:off-chain:base-avatars:brown_pants',
  'urn:decentraland:off-chain:base-avatars:classic_shoes',
  'urn:decentraland:off-chain:base-avatars:short_hair'
]

type Look = {
  bodyShape: string
  wearables: string[]
  hair?: Color3
  skin?: Color3
  eyes?: Color3
}
type Slot = { idx: number; point: Entity; avatar: Entity; address: string; name: string }
type Row = { address: string; name: string }

let slots: Slot[] | null = null
let timer = 0
let requestedOnce = false
let sitTimer = 0
let sitStamp = 1
let shownKey = ''
let catalogPromise: Promise<Record<string, Record<string, string[]>>> | null = null // category -> bodyShape -> wearable ids
const lookCache = new Map<string, Look>() // address -> profile look (default for guests / failures)
const lookInflight = new Set<string>()

function buildSlots(): Slot[] | null {
  const points = HEAD_POINTS.map((n) => engine.getEntityOrNullByName(n))
  if (points.some((p) => p === null)) return null // composite not loaded yet

  return (points as Entity[]).map((point, idx) => {
    // The Headpoints are placement markers (they carry a Fruit01 model as a visual
    // reference) — drop the model so only the avatar shows.
    if (GltfContainer.has(point)) GltfContainer.deleteFrom(point)

    const avatar = engine.addEntity()
    // Identity local position/rotation: the avatar sits exactly on the Headpoint and
    // follows it live; only the base size is set here (it multiplies the Headpoint's scale).
    Transform.create(avatar, {
      parent: point,
      scale: Vector3.create(AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE)
    })
    return { idx, point, avatar, address: '', name: '' }
  })
}

const asColor = (c: any): Color3 | undefined =>
  c && typeof c.r === 'number' ? Color3.create(c.r, c.g, c.b) : undefined

const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)]
const hex = (h: string): Color3 =>
  Color3.create(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)

function loadCatalog(): Promise<Record<string, Record<string, string[]>>> {
  if (!catalogPromise) {
    catalogPromise = (async () => {
      const res = await fetch(BASE_CATALOG_URL)
      const body = await res.json()
      const out: Record<string, Record<string, string[]>> = {}
      for (const w of body.wearables ?? []) {
        const cat: string = w.data?.category
        if (!cat) continue
        for (const rep of w.data.representations ?? []) {
          for (const shape of rep.bodyShapes ?? []) {
            ;((out[cat] ??= {})[shape] ??= []).push(w.id)
          }
        }
      }
      return out
    })()
  }
  return catalogPromise
}

/** A random-but-valid base avatar: required face/hair/outfit categories, plus optional extras. */
async function randomLook(): Promise<Look> {
  const catalog = await loadCatalog()
  const bodyShape = pick(BASE_BODIES)
  const one = (cat: string): string[] => {
    const ids = catalog[cat]?.[bodyShape]
    return ids && ids.length ? [pick(ids)] : []
  }
  const maybe = (cat: string, chance: number): string[] => (Math.random() < chance ? one(cat) : [])
  const wearables = [
    ...one('eyes'),
    ...one('eyebrows'),
    ...one('mouth'),
    ...one('hair'),
    ...one('upper_body'),
    ...one('lower_body'),
    ...one('feet'),
    ...maybe('facial_hair', bodyShape === BASE_BODIES[0] ? 0.35 : 0),
    ...maybe('eyewear', 0.35),
    ...maybe('earring', 0.25),
    ...maybe('tiara', 0.1),
    ...maybe('hands_wear', 0.1)
  ]
  return { bodyShape, wearables, skin: hex(pick(SKIN_COLORS)), hair: hex(pick(HAIR_COLORS)), eyes: hex(pick(EYE_COLORS)) }
}

const emoteFor = (slot: Slot): string => SIT_EMOTES[slot.idx % SIT_EMOTES.length]

function paintAvatar(slot: Slot, look: Look): void {
  AvatarShape.createOrReplace(slot.avatar, {
    id: DEBUG_ALL_FIRST_PLAYER || DEBUG_RANDOM_AVATARS ? `${slot.address}-${slot.idx + 1}` : slot.address, // ids must be unique per entity
    name: SHOW_NAMEPLATE ? `#${slot.idx + 1} ${slot.name}` : '',
    bodyShape: look.bodyShape,
    wearables: look.wearables,
    emotes: [],
    hairColor: look.hair,
    skinColor: look.skin,
    eyeColor: look.eyes,
    expressionTriggerId: emoteFor(slot),
    expressionTriggerTimestamp: sitStamp
  })
}

function fetchLook(address: string): void {
  if (lookCache.has(address) || lookInflight.has(address)) return
  lookInflight.add(address)
  executeTask(async () => {
    let look: Look = { bodyShape: DEFAULT_BODY, wearables: DEFAULT_WEARABLES }
    try {
      if (DEBUG_RANDOM_AVATARS && address.startsWith(RANDOM_PREFIX)) {
        look = await randomLook()
      } else {
        const res = await fetch(PROFILE_URL + address)
        const body = await res.json()
        const av = body?.avatars?.[0]?.avatar
        if (av?.bodyShape && Array.isArray(av.wearables)) {
          look = {
            bodyShape: av.bodyShape,
            wearables: av.wearables,
            hair: asColor(av.hair?.color),
            skin: asColor(av.skin?.color),
            eyes: asColor(av.eyes?.color)
          }
        }
      }
    } catch (e) {
      console.log('[LeaderAvatars] profile fetch failed', address, e)
    }
    lookInflight.delete(address)
    lookCache.set(address, look)
    // Repaint whichever slot is showing this player.
    for (const s of slots ?? []) if (s.address === address) paintAvatar(s, look)
  })
}

function refreshSlots(): void {
  if (!slots) return
  let rows: Row[] = clientState.leaderboard.slice(0, slots.length)
  if (DEBUG_RANDOM_AVATARS) {
    rows = slots.map((_, i) => ({ address: `${RANDOM_PREFIX}${i + 1}`, name: `Random ${i + 1}` }))
  } else if (DEBUG_ALL_FIRST_PLAYER) {
    const me = getPlayer()
    const first: Row | undefined = me ? { address: me.userId, name: me.name } : rows[0]
    rows = first ? slots.map(() => first) : []
  }
  const key = rows.map((r) => `${r.address}:${r.name}`).join('|')
  if (key === shownKey) return
  shownKey = key

  slots.forEach((slot, i) => {
    const row = rows[i]
    if (!row) {
      slot.address = ''
      AvatarShape.deleteFrom(slot.avatar)
      return
    }
    slot.address = row.address
    slot.name = row.name
    const look = lookCache.get(row.address)
    if (look) paintAvatar(slot, look)
    else fetchLook(row.address) // painted when the profile arrives
  })
}

export function setupLeaderboardHeads(): void {
  engine.addSystem((dt: number) => {
    if (!slots) {
      slots = buildSlots()
      return
    }

    sitTimer += dt
    if (sitTimer >= SIT_RETRIGGER_S) {
      sitTimer = 0
      sitStamp++ // a new timestamp makes the client replay the emote
      for (const s of slots) {
        if (s.address && AvatarShape.has(s.avatar)) AvatarShape.getMutable(s.avatar).expressionTriggerTimestamp = sitStamp
      }
    }

    timer += dt
    const due = requestedOnce ? REFRESH_S : FIRST_REQUEST_S
    if (timer >= due) {
      timer = 0
      requestedOnce = true
      try {
        actions.requestLeaderboard()
      } catch (e) {
        console.log('[LeaderAvatars] leaderboard request failed', e)
      }
    }
    refreshSlots()
  })
}

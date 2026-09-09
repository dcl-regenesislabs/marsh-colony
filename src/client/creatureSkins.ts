// Runtime creature skins. The GLBs ship TEXTURELESS (mesh only); here we assign
// each mesh a per-family base-color PNG (assets/textures/creatures/) as an UNLIT
// material via GltfNodeModifiers, picked by the pet's rarity. Applying the skin at
// runtime is what lets one mesh serve every rarity (common/rare/legendary skins).
//
// Why per-node and not a single global override: a cross model has TWO materials
// — the body (its armature family) and the head (the other family) — so each mesh
// must get ITS family's texture, or the head/body would share one skin. The node
// paths + material families below were extracted straight from the GLBs (parse of
// node -> mesh -> material); the "_head"/"_Head" casing is irregular in the source
// art, which is exactly why these are listed literally instead of derived.

import { AssetLoad, AssetLoadLoadingState, Entity, GltfNodeModifiers, Material, engine, type PBMaterial } from '@dcl/sdk/ecs'
import type { Rarity } from '../shared/types'
import { FAMILIES, type Family } from '../shared/config'

type SkinNode = { path: string; family: Family }

// species id -> the mesh nodes and which family's material each one carries.
const SKIN_NODES: Record<string, SkinNode[]> = {
  'sprout-original': [
    { path: 'SproutArmature/Sprout', family: 'sprout' },
    { path: 'SproutArmature/Sprout_head', family: 'sprout' }
  ],
  sprout_pepito: [
    { path: 'SproutArmature/Sprout', family: 'sprout' },
    { path: 'SproutArmature/Sprout_Pepito_Head', family: 'pepito' }
  ],
  sprout_amebita: [
    { path: 'SproutArmature/Sprout', family: 'sprout' },
    { path: 'SproutArmature/Sprout_Amebita_Head', family: 'amebita' }
  ],
  sprout_fluflito: [
    { path: 'SproutArmature/Sprout', family: 'sprout' },
    { path: 'SproutArmature/Sprout_Fluflito_Head', family: 'fluflito' }
  ],
  'pepito-original': [
    { path: 'PepitoArmature/Pepito', family: 'pepito' },
    { path: 'PepitoArmature/Pepito_Head', family: 'pepito' }
  ],
  pepito_sprout: [
    { path: 'PepitoArmature/Pepito', family: 'pepito' },
    { path: 'PepitoArmature/Pepito_Sprout_head', family: 'sprout' }
  ],
  pepito_amebita: [
    { path: 'PepitoArmature/Pepito', family: 'pepito' },
    { path: 'PepitoArmature/Pepito_Amebita_Head', family: 'amebita' }
  ],
  pepito_fluflito: [
    { path: 'PepitoArmature/Pepito', family: 'pepito' },
    { path: 'PepitoArmature/Pepito_Fluflito_Head', family: 'fluflito' }
  ],
  'amebita-original': [
    { path: 'AmebitaArmature/Amebita', family: 'amebita' },
    { path: 'AmebitaArmature/Amebita_Head', family: 'amebita' }
  ],
  amebita_sprout: [
    { path: 'AmebitaArmature/Amebita', family: 'amebita' },
    { path: 'AmebitaArmature/Amebita_Sprout_head', family: 'sprout' }
  ],
  amebita_pepito: [
    { path: 'AmebitaArmature/Amebita', family: 'amebita' },
    { path: 'AmebitaArmature/Amebita_Pepito_Head', family: 'pepito' }
  ],
  amebita_fluflito: [
    { path: 'AmebitaArmature/Amebita', family: 'amebita' },
    { path: 'AmebitaArmature/Amebita_Fluflito_Head', family: 'fluflito' }
  ],
  'fluflito-original': [
    { path: 'FluflitoArmature/Fluflito', family: 'fluflito' },
    { path: 'FluflitoArmature/Fluflito_Head', family: 'fluflito' }
  ],
  fluflito_sprout: [
    { path: 'FluflitoArmature/Fluflito', family: 'fluflito' },
    { path: 'FluflitoArmature/Fluflito_Sprout_head', family: 'sprout' }
  ],
  fluflito_pepito: [
    { path: 'FluflitoArmature/Fluflito', family: 'fluflito' },
    { path: 'FluflitoArmature/Fluflito_Pepito_Head', family: 'pepito' }
  ],
  fluflito_amebita: [
    { path: 'FluflitoArmature/Fluflito', family: 'fluflito' },
    { path: 'FluflitoArmature/Fluflito_Amebita_Head', family: 'amebita' }
  ]
}

// File-name prefix per family (matches the delivered assets: sprout is lower-case,
// the rest capitalized).
const FILE_PREFIX: Record<Family, string> = {
  sprout: 'sprout',
  pepito: 'Pepito',
  amebita: 'Amebita',
  fluflito: 'Fluflito'
}

/** The base-color variant each rarity tier wears — the single source of truth for
 *  both the runtime skin and the preload set, so the two can't drift apart. */
const RARITY_VARIANT: Record<Rarity, string> = {
  common: 'basecolor',
  rare: 'basecolor2',
  legendary: 'basecolorGold'
}
function variantForRarity(rarity: Rarity): string {
  return RARITY_VARIANT[rarity] ?? RARITY_VARIANT.common
}

function textureSrc(family: Family, rarity: Rarity): string {
  return `assets/textures/creatures/${FILE_PREFIX[family]}_${variantForRarity(rarity)}.png`
}

/** Every creature texture path (family × distinct variant) — the full set a pet of
 *  any family/rarity might need, derived from RARITY_VARIANT (no separate list). */
function allTextureSrcs(): string[] {
  const variants = [...new Set(Object.values(RARITY_VARIANT))]
  const out: string[] = []
  for (const fam of FAMILIES) for (const v of variants) out.push(`assets/textures/creatures/${FILE_PREFIX[fam]}_${v}.png`)
  return out
}

let preloaded = false
// AssetLoadLoadingState.currentState values (LoadingState enum) — kept as literals
// so we don't depend on the const-enum export under isolatedModules.
const LS_NOT_FOUND = 2
const LS_FINISHED_WITH_ERROR = 3
const LS_FINISHED = 4

/**
 * Warm the texture cache up front via the SDK's AssetLoad component: the renderer
 * pre-downloads and GPU-uploads the listed assets (paced by the engine, so it
 * doesn't stampede the scene's GLBs at boot), so when applyCreatureSkin later uses
 * the same src it's served from cache with no flat/untextured pop-in — the failure
 * mode was worst on mobile. Call once at client setup.
 *
 * NOTE: this warms ALL family × rarity textures (~16 MB) up front, even though a
 * given player may only need one — the trade for zero pop-in when a bred/swapped/
 * remote pet of any family or rarity shows up. Scope it down here if that memory
 * cost bites on low-end devices.
 */
export function preloadCreatureTextures(): void {
  if (preloaded) return
  preloaded = true
  const e = engine.addEntity()
  const assets = allTextureSrcs()
  AssetLoad.create(e, { assets })
  logPreloadProgress(e, assets.length)
}

/** Log the AssetLoad outcome once it settles, so a working preload can be told
 *  apart from a silently failed one on device (the renderer sets the state). */
function logPreloadProgress(entity: Entity, total: number): void {
  const finished = new Set<string>()
  const failed = new Set<string>()
  let done = false
  engine.addSystem(() => {
    if (done || !AssetLoadLoadingState.has(entity)) return
    for (const s of AssetLoadLoadingState.get(entity)) {
      if (s.currentState === LS_FINISHED) finished.add(s.asset)
      else if (s.currentState === LS_NOT_FOUND || s.currentState === LS_FINISHED_WITH_ERROR) failed.add(s.asset)
    }
    if (finished.size + failed.size >= total) {
      done = true
      console.log(`[creatureSkins] texture preload settled: ${finished.size}/${total} cached${failed.size ? `, ${failed.size} FAILED -> ${[...failed].join(', ')}` : ''}`)
    }
  })
}

/** An UNLIT material carrying just the base-color texture. Unlit shows the art
 *  flat at full brightness and identical on desktop and mobile — a PBR/albedo
 *  material renders much darker on mobile under the scene's lighting/tone-mapping,
 *  which is what made the new skins look almost black on phones. */
function skinMaterial(src: string): PBMaterial {
  return {
    material: {
      $case: 'unlit',
      unlit: { texture: Material.Texture.Common({ src }) }
    }
  }
}

/**
 * Override a creature entity's materials with the family/rarity base-color skins.
 * Call right after GltfContainer.createOrReplace on the entity. Species without a
 * skin entry (aliens) are left untouched.
 */
export function applyCreatureSkin(entity: Entity, species: string, rarity: Rarity): void {
  const nodes = SKIN_NODES[species]
  if (!nodes) {
    // No skin for this species (e.g. an alien). Clear any override the entity
    // carried from a previous species so a stale one doesn't linger on a reuse.
    GltfNodeModifiers.deleteFrom(entity)
    return
  }
  GltfNodeModifiers.createOrReplace(entity, {
    modifiers: nodes.map((n) => ({ path: n.path, material: skinMaterial(textureSrc(n.family, rarity)) }))
  })
}

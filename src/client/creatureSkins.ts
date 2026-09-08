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

import { AvatarAnchorPointType, AvatarAttach, Entity, GltfNodeModifiers, Material, MeshRenderer, Transform, engine, type PBMaterial } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
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

/** Which base-color variant a rarity uses. Three skins per family were delivered. */
function variantForRarity(rarity: Rarity): string {
  if (rarity === 'legendary') return 'basecolorGold'
  if (rarity === 'rare') return 'basecolor2'
  return 'basecolor' // common
}

function textureSrc(family: Family, rarity: Rarity): string {
  return `assets/textures/creatures/${FILE_PREFIX[family]}_${variantForRarity(rarity)}.png`
}

// Every base-color variant a creature can wear (one per rarity tier).
const TEXTURE_VARIANTS = ['basecolor', 'basecolor2', 'basecolorGold']

/** Every creature texture path (family × variant) — the full set a pet might need. */
function allTextureSrcs(): string[] {
  const out: string[] = []
  for (const fam of FAMILIES) for (const v of TEXTURE_VARIANTS) out.push(`assets/textures/creatures/${FILE_PREFIX[fam]}_${v}.png`)
  return out
}

let preloaded = false
/**
 * Warm the texture cache up front. The GLBs ship textureless and get their skin
 * applied at runtime; without this the PNG downloads only WHEN a pet first needs
 * it, so the pet renders flat/untextured for a beat and then pops in (worst on
 * mobile). Here we spawn one tiny plane per texture and ATTACH each to the player
 * avatar: that keeps them in-bounds and right by the camera, so the renderer
 * actually draws them and uploads the textures to the GPU (a plane parked far
 * off/out-of-bounds may get culled on mobile and never upload). They're 1 cm, so
 * they're invisible in practice, and kept alive so the textures stay referenced
 * (not evicted). applyCreatureSkin then reuses the same src straight from cache.
 * Call once at client setup.
 */
export function preloadCreatureTextures(): void {
  if (preloaded) return
  preloaded = true
  for (const src of allTextureSrcs()) {
    const e = engine.addEntity()
    Transform.create(e, { scale: Vector3.create(0.01, 0.01, 0.01) })
    MeshRenderer.setPlane(e)
    Material.setBasicMaterial(e, { texture: Material.Texture.Common({ src }) })
    AvatarAttach.create(e, { anchorPointId: AvatarAnchorPointType.AAPT_POSITION }) // ride the avatar: in-bounds + near camera so it really uploads
  }
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

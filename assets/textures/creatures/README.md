# Creature textures (runtime material overrides)

New creature skins go **here** as PNGs, referenced from the scene as
`assets/textures/creatures/<file>.png`.

These are applied at runtime via the `GltfNodeModifiers` component on the pet
entity (see `src/client/pet.ts`) — the creature GLBs keep their embedded
textures; this just overrides the material with the new skin. So you do NOT need
to re-export the GLBs; just drop the PNGs here and tell us the mapping.

## Guidelines
- PNG, power-of-two size (512×512 or 1024×1024) to keep the scene light.
- One skin per creature family, or per species/cross — your call; tell us which.

## Mapping (fill in as textures land)
| File | Applies to (family / species) | Notes |
| ---- | ----------------------------- | ----- |
|      |                               |       |

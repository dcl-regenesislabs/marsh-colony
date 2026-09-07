// Martian scene boundaries — ported from the `skybox-test` project.
//
// Everything here is created by code (not placed in the Creator Hub): the
// "here" anchor marker and the 4 boundary planes. Gameplay objects sit at
// y=0. The visible ground is the floormash01.glb model placed in the Creator
// Hub composite — its footprint is smaller than these boundary planes, not a
// 1:1 match (the old code-generated grass plane used to match this exactly,
// but that's gone now — see the fix/dark-floor-on-mobile PR).
//
// The gameplay area (Bowl/Bed/Ball/Pond/Caretaker/Shop) was moved in
// `main.composite` to sit around the "here" anchor below — see `shared/config.ts`.

import { engine, Transform, MeshCollider, ColliderLayer } from '@dcl/sdk/ecs'
import { Vector3, Quaternion } from '@dcl/sdk/math'

// --- Configuration (positions copied verbatim from skybox-test's main.composite —
// My Dear Pet now uses the same 30x30 parcel layout, so no translation is needed). ---

// The empty "here" anchor entity — the center of the relocated gameplay area.
const HERE_POSITION = Vector3.create(204.5, 0.5, 241)

interface PlaneDef {
  x: number
  y: number
  z: number
  scale: Vector3
  rotation: Quaternion
}

const BOUNDARY_PLANES: PlaneDef[] = [
  { x: 217.25, y: 18, z: 371.25, scale: Vector3.create(300, 30, 1), rotation: Quaternion.Identity() },
  { x: 67.25, y: 18, z: 221.5, scale: Vector3.create(30, 300, 1), rotation: Quaternion.create(-0.5, -0.5, 0.5, 0.5) },
  { x: 217.25, y: 18, z: 71.5, scale: Vector3.create(300, 30, 1), rotation: Quaternion.Identity() },
  { x: 367.25, y: 18, z: 221.5, scale: Vector3.create(30, 300, 1), rotation: Quaternion.create(-0.5, -0.5, 0.5, 0.5) }
]

export function setupSkybox() {
  createHereMarker()
  createBoundaryPlanes()
}

// Just a reference point for the play area's center — no visual, no collider,
// so it doesn't block the player walking through the care area.
function createHereMarker() {
  const here = engine.addEntity()
  Transform.create(here, { position: HERE_POSITION })
}

function createBoundaryPlanes() {
  for (const def of BOUNDARY_PLANES) {
    const plane = engine.addEntity()
    Transform.create(plane, {
      position: Vector3.create(def.x, def.y, def.z),
      scale: def.scale,
      rotation: def.rotation
    })
    MeshCollider.setPlane(plane, ColliderLayer.CL_PHYSICS)
  }
}

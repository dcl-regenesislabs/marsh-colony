// DEBUG placement helper: a movable glowing cube for dialing in world positions
// (the breeding-nest bowls + egg spot, or any spot). Move it with the keys below;
// click it (or press SPACE) to print its world Transform AND its offset from the
// DualNest origin — that offset is exactly what the BREED_*_OFF constants in
// pet.ts want, so you can read the numbers straight off the console.
//
// NOT for production — remove the setupDebugCube() call in setup.ts to ship.
//
// Controls (move continuously while the key is held):
//   1 / 2  ->  -X / +X   (sideways)
//   3 / 4  ->  -Z / +Z   (forward / back)
//   E / F  ->  +Y / -Y   (up / down)
//   hold SHIFT           ->  move 4x faster for big jumps
//   SPACE  or  click the cube  ->  print transform + offset from the nest

import {
  engine,
  Transform,
  MeshRenderer,
  MeshCollider,
  Material,
  TextShape,
  Billboard,
  BillboardMode,
  ColliderLayer,
  pointerEventsSystem,
  inputSystem,
  InputAction,
  PointerEventType,
  Entity
} from '@dcl/sdk/ecs'
import { Vector3, Color3, Color4 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { objectPosition } from './objects'

const MOVE_SPEED = 1.4 // metres/sec while a direction key is held
const FAST_MULT = 4 // hold SHIFT (walk) for big jumps
const START = Vector3.create(138, 4, 248.25) // near the DualNest — tune outward from here
const NEST = EntityNames.DualNest01_glb_2 // the nest whose origin the offset is reported against

let cube: Entity | null = null
let cubeLabel: Entity | null = null

function fmt(v: Vector3): string {
  return `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`
}

/** Log the cube's world position and its offset from the nest origin (the value
 *  the BREED_BOWL_A_OFF / BREED_BOWL_B_OFF / BREED_EGG_OFF constants expect). */
function printCube(): void {
  if (cube === null) return
  const pos = Transform.get(cube).position
  const nest = objectPosition(NEST)
  const off = Vector3.create(pos.x - nest.x, pos.y - nest.y, pos.z - nest.z)
  console.log(`[DEBUG CUBE] world = ${fmt(pos)}  |  offset from nest ${fmt(nest)} = ${fmt(off)}  <- Vector3.create${fmt(off)}`)
}

export function setupDebugCube(): void {
  const e = engine.addEntity()
  cube = e
  Transform.create(e, { position: START, scale: Vector3.create(0.5, 0.5, 0.5) })
  MeshRenderer.setBox(e)
  MeshCollider.setBox(e, ColliderLayer.CL_POINTER) // clickable, never blocks movement
  Material.setPbrMaterial(e, {
    albedoColor: Color4.create(1, 0.85, 0.1, 1),
    emissiveColor: Color3.create(1, 0.8, 0.1),
    emissiveIntensity: 3
  })

  const label = engine.addEntity()
  cubeLabel = label
  Transform.create(label, { position: Vector3.create(START.x, START.y + 0.45, START.z) })
  TextShape.create(label, {
    text: 'DEBUG CUBE\n1/2:X  3/4:Z  E/F:Y  SHIFT:fast\nSPACE / click: print',
    fontSize: 1.3,
    textColor: Color4.White(),
    outlineColor: Color4.Black(),
    outlineWidth: 0.2
  })
  Billboard.create(label, { billboardMode: BillboardMode.BM_Y })

  pointerEventsSystem.onPointerDown(
    { entity: e, opts: { button: InputAction.IA_POINTER, hoverText: 'DEBUG: print transform', maxDistance: 32 } },
    () => printCube()
  )

  engine.addSystem((dt: number) => {
    if (cube === null) return
    const t = Transform.getMutable(cube)
    const speed = MOVE_SPEED * (inputSystem.isPressed(InputAction.IA_WALK) ? FAST_MULT : 1) * dt
    let moved = false
    if (inputSystem.isPressed(InputAction.IA_ACTION_4)) { t.position.x += speed; moved = true } // 2
    if (inputSystem.isPressed(InputAction.IA_ACTION_3)) { t.position.x -= speed; moved = true } // 1
    if (inputSystem.isPressed(InputAction.IA_ACTION_6)) { t.position.z += speed; moved = true } // 4
    if (inputSystem.isPressed(InputAction.IA_ACTION_5)) { t.position.z -= speed; moved = true } // 3
    if (inputSystem.isPressed(InputAction.IA_PRIMARY)) { t.position.y += speed; moved = true } // E
    if (inputSystem.isPressed(InputAction.IA_SECONDARY)) { t.position.y -= speed; moved = true } // F
    if (moved && cubeLabel !== null) {
      Transform.getMutable(cubeLabel).position = Vector3.create(t.position.x, t.position.y + 0.45, t.position.z)
    }
    if (inputSystem.isTriggered(InputAction.IA_JUMP, PointerEventType.PET_DOWN)) printCube() // SPACE
  })
}

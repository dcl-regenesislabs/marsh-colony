// Physical scoreboards on LeaderBoard01.glb — two side-by-side blocks of top-5
// rows, each row: [avatar face] [name] ----- [value].
//   • LEFT block  = top-5 players by caretaker XP (clientState.leaderboardXp).
//   • RIGHT block = top-5 ark contributors — PLACEHOLDER for now (that data, ark
//     redemptions, doesn't exist yet). Same orientation as the left block.
//
// Each row element is an UNPARENTED entity at an absolute world position, computed
// as anchor + rotate(localOffset, anchorRot) — offsets are in metres in the block's
// local frame: +X across the face, +Y up, +Z out. (Parenting to a runtime rig
// rendered nothing in the Unity explorer, so we place absolute + unparented, like
// debugGrow.) TextShape is single-sided, so the readable facing is the anchor yaw.

import {
  engine,
  Entity,
  Transform,
  TextShape,
  TextAlignMode,
  MeshRenderer,
  Material,
  VisibilityComponent,
  Billboard,
  BillboardMode,
  inputSystem,
  InputAction,
  PointerEventType
} from '@dcl/sdk/ecs'
import { getPlayer } from '@dcl/sdk/players'
import { Vector3, Quaternion, Color4 } from '@dcl/sdk/math'
import { actions, clientState } from './state'

const ROWS = 5 // top-5

// Anchors = the CENTRE of each panel's text area + its facing yaw, dialled in-world
// with the placement tuner. LEFT is done; RIGHT is an estimate to be tuned.
const ANCHOR_L_POS = Vector3.create(151.21, 3.81, 224.1)
const ANCHOR_L_YAW = 225
const ANCHOR_R_POS = Vector3.create(147.28, 3.75, 228.12)
const ANCHOR_R_YAW = 225

// ---- Layout tunables (metres, in a block's local frame) ----------------------
const ROW_STEP = 0.5 // vertical gap between rows (5 rows centred on the anchor)
const FACE_OUT = 0.15 // how far every element floats off the panel surface (+Z)
const FACE_X = -1.35 // avatar face column (left)
const NAME_X = -1.05 // name starts here (left-aligned)
const DASH_X = 0.2 // the "-----" filler, centred here
const XP_X = 1.35 // value ends here (right-aligned)
const FACE_SIZE = 0.4 // avatar face plane side length
// In-world TextShape fontSize is ~2–3 (NOT metres / the UI's px scale) — small
// values render invisibly tiny.
const NAME_SIZE = 1.6
const XP_SIZE = 1.6
const DASH_SIZE = 1.3
const DASHES = '----------'

const REFRESH_S = 30 // standings refresh cadence (server also rate-limits)
const FIRST_REQUEST_S = 3

// DEBUG: fill the XP block's 5 rows with the local player, to dial the layout in
// without 5 real ranked players. Set false to ship.
const DEBUG_ALL_FIRST_PLAYER = false

const NAME_COLOR = Color4.create(1, 1, 1, 1)
const XP_COLOR = Color4.create(1, 0.86, 0.3, 1) // gold
const DASH_COLOR = Color4.create(0.75, 0.78, 0.85, 1)
const DIM_COLOR = Color4.create(0.7, 0.72, 0.78, 1) // placeholder text
const OUTLINE = Color4.create(0, 0, 0, 1)

type Row = { face: Entity; name: Entity; dash: Entity; xp: Entity; address: string }
type Kind = 'xp' | 'placeholder'
type Block = { kind: Kind; rows: Row[]; pos: Vector3; rot: Quaternion; shownKey: string }

// Absolute world position of a block-local point, and the block's content rotation.
function worldOf(b: Block, x: number, y: number, z: number): Vector3 {
  return Vector3.add(b.pos, Vector3.rotate(Vector3.create(x, y, z), b.rot))
}
function rowY(i: number): number {
  return ((ROWS - 1) / 2 - i) * ROW_STEP // centre the block on the anchor
}

function makeText(b: Block, x: number, y: number, size: number, color: Color4, align: TextAlignMode): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: worldOf(b, x, y, FACE_OUT), rotation: b.rot })
  TextShape.create(e, { text: '', fontSize: size, textColor: color, outlineColor: OUTLINE, outlineWidth: 0.15, textAlign: align })
  return e
}

function makeFace(b: Block, x: number, y: number): Entity {
  const e = engine.addEntity()
  Transform.create(e, { position: worldOf(b, x, y, FACE_OUT), rotation: b.rot, scale: Vector3.create(FACE_SIZE, FACE_SIZE, 1) })
  MeshRenderer.setPlane(e)
  VisibilityComponent.create(e, { visible: false }) // shown once an avatar is assigned
  return e
}

function buildBlock(kind: Kind, pos: Vector3, yaw: number): Block {
  const b: Block = { kind, rows: [], pos, rot: Quaternion.fromEulerDegrees(0, yaw, 0), shownKey: '' }
  for (let i = 0; i < ROWS; i++) {
    const y = rowY(i)
    b.rows.push({
      face: makeFace(b, FACE_X, y),
      name: makeText(b, NAME_X, y, NAME_SIZE, NAME_COLOR, TextAlignMode.TAM_MIDDLE_LEFT),
      dash: makeText(b, DASH_X, y, DASH_SIZE, DASH_COLOR, TextAlignMode.TAM_MIDDLE_CENTER),
      xp: makeText(b, XP_X, y, XP_SIZE, XP_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT),
      address: ''
    })
  }
  return b
}

// Re-apply the block's current pos/rot to its row entities (used live by the tuner).
function layoutBlock(b: Block): void {
  b.rows.forEach((row, i) => {
    const y = rowY(i)
    Transform.getMutable(row.face).position = worldOf(b, FACE_X, y, FACE_OUT)
    Transform.getMutable(row.face).rotation = b.rot
    Transform.getMutable(row.name).position = worldOf(b, NAME_X, y, FACE_OUT)
    Transform.getMutable(row.name).rotation = b.rot
    Transform.getMutable(row.dash).position = worldOf(b, DASH_X, y, FACE_OUT)
    Transform.getMutable(row.dash).rotation = b.rot
    Transform.getMutable(row.xp).position = worldOf(b, XP_X, y, FACE_OUT)
    Transform.getMutable(row.xp).rotation = b.rot
  })
}

function xpData(): { address: string; name: string; xp: number }[] {
  if (DEBUG_ALL_FIRST_PLAYER) {
    const me = getPlayer()
    if (!me) return []
    const one = { address: me.userId, name: me.name, xp: clientState.player?.caretakerXp ?? 0 }
    return Array.from({ length: ROWS }, () => one)
  }
  return clientState.leaderboardXp.slice(0, ROWS).map((e) => ({ address: e.address, name: e.name, xp: e.xp }))
}

function refreshBlock(b: Block): void {
  // PLACEHOLDER block: static "coming soon" rows, no avatars, no polling.
  if (b.kind === 'placeholder') {
    if (b.shownKey === 'ph') return
    b.shownKey = 'ph'
    b.rows.forEach((row, i) => {
      TextShape.getMutable(row.name).text = `#${i + 1}`
      TextShape.getMutable(row.name).textColor = DIM_COLOR
      TextShape.getMutable(row.dash).text = DASHES
      TextShape.getMutable(row.xp).text = 'soon'
      TextShape.getMutable(row.xp).textColor = DIM_COLOR
      VisibilityComponent.getMutable(row.face).visible = false
    })
    return
  }

  const data = xpData()
  const key = data.map((r) => `${r.address}:${r.name}:${r.xp}`).join('|')
  if (key === b.shownKey) return
  b.shownKey = key

  b.rows.forEach((row, i) => {
    const r = data[i]
    if (!r) {
      TextShape.getMutable(row.name).text = ''
      TextShape.getMutable(row.dash).text = ''
      TextShape.getMutable(row.xp).text = ''
      VisibilityComponent.getMutable(row.face).visible = false
      row.address = ''
      return
    }
    TextShape.getMutable(row.name).text = `#${i + 1}  ${r.name}`
    TextShape.getMutable(row.dash).text = DASHES
    TextShape.getMutable(row.xp).text = `${r.xp} XP`
    if (r.address !== row.address) {
      row.address = r.address
      Material.setBasicMaterial(row.face, { texture: Material.Texture.Avatar({ userId: r.address }) })
      VisibilityComponent.getMutable(row.face).visible = true
    }
  })
}

// ---------------------------------------------------------------------------
// DEBUG placement tuner. Drives ONE block (TUNE_BLOCK) so it can be dropped onto
// its panel, then LEFT-CLICK logs its anchor. Set DEBUG_TUNER false to ship.
// Keys (hold): E/F = +X/-X · 1/2 = +Z/-Z · 3/4 = +Y/-Y · SPACE = rotate +15° ·
//              LEFT-CLICK = log the anchor.
// ---------------------------------------------------------------------------
const DEBUG_TUNER = false
const TUNE_BLOCK: Kind = 'placeholder' // which block the tuner drives
const TUNE_MOVE_SPEED = 1.2

let tuneLabel: Entity | null = null
const tunePos = { x: 0, y: 0, z: 0 }
let tuneYaw = 0

function beginTuner(b: Block): void {
  tunePos.x = b.pos.x
  tunePos.y = b.pos.y
  tunePos.z = b.pos.z
  tuneYaw = ANCHOR_R_YAW
  tuneLabel = engine.addEntity()
  Transform.create(tuneLabel, { position: Vector3.create(tunePos.x, tunePos.y + 1.5, tunePos.z) })
  TextShape.create(tuneLabel, { text: '', fontSize: 2, textColor: Color4.create(1, 1, 0, 1), outlineColor: OUTLINE, outlineWidth: 0.2 })
  Billboard.create(tuneLabel, { billboardMode: BillboardMode.BM_Y })
}

function updateTuner(dt: number, b: Block): void {
  const move = TUNE_MOVE_SPEED * dt
  if (inputSystem.isPressed(InputAction.IA_PRIMARY)) tunePos.x += move // E
  if (inputSystem.isPressed(InputAction.IA_SECONDARY)) tunePos.x -= move // F
  if (inputSystem.isPressed(InputAction.IA_ACTION_3)) tunePos.z += move // 1
  if (inputSystem.isPressed(InputAction.IA_ACTION_4)) tunePos.z -= move // 2
  if (inputSystem.isPressed(InputAction.IA_ACTION_5)) tunePos.y += move // 3 (up)
  if (inputSystem.isPressed(InputAction.IA_ACTION_6)) tunePos.y -= move // 4 (down)
  if (inputSystem.isTriggered(InputAction.IA_JUMP, PointerEventType.PET_DOWN)) tuneYaw += 15 // Space

  b.pos = Vector3.create(tunePos.x, tunePos.y, tunePos.z)
  b.rot = Quaternion.fromEulerDegrees(0, tuneYaw, 0)
  layoutBlock(b)

  const yaw = ((tuneYaw % 360) + 360) % 360
  if (tuneLabel) {
    Transform.getMutable(tuneLabel).position = Vector3.create(tunePos.x, tunePos.y + 1.5, tunePos.z)
    TextShape.getMutable(tuneLabel).text = `x ${tunePos.x.toFixed(2)}  y ${tunePos.y.toFixed(2)}  z ${tunePos.z.toFixed(2)}\nyaw ${yaw.toFixed(0)}`
  }
  if (inputSystem.isTriggered(InputAction.IA_POINTER, PointerEventType.PET_DOWN)) {
    console.log(`[Scoreboard] PLACEMENT  pos=Vector3.create(${tunePos.x.toFixed(2)}, ${tunePos.y.toFixed(2)}, ${tunePos.z.toFixed(2)})  yaw=${yaw.toFixed(1)}`)
  }
}

let blocks: Block[] | null = null
let timer = 0
let requestedOnce = false

export function setupScoreboard(): void {
  engine.addSystem((dt: number) => {
    if (!blocks) {
      blocks = [buildBlock('xp', ANCHOR_L_POS, ANCHOR_L_YAW), buildBlock('placeholder', ANCHOR_R_POS, ANCHOR_R_YAW)]
      if (DEBUG_TUNER) beginTuner(blocks.find((b) => b.kind === TUNE_BLOCK)!)
      return
    }
    for (const b of blocks) refreshBlock(b)

    if (DEBUG_TUNER) {
      const target = blocks.find((b) => b.kind === TUNE_BLOCK)
      if (target) updateTuner(dt, target)
      return
    }

    timer += dt
    const due = requestedOnce ? REFRESH_S : FIRST_REQUEST_S
    if (timer >= due) {
      timer = 0
      requestedOnce = true
      try {
        actions.requestLeaderboardXp()
      } catch (e) {
        console.log('[Scoreboard] leaderboard request failed', e)
      }
    }
  })
}

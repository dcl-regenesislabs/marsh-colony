// Physical XP scoreboard on LeaderBoard01.glb: a title on top and the top 10
// players by caretaker XP (clientState.leaderboardXp) split over the two
// panels, #1-5 on the left and #6-10 on the right. Each row is
// [avatar face] [#rank] [name] ... [XP], laid out symmetric around the centre
// of its panel.
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
import { t } from './i18n'
import { mobile } from './ui/theme'
import { requestPlayerFace, getPlayerFaceUrl } from './snapshots'
import { SCOREBOARD_ROWS, SCOREBOARD_TOP, scoreboardName, scoreboardPage, scoreboardXp } from './scoreboardLayout'

// Anchors = the CENTRE of each panel's text area + its facing yaw, dialled in-world
// with the placement tuner.
const ANCHOR_L_POS = Vector3.create(151.21, 3.81, 224.1)
const ANCHOR_L_YAW = 225
const ANCHOR_R_POS = Vector3.create(147.28, 3.75, 228.12)
const ANCHOR_R_YAW = 225

// ---- Layout tunables (metres, in a block's local frame) ----------------------
const ROW_STEP = 0.5 // vertical gap between rows (5 rows centred on the anchor)
const FACE_OUT = 0.15 // how far every element floats off the panel surface (+Z)
// Columns, symmetric around the panel centre (content spans about -1.75..+1.75).
const FACE_X = -1.55 // avatar face, centred here
const RANK_X = -0.85 // "#10" ends here (right-aligned, so #1 and #10 line up)
const NAME_X = -0.7 // name starts here (left-aligned)
const XP_X = 1.75 // value ends here (right-aligned; at most "99999 XP")
const FACE_SIZE = 0.4 // avatar face plane side length
// In-world TextShape fontSize is ~2–3 (NOT metres / the UI's px scale) — small
// values render invisibly tiny.
const RANK_SIZE = 2.2
const NAME_SIZE = 2.2
const XP_SIZE = 2.2

// Title: one line centred over both panels, on the board's top frame.
const TITLE_RISE = 1.55 // metres above the anchors' centre
const TITLE_SIZE = 3.2

const REFRESH_S = 30 // standings refresh cadence (server also rate-limits)
const FIRST_REQUEST_S = 3

// DEBUG: show 10 fake players (long names, very big XP) instead of the real
// standings, to check the layout in-world. Faces use the local player's
// avatar. Set false to ship.
const DEBUG_FILL_ROWS = false
const DEBUG_PLAYERS: { name: string; xp: number }[] = [
  { name: 'Wwwwwwwwww', xp: 1_250_000_000 },
  { name: 'MetaMonkey', xp: 25_400_000 },
  { name: 'BitMan', xp: 1_250_000 },
  { name: 'GiorgioMdz', xp: 999_999 },
  { name: 'Fredar', xp: 123_456 },
  { name: 'PeterPan', xp: 99_999 },
  { name: '7color', xp: 14_944 },
  { name: 'Gon', xp: 6458 },
  { name: 'Agus mobile', xp: 2962 },
  { name: 'Mmmmmmm', xp: 88_888 }
]

const TITLE_COLOR = Color4.create(1, 0.86, 0.3, 1) // gold
const RANK_COLOR = Color4.create(1, 0.86, 0.3, 1)
const NAME_COLOR = Color4.create(1, 1, 1, 1)
const XP_COLOR = Color4.create(1, 0.86, 0.3, 1)
const OUTLINE = Color4.create(0, 0, 0, 1)

type Row = { face: Entity; rank: Entity; name: Entity; xp: Entity; address: string; faceUrl: string }
const FACE_PLACEHOLDER = Color4.create(0.28, 0.3, 0.36, 1) // shown while the face loads
type Block = { panel: number; rows: Row[]; pos: Vector3; rot: Quaternion; shownKey: string }

// Absolute world position of a block-local point, and the block's content rotation.
function worldOf(b: Block, x: number, y: number, z: number): Vector3 {
  return Vector3.add(b.pos, Vector3.rotate(Vector3.create(x, y, z), b.rot))
}
function rowY(i: number): number {
  return ((SCOREBOARD_ROWS - 1) / 2 - i) * ROW_STEP // centre the block on the anchor
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

function buildBlock(panel: number, pos: Vector3, yaw: number): Block {
  const b: Block = { panel, rows: [], pos, rot: Quaternion.fromEulerDegrees(0, yaw, 0), shownKey: '' }
  for (let i = 0; i < SCOREBOARD_ROWS; i++) {
    const y = rowY(i)
    b.rows.push({
      face: makeFace(b, FACE_X, y),
      rank: makeText(b, RANK_X, y, RANK_SIZE, RANK_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT),
      name: makeText(b, NAME_X, y, NAME_SIZE, NAME_COLOR, TextAlignMode.TAM_MIDDLE_LEFT),
      xp: makeText(b, XP_X, y, XP_SIZE, XP_COLOR, TextAlignMode.TAM_MIDDLE_RIGHT),
      address: '',
      faceUrl: ''
    })
  }
  return b
}

let title: Entity | null = null
function buildTitle(): Entity {
  const e = engine.addEntity()
  const mid = Vector3.lerp(ANCHOR_L_POS, ANCHOR_R_POS, 0.5)
  const rot = Quaternion.fromEulerDegrees(0, ANCHOR_L_YAW, 0)
  const position = Vector3.add(mid, Vector3.rotate(Vector3.create(0, TITLE_RISE, FACE_OUT), rot))
  Transform.create(e, { position, rotation: rot })
  TextShape.create(e, {
    text: '', fontSize: TITLE_SIZE, textColor: TITLE_COLOR, outlineColor: OUTLINE, outlineWidth: 0.2, textAlign: TextAlignMode.TAM_MIDDLE_CENTER
  })
  return e
}
function refreshTitle(): void {
  if (!title) return
  const text = t('leaderboard.title') // follows the language picker
  if (TextShape.get(title).text !== text) TextShape.getMutable(title).text = text
}

// Re-apply the block's current pos/rot to its row entities (used live by the tuner).
function layoutBlock(b: Block): void {
  b.rows.forEach((row, i) => {
    const y = rowY(i)
    const place = (e: Entity, x: number): void => {
      Transform.getMutable(e).position = worldOf(b, x, y, FACE_OUT)
      Transform.getMutable(e).rotation = b.rot
    }
    place(row.face, FACE_X)
    place(row.rank, RANK_X)
    place(row.name, NAME_X)
    place(row.xp, XP_X)
  })
}

function xpData(): { address: string; name: string; xp: number }[] {
  if (DEBUG_FILL_ROWS) {
    const me = getPlayer()
    if (!me) return []
    // Sorted like the server does, so the ranks read in order.
    return [...DEBUG_PLAYERS].sort((a, b) => b.xp - a.xp).map((p) => ({ address: me.userId, name: p.name, xp: p.xp }))
  }
  return clientState.leaderboardXp.slice(0, SCOREBOARD_TOP).map((e) => ({ address: e.address, name: e.name, xp: e.xp }))
}

function clearRow(row: Row): void {
  TextShape.getMutable(row.rank).text = ''
  TextShape.getMutable(row.name).text = ''
  TextShape.getMutable(row.xp).text = ''
  VisibilityComponent.getMutable(row.face).visible = false
  row.address = ''
  row.faceUrl = ''
}

function refreshBlock(b: Block): void {
  const data = scoreboardPage(xpData(), b.panel)
  const small = mobile()
  const key = `${small}|` + data.map((r) => `${r.address}:${r.name}:${r.xp}`).join('|')
  if (key === b.shownKey) return
  b.shownKey = key

  b.rows.forEach((row, i) => {
    const r = data[i]
    if (!r) return clearRow(row)
    TextShape.getMutable(row.rank).text = `#${b.panel * SCOREBOARD_ROWS + i + 1}`
    TextShape.getMutable(row.name).text = scoreboardName(r.name, small)
    TextShape.getMutable(row.xp).text = `${scoreboardXp(r.xp)} XP`
    // Faces come from the profile snapshot (face256.png) over HTTP — works on all
    // clients. Kick off the fetch and show a placeholder tile until it resolves;
    // updateFaces() swaps in the texture once the URL is ready.
    if (r.address !== row.address) {
      row.address = r.address
      row.faceUrl = ''
      requestPlayerFace(r.address)
      Material.setBasicMaterial(row.face, { diffuseColor: FACE_PLACEHOLDER })
      VisibilityComponent.getMutable(row.face).visible = true
    }
  })
}

// Swap the placeholder tile for the real face once its snapshot URL resolves.
function updateFaces(b: Block): void {
  for (const row of b.rows) {
    if (!row.address) continue
    const url = getPlayerFaceUrl(row.address)
    if (url && url !== row.faceUrl) {
      row.faceUrl = url
      Material.setBasicMaterial(row.face, { texture: Material.Texture.Common({ src: url }) })
    }
  }
}

// ---------------------------------------------------------------------------
// DEBUG placement tuner. Drives ONE block (TUNE_PANEL) so it can be dropped onto
// its panel, then LEFT-CLICK logs its anchor. Set DEBUG_TUNER false to ship.
// Keys (hold): E/F = +X/-X · 1/2 = +Z/-Z · 3/4 = +Y/-Y · SPACE = rotate +15° ·
//              LEFT-CLICK = log the anchor.
// ---------------------------------------------------------------------------
const DEBUG_TUNER = false
const TUNE_PANEL = 1 // which block the tuner drives (0 = left, 1 = right)
const TUNE_MOVE_SPEED = 1.2

let tuneLabel: Entity | null = null
const tunePos = { x: 0, y: 0, z: 0 }
let tuneYaw = 0

function beginTuner(b: Block): void {
  tunePos.x = b.pos.x
  tunePos.y = b.pos.y
  tunePos.z = b.pos.z
  tuneYaw = b.panel === 0 ? ANCHOR_L_YAW : ANCHOR_R_YAW
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
      blocks = [buildBlock(0, ANCHOR_L_POS, ANCHOR_L_YAW), buildBlock(1, ANCHOR_R_POS, ANCHOR_R_YAW)]
      title = buildTitle()
      if (DEBUG_TUNER) beginTuner(blocks[TUNE_PANEL])
      return
    }
    refreshTitle()
    for (const b of blocks) {
      refreshBlock(b)
      updateFaces(b) // swap in profile faces as they resolve
    }

    if (DEBUG_TUNER) {
      updateTuner(dt, blocks[TUNE_PANEL])
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

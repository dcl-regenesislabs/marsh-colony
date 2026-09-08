// Sets up the Caretaker's click interaction and Idle/Talk animation clip
// switching based on whether its dialog is currently open.

import { engine, Entity, Transform, Animator, pointerEventsSystem, InputAction, InputModifier } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { movePlayerTo } from '~system/RestrictedActions'
import { EntityNames } from '../../assets/scene/entity-names'
import { clientState } from './state'
import { ui } from './ui'

// Clip names as authored on the Caretaker.glb / auto-populated by the Creator
// Hub's Animator (assets/scene/main.composite) — case-sensitive.
const CLIP_IDLE = 'Idle'
const CLIP_TALK = 'Talk'

let curClip: string | null = null

function setClip(e: Entity, clip: string): void {
  if (curClip === clip) return
  curClip = clip
  const a = Animator.getMutable(e)
  for (const s of a.states) s.playing = s.clip === clip
}

let clickHandlerSet = false

/** The Caretaker GLB supplies its own collider. Attach the pointer event to the
 *  model entity itself so its collider shape receives the interaction. */
function ensureClickHandler(caretaker: Entity): void {
  if (clickHandlerSet) return
  clickHandlerSet = true
  pointerEventsSystem.onPointerDown(
    { entity: caretaker, opts: { button: InputAction.IA_POINTER, hoverText: 'Talk to Caretaker', maxDistance: 16, showHighlight: true } },
    () => ui.openCaretaker()
  )
}

// Mandatory placement for the first-time intro: the native SceneMetadata
// spawn point only orients the CAMERA (cameraTarget), not the avatar's own
// facing — the two can end up pointing different ways, and the random
// position range means it's not the exact same spot every reload either.
// movePlayerTo's cameraTarget rotates both, so this deterministically drops
// the player at the spawn area's center facing the Caretaker (matching the
// spawn point's own cameraTarget in main.composite) every single time, then
// freezes them until they've finished talking (setup.ts's showIntro).
// Match the SpawnArea1 floor height from main.composite so the forced intro
// teleport lands on the Care Center floor instead of below it.
const INTRO_SPAWN_POS = Vector3.create(155.9199981689453, 0.5, 247.05999755859375)
// The Caretaker's OLD position (before it got moved further along its own
// facing direction) — kept as the look-at anchor on purpose, per request.
const INTRO_LOOK_AT = Vector3.create(153.5, 1.5, 247.25)

let introLockActive = false

export function startCaretakerIntroLock(): void {
  void movePlayerTo({ newRelativePosition: INTRO_SPAWN_POS, cameraTarget: INTRO_LOOK_AT })
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  introLockActive = true
}

/** Release the freeze once the intro dialog closes. */
export function endCaretakerIntroLock(): void {
  introLockActive = false
  if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
}

/** setup.ts's loading-gate unfreeze fires the moment serverReady flips true —
 *  the SAME message handler that starts this lock — so it must check this
 *  before blindly deleting InputModifier, or it wipes the freeze we just set
 *  a few lines earlier in the same handler. */
export function isCaretakerIntroLocked(): boolean {
  return introLockActive
}

export function setupCaretaker(): void {
  engine.addSystem(() => {
    const e = engine.getEntityOrNullByName(EntityNames.Caretaker_glb)
    if (!e || !Transform.has(e)) return // not loaded yet
    ensureClickHandler(e)
    if (Animator.has(e)) {
      const talking = clientState.dialog.open && clientState.dialog.npcName === 'Caretaker'
      setClip(e, talking ? CLIP_TALK : CLIP_IDLE)
    }
  })
}

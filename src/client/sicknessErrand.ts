// Sickness errand (issue #148). A pet gets sick by catching a poisonous fruit
// in the Feed minigame (fruitGame.ts). When such a round ends, fruitGame.ts calls
// startSicknessCinematic() below, which queues the cinematic (the server's own
// "pet turned sick" notify can't be the trigger: it's only sent when the pet
// wasn't already sick server-side). Once the round's Exit is pressed the
// cinematic plays:
//   1. the camera shows the pet standing sad under its sick bubble (pet.ts's
//      startSadCinematic) while the Caretaker says it feels bad;
//   2. on Next, it cuts to the potion table (potionTable.ts), whose cage opens
//      slowly to show the cure, while the Caretaker sends the player to fetch it.
// Then the same ground arrow the Feed/egg-carry errands use (pet.ts
// showArrowTo/hideArrow) points at the table. Walking to within
// TABLE_ERRAND_RADIUS of it — BEFORE actually reaching it — hands off to the
// Pepito chase (pepitoChase.ts), where Pepito swoops in and steals the cure.
// No click needed, exactly like feed.ts's walk-to-tree errand this is
// modeled on.
//
// The errand OWNS the moment while it runs (clientState.sicknessErrand): every
// other care action is gated on it (pet.ts canStartPetInteraction) and the
// player gets a BACK button to drop it (ui.tsx SicknessErrandOverlay).

import { engine, Entity, Transform, InputModifier } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { endSadCinematic, hideArrow, showArrowTo, startSadCinematic } from './pet'
import { clientState, pushToast } from './state'
import { openSicknessDialog } from './ui/dialog'
import { startPepitoChase } from './pepitoChase'
import { cinematicCut, cinematicReturn } from './cinematicCam'
import { closeCage, focusPotionTable, getPotionTable, openCage } from './potionTable'

// How close to the table the player gets before Pepito ambushes them — the steal
// has to happen on the way, not once they've already reached the cure.
const TABLE_ERRAND_RADIUS = 9
const SETTLE_S = 0.4 // pause after the Feed screen closes before the cinematic starts
// After the cut to the table, wait a beat, then lower the cage slowly (the clip
// is ~1 s long; this speed stretches it to ~2.5 s).
const CAGE_OPEN_DELAY_S = 0.6
const CAGE_OPEN_SPEED = 0.4

function playerPos(): Vector3 {
  const t = Transform.getOrNull(engine.PlayerEntity)
  return t ? t.position : Vector3.Zero()
}

function distFlat(a: Vector3, b: Vector3): number {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

/** The potion table as placed in the composite — not a duplicate spawned in code. */
function tableEntity(): Entity | null {
  return getPotionTable()
}

// The server's notify can land while the Feed round's own cinematic camera /
// results screen still owns the screen. Starting a second camera + freeze on
// top of that would fight it (and Feed's Exit would then yank ours away), so
// the cinematic waits here until nothing else is running — i.e. until Exit.
let pendingCinematic = false

function cinematicCanStart(): boolean {
  const s = clientState
  return (
    s.serverReady &&
    !!s.activePet &&
    !s.feedGame.active &&
    !s.bathGame.active &&
    !s.petting.active &&
    !s.hatch.active &&
    !s.carryEgg.active &&
    !s.carryPet.active &&
    !s.fetch.active &&
    !s.sicknessErrand.active &&
    !s.pepitoChase.active &&
    !s.dialog.open
  )
}

/** Called by the Feed round when it ended on a poisonous fruit (fruitGame.ts).
 *  Queues the cinematic; the errand system below plays it once the screen is
 *  free — i.e. when the round's results screen is exited. */
export function startSicknessCinematic(): void {
  if (!clientState.activePet) return
  console.log('[Client] sickness: cinematic queued (waits for the feed screen to close)')
  pendingCinematic = true
}

// The cinematic in progress. Everything it changes — player freeze, camera, the
// pet parked in its sad pose — is undone by finishSicknessCinematic(), which
// runs when the dialog is dismissed AND (as a safety net) whenever the dialog
// disappears any other way, so the player can never be left frozen behind a
// camera with nothing on screen.
let cinematicRunning = false
let cageTimer = -1 // seconds since the cut to the table while waiting to open the cage; -1 = not waiting

function runSicknessCinematic(): void {
  console.log('[Client] sickness: cinematic started')
  cinematicRunning = true
  cageTimer = -1
  InputModifier.createOrReplace(engine.PlayerEntity, { mode: InputModifier.Mode.Standard({ disableAll: true }) })
  closeCage() // the cure is locked in its cage until page 2 opens it

  // Shot 1: the sad, sick pet.
  const shot = startSadCinematic()
  if (shot) cinematicCut(shot.camPos, shot.look)
  else focusPotionTable() // no pet in the world to show — go straight to the table

  openSicknessDialog(finishSicknessCinematic, (page) => {
    // Page 2 (the cure): cut to the table, then open the cage slowly.
    if (page !== 1) return
    console.log('[Client] sickness: page 2 — cut to the potion table')
    endSadCinematic() // the pet can go back to following the player
    focusPotionTable()
    cageTimer = 0
  })
}

/** Dialog done: blend the camera back to the player's own, THEN unfreeze them
 *  and send them to the cure. The player stays frozen through the blend so the
 *  pose it's blending toward can't go stale. */
function finishSicknessCinematic(): void {
  if (!cinematicRunning) return
  console.log('[Client] sickness: dialog done, camera returning to the player')
  cinematicRunning = false
  cageTimer = -1
  endSadCinematic()
  cinematicReturn(() => {
    console.log('[Client] sickness: camera back, errand starts')
    if (InputModifier.has(engine.PlayerEntity)) InputModifier.deleteFrom(engine.PlayerEntity)
    if (!clientState.activePet) return
    clientState.sicknessErrand = { active: true, petId: clientState.activePet.id }
    const table = tableEntity()
    if (table) showArrowTo(Transform.get(table).position, 'sickness')
    clientState.petPanelOpen = false // the panel covers the screen; the errand is out in the world
    pushToast('Follow the arrow to the cure!')
  })
}

/** Drop the errand (arrow off). Used by the BACK button and by the guards below. */
export function cancelSicknessErrand(): void {
  if (!clientState.sicknessErrand.active) return
  clientState.sicknessErrand = { active: false, petId: '' }
  hideArrow('sickness')
}

export function setupSicknessErrand(): void {
  let settleT = 0
  engine.addSystem((dt: number) => {
    if (pendingCinematic) {
      // Once the Feed screen closes its camera lets go and the player's own one
      // comes back; wait a beat for that to settle so the cinematic remembers
      // the player's REAL camera pose (see cinematicCam.ts) — and so the cut
      // doesn't land in the same instant as the Exit press.
      if (cinematicCanStart()) {
        settleT += dt
        if (settleT >= SETTLE_S) {
          pendingCinematic = false
          settleT = 0
          runSicknessCinematic()
        }
      } else {
        settleT = 0
      }
    }
    if (cinematicRunning) {
      if (cageTimer >= 0) {
        cageTimer += dt
        if (cageTimer >= CAGE_OPEN_DELAY_S) {
          openCage(CAGE_OPEN_SPEED)
          cageTimer = -1
        }
      }
      // Safety net: the dialog vanished without calling onDone (something else
      // opened/closed a dialog over it) — end the cinematic anyway.
      if (!clientState.dialog.open) finishSicknessCinematic()
    }
    const task = clientState.sicknessErrand
    if (!task.active) return
    // Yield the shared guide arrow to a carry flow, same as feed.ts's errand.
    if (clientState.carryEgg.active || clientState.carryPet.active) {
      cancelSicknessErrand()
      return
    }
    // The errand belongs to the pet that got sick — if that pet is gone or the
    // player swapped to another one, the walk no longer means anything.
    if (!clientState.activePet || clientState.activePet.id !== task.petId) {
      cancelSicknessErrand()
      return
    }
    const table = tableEntity()
    if (!table) return
    const pos = Transform.get(table).position
    showArrowTo(pos, 'sickness') // re-assert each frame, same as the egg carry does
    if (distFlat(playerPos(), pos) <= TABLE_ERRAND_RADIUS) {
      cancelSicknessErrand() // errand done — arrow off, the steal cinematic takes over
      startPepitoChase()
    }
  })
}

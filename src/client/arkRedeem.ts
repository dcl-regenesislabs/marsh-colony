// Sending a pet to the Ark — the colony's shared goal. An Adult pet can be
// handed to the Captain for good: the player walks there (guide arrow), the
// Captain asks to confirm (ArkConfirmPanel in ui.tsx), then the pet walks up the
// ramp and into the ship. The server removes it and pays Caretaker XP + coins
// by rarity (config ARK_REWARDS); every creature aboard counts for everyone.

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { ARK_REWARDS, PET_BASE_Y, petStage } from '../shared/config'
import { actions, clientState, pushToast, showReward } from './state'
import { boardArk, canStartPetInteraction, hideArrow, restorePetAfterArk, setFollow, showArrowTo } from './pet'
import { objectPosition } from './objects'
import { holdArkDoorOpen } from './ark'

/** Close enough to the Captain for the hand-over. */
const CAPTAIN_REACH = 6

// The walk aboard, relative to the Ark's position (ark01.glb, scale 6): the foot
// of the ramp by the Captain, the top of the ramp, the doorway, then inside.
// Worked out from the ramp/door meshes — fine-tune here after seeing it in-world.
const ARK_PATH: { x: number; y: number; z: number }[] = [
  { x: 0, y: 0, z: 20.4 }, // ramp foot
  { x: 0, y: 3.85, z: 9.6 }, // ramp top
  { x: 0, y: 3.85, z: 8.0 }, // doorway
  { x: 0, y: 3.85, z: 5.8 } // inside
]

/** Seconds to wait for the server to confirm before giving the pet back. */
const CONFIRM_TIMEOUT_S = 5
let waitingFor = ''
let waited = 0
let pendingReward = { xp: 0, coins: 0 }

function captainPos(): Vector3 {
  return objectPosition(EntityNames.Captain_glb)
}

function reset(): void {
  clientState.arkRedeem = { active: false, phase: 'toCaptain', petId: '' }
  hideArrow('ark')
  holdArkDoorOpen(false)
  waitingFor = ''
}

/** "Send to Ark" in the pet panel: checks, then off to the Captain. */
export function startArkRedeem(): void {
  const pet = clientState.activePet
  const p = clientState.player
  if (!pet || !p) return
  if (petStage(pet.size) !== 'ADULT') {
    pushToast('Only Adult pets can board the Ark.')
    return
  }
  if (p.pets.length < 2) {
    pushToast('Keep at least one pet in your colony.')
    return
  }
  if (!canStartPetInteraction()) {
    pushToast(pet.sleeping ? 'Your pet is asleep!' : 'Your pet is busy right now!')
    return
  }
  clientState.petPanelOpen = false
  clientState.arkRedeem = { active: true, phase: 'toCaptain', petId: pet.id }
  if (!clientState.followEnabled) setFollow(true) // it walks with you to the ship
  showArrowTo(captainPos(), 'ark')
}

export function cancelArkRedeem(): void {
  if (!clientState.arkRedeem.active || clientState.arkRedeem.phase === 'boarding') return
  reset()
}

/** The Captain's panel: "Send aboard". */
export function confirmArkRedeem(): void {
  const r = clientState.arkRedeem
  const pet = clientState.activePet
  if (!r.active || r.phase !== 'confirm' || !pet || pet.id !== r.petId) {
    reset()
    return
  }
  r.phase = 'boarding'
  hideArrow('ark')
  holdArkDoorOpen(true)
  const reward = ARK_REWARDS[pet.rarity] ?? ARK_REWARDS.common
  pendingReward = { xp: reward.xp, coins: reward.coins }
  const ark = objectPosition(EntityNames.ark01_glb)
  const path = ARK_PATH.map((o) => Vector3.create(ark.x + o.x, PET_BASE_Y + o.y, ark.z + o.z))
  const petId = pet.id
  boardArk(path, () => {
    // Inside the ship: now the server takes it off the roster and pays.
    actions.redeemPet(petId)
    waitingFor = petId
    waited = 0
  })
}

export function setupArkRedeem(): void {
  engine.addSystem((dt: number) => {
    const r = clientState.arkRedeem
    if (!r.active) return

    if (r.phase === 'toCaptain') {
      const pet = clientState.activePet
      if (!pet || pet.id !== r.petId) {
        reset() // switched pets meanwhile
        return
      }
      showArrowTo(captainPos(), 'ark') // re-assert: the shared arrow can be taken
      const pp = Transform.getOrNull(engine.PlayerEntity)?.position
      const c = captainPos()
      if (pp && Math.hypot(pp.x - c.x, pp.z - c.z) <= CAPTAIN_REACH) {
        r.phase = 'confirm'
        hideArrow('ark')
      }
      return
    }

    if (r.phase === 'boarding' && waitingFor) {
      const gone = !clientState.player?.pets.some((x) => x.id === waitingFor)
      if (gone) {
        showReward(pendingReward.xp, pendingReward.coins)
        reset()
        return
      }
      waited += dt
      if (waited >= CONFIRM_TIMEOUT_S) {
        // The server said no (or never answered): the pet comes back out.
        restorePetAfterArk()
        reset()
      }
    }
  })
}

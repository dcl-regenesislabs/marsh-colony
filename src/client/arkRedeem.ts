// Sending a pet to the Ark — the colony's shared goal. Two ways in, one
// confirmation:
//  - "Send to Ark" in the pet panel: the player walks the active pet to the
//    Captain behind the guide arrow, and the Captain's "Board the Ark?" card
//    (ArkConfirmPanel in ui.tsx) opens on arrival.
//  - Talking to the Captain: pick any Adult pet from the roster (ArkDonatePanel),
//    which opens the same card.
// On "Send aboard" the server takes the pet (rewards by rarity, config
// ARK_REWARDS) and the boarding cinematic plays — both in arkCinematics.ts.

import { engine, Transform } from '@dcl/sdk/ecs'
import { Vector3 } from '@dcl/sdk/math'
import { EntityNames } from '../../assets/scene/entity-names'
import { petStage } from '../shared/config'
import { clientState, pushToast } from './state'
import { canStartPetInteraction, growthCinematicActive, hideArrow, setFollow, showArrowTo } from './pet'
import { objectPosition } from './objects'
import { requestArkDonation } from './arkCinematics'

/** Close enough to the Captain for the hand-over. */
const CAPTAIN_REACH = 6

function captainPos(): Vector3 {
  return objectPosition(EntityNames.Captain_glb)
}

function reset(): void {
  clientState.arkRedeem = { active: false, phase: 'toCaptain', petId: '' }
  hideArrow('ark')
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
  if (pet.sick) {
    pushToast(`${pet.name} is sick — cure it at the Care Center first.`)
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

/** The Captain's pet picker chose `petId`: straight to the confirmation card
 *  (the player is already standing by the Captain). */
export function openArkConfirm(petId: string): void {
  hideArrow('ark')
  clientState.arkRedeem = { active: true, phase: 'confirm', petId }
}

export function cancelArkRedeem(): void {
  if (!clientState.arkRedeem.active) return
  reset()
}

/** The Captain's card: "Send aboard". */
export function confirmArkRedeem(): void {
  // A growth reveal owns the camera right now: keep the card up, try again after.
  if (growthCinematicActive()) return
  const r = clientState.arkRedeem
  const pet = r.active && r.phase === 'confirm' ? clientState.player?.pets.find((x) => x.id === r.petId) : undefined
  reset()
  if (pet) requestArkDonation(pet)
}

export function setupArkRedeem(): void {
  engine.addSystem(() => {
    const r = clientState.arkRedeem
    if (!r.active) return

    // The pet left the roster meanwhile (swapped away, ...): nothing to send.
    if (!clientState.player?.pets.some((x) => x.id === r.petId)) {
      reset()
      return
    }
    if (r.phase !== 'toCaptain') return

    if (clientState.activePet?.id !== r.petId) {
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
  })
}

import { FAMILIES, petStage, speciesParts, type Family, type PetStage } from '../shared/config'

export type PetOverheadTuning = { nameLift: number; moodLift: number; bubbleLift: number }

type CalibrationGrid = Record<Family, Record<PetStage, PetOverheadTuning>>

const ZERO_TUNING: PetOverheadTuning = { nameLift: 0, moodLift: 0, bubbleLift: 0 }

const PET_OVERHEAD_CALIBRATION: CalibrationGrid = {
  sprout: {
    JUNIOR: { nameLift: -0.25, moodLift: 0, bubbleLift: 0.55 },
    TEENAGER: { nameLift: -0.5, moodLift: 0, bubbleLift: 0.9 },
    ADULT: { nameLift: -0.25, moodLift: 0, bubbleLift: 0.85 }
  },
  pepito: {
    JUNIOR: { nameLift: -0.25, moodLift: 0, bubbleLift: 0.25 },
    TEENAGER: { nameLift: -0.45, moodLift: 0, bubbleLift: 0.55 },
    ADULT: { nameLift: -0.3, moodLift: 0, bubbleLift: 0.3 }
  },
  amebita: {
    JUNIOR: { nameLift: -0.3, moodLift: 0, bubbleLift: 0.75 },
    TEENAGER: { nameLift: -0.55, moodLift: 0, bubbleLift: 0.8 },
    ADULT: { nameLift: -0.3, moodLift: 0, bubbleLift: 0.7 }
  },
  fluflito: {
    JUNIOR: { nameLift: -0.25, moodLift: 0, bubbleLift: 0.4 },
    TEENAGER: { nameLift: -0.45, moodLift: 0, bubbleLift: 0.3 },
    ADULT: { nameLift: -0.15, moodLift: 0, bubbleLift: 0.4 }
  }
}

/** Returns the calibrated offsets for a pet's base family and growth stage. */
export function petOverheadTuning(species: string, size: number): PetOverheadTuning {
  const { head } = speciesParts(species)
  if (!(FAMILIES as readonly string[]).includes(head)) return ZERO_TUNING
  return PET_OVERHEAD_CALIBRATION[head as Family][petStage(size)]
}

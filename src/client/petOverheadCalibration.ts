import { FAMILIES, petStage, speciesParts, type Family, type PetStage } from '../shared/config'

export type PetOverheadTuning = { nameLift: number; bubbleLift: number }

type CalibrationGrid = Record<Family, Record<PetStage, PetOverheadTuning>>

const ZERO_TUNING: PetOverheadTuning = { nameLift: 0, bubbleLift: 0 }

// These lifts are rebased for the fixed stage display scales (0.7 / 0.9 / 1.4)
// used by pet.ts. The original calibration preview used the continuous growth
// value, which would make overhead UI drift within each stage.
const PET_OVERHEAD_CALIBRATION: CalibrationGrid = {
  sprout: {
    JUNIOR: { nameLift: -0.5275, bubbleLift: -0.227 },
    TEENAGER: { nameLift: -0.63875, bubbleLift: -0.099 },
    ADULT: { nameLift: -0.805, bubbleLift: -0.704 }
  },
  pepito: {
    JUNIOR: { nameLift: -0.5275, bubbleLift: -0.527 },
    TEENAGER: { nameLift: -0.58875, bubbleLift: -0.449 },
    ADULT: { nameLift: -0.855, bubbleLift: -1.254 }
  },
  amebita: {
    JUNIOR: { nameLift: -0.5775, bubbleLift: -0.027 },
    TEENAGER: { nameLift: -0.68875, bubbleLift: -0.199 },
    ADULT: { nameLift: -0.855, bubbleLift: -0.854 }
  },
  fluflito: {
    JUNIOR: { nameLift: -0.5275, bubbleLift: -0.377 },
    TEENAGER: { nameLift: -0.58875, bubbleLift: -0.699 },
    ADULT: { nameLift: -0.705, bubbleLift: -1.154 }
  }
}

/** Returns the calibrated offsets for a pet's base family and growth stage. */
export function petOverheadTuning(species: string, size: number): PetOverheadTuning {
  const { head } = speciesParts(species)
  if (!(FAMILIES as readonly string[]).includes(head)) return ZERO_TUNING
  return PET_OVERHEAD_CALIBRATION[head as Family][petStage(size)]
}

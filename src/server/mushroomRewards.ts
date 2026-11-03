import { Storage } from '@dcl/sdk/server'
import type { PlayerData } from '../shared/types'
import { SIZE_MAX } from '../shared/config'

const KEY = 'mushroom-growth-receipts-v1'
export interface GrowthReceipt { petId: string; slot: number; pickedAt: number }

/** A durable receipt is written BEFORE revealing growth. If the ordinary player
 * save fails or the process crashes, the next load reapplies the paid reward. */
export function createMushroomRewards(deps: {
  read: (address: string) => Promise<GrowthReceipt[] | null>
  write: (address: string, receipts: GrowthReceipt[]) => Promise<boolean>
}) {
  const cached = new Map<string, GrowthReceipt[]>()
  function apply(p: PlayerData, receipt: GrowthReceipt): void {
    const pet = p.pets.find(pet => pet.id === receipt.petId)
    if (pet) { pet.size = SIZE_MAX; pet.careCount = Math.max(pet.careCount, 70) }
    const key = `happyHour:${receipt.slot}`
    p.counters[key] = Math.max(p.counters[key] ?? 0, receipt.pickedAt)
  }
  return {
    async recover(p: PlayerData): Promise<void> {
      const receipts = await deps.read(p.address) ?? []
      cached.set(p.address, receipts)
      for (const receipt of receipts) apply(p, receipt)
    },
    async grant(p: PlayerData, receipt: GrowthReceipt): Promise<boolean> {
      // Hatchlings are not roster pets until Keep. Never persist a reward that
      // cannot be applied, consume its cooldown, or replay it after Keep.
      if (p.hatchling || !p.pets.some(pet => pet.id === receipt.petId)) return false
      const receipts = cached.get(p.address) ?? await deps.read(p.address) ?? []
      // One latest receipt per owned pet bounds the journal by the player's roster.
      const next = receipts.filter(r => r.petId !== receipt.petId && p.pets.some(pet => pet.id === r.petId))
      next.push(receipt)
      if (!await deps.write(p.address, next)) return false
      cached.set(p.address, next)
      apply(p, receipt)
      return true
    }
  }
}

export const mushroomRewards = createMushroomRewards({
  read: address => Storage.player.get<GrowthReceipt[]>(address, KEY, { fresh: true }),
  write: (address, receipts) => Storage.player.set(address, KEY, receipts)
})

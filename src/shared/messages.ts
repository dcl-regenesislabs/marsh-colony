// Client <-> Server message contract. Complex payloads are serialized as JSON
// strings inside a `json` field to keep schemas simple and robust.

import { Schemas } from '@dcl/sdk/ecs'
import { registerMessages } from '@dcl/sdk/network'

export const Messages = {
  // ---- Client -> Server ----
  // Ask the server for my full state (sent once the room is ready).
  requestState: Schemas.Map({ guestName: Schemas.String }),
  // Adopt a pet (first time or into a free slot).
  adopt: Schemas.Map({ species: Schemas.String, name: Schemas.String }),
  // Trigger a care action: feed | clean | sleep | play. onBed = slept on the Bed.
  careAction: Schemas.Map({ action: Schemas.String, onBed: Schemas.Boolean }),
  // Feed tree minigame result: how many fruit were caught (sent once, at game end).
  feedResult: Schemas.Map({ caught: Schemas.Int }),
  // Pet your own active pet (instant happiness).
  petSelf: Schemas.Map({}),
  // Pet/treat another player's pet.
  petOther: Schemas.Map({ targetAddress: Schemas.String }),
  // Shop: buy a food tier (1 | 2).
  buyItem: Schemas.Map({ tier: Schemas.Int }),
  // Use a food item from inventory on the active pet.
  useItem: Schemas.Map({ tier: Schemas.Int }),
  // Roster: switch which pet is active.
  switchPet: Schemas.Map({ petId: Schemas.String }),
  // Keep the just-hatched pet (place it in a free slot) or discard it (send it
  // back to the Care Center — you end up with nothing).
  keepPet: Schemas.Map({}),
  discardPet: Schemas.Map({}),
  // Buy an extra pet slot with currency.
  buySlot: Schemas.Map({}),
  // Shop: buy one rarity potion (boosts the next breeding roll it is used on).
  buyPotion: Schemas.Map({}),
  // Spend a spin ticket on the wheel.
  spin: Schemas.Map({}),
  // Crack open the daily meteor (server rolls, applies and persists the reward).
  openMeteor: Schemas.Map({}),
  // Claim today's fixed daily-reward ladder step (server grants + persists it).
  claimDaily: Schemas.Map({}),
  // Breed the active pet with a partner pet (owned, for now). Server rolls rarity.
  // usePotion spends one rarity potion on this roll to tilt it toward rare/legendary.
  breed: Schemas.Map({ partnerPetId: Schemas.String, name: Schemas.String, usePotion: Schemas.Boolean }),
  // DEBUG/testing: instantly grow the active pet to Adult + level 5 (unlock breeding).
  debugGrowAdult: Schemas.Map({}),
  // Report my pet's follow state (Whistle/Stay) so the server can broadcast it
  // in presence for everyone to mirror.
  setFollow: Schemas.Map({ following: Schemas.Boolean }),
  // Pet swap: offer my active pet to `targetAddress` for their active pet.
  proposeSwap: Schemas.Map({ targetAddress: Schemas.String, fromName: Schemas.String }),
  // Target's answer to the pending swap offer addressed to them.
  respondSwap: Schemas.Map({ accept: Schemas.Boolean }),
  // Ask the server for the current coins leaderboard (sent when the panel opens).
  requestLeaderboard: Schemas.Map({}),

  // ---- Server -> Client ----
  // Coins leaderboard (LeaderboardEntry[] JSON), sent to the requesting client.
  leaderboard: Schemas.Map({ json: Schemas.String }),
  // Full owner snapshot (PlayerSnapshot JSON) for the requesting client.
  stateSnapshot: Schemas.Map({ json: Schemas.String }),
  // Broadcast of all pet presence entries (PresenceEntry[] JSON) for social rendering.
  presence: Schemas.Map({ json: Schemas.String }),
  // Broadcast of the shared Mars colony population (total pets the server knows).
  colony: Schemas.Map({ population: Schemas.Int }),
  // Toast / notification.
  notify: Schemas.Map({ kind: Schemas.String, message: Schemas.String }),
  // Spin wheel result (SpinReward JSON + landing index for animation).
  spinResult: Schemas.Map({ json: Schemas.String, index: Schemas.Int }),
  // Daily meteor result (SpinReward JSON + index), mirrors spinResult.
  meteorResult: Schemas.Map({ json: Schemas.String, index: Schemas.Int }),
  // Breeding result — the offspring's rolled rarity, for the reveal UI.
  breedResult: Schemas.Map({ rarity: Schemas.String, species: Schemas.String, name: Schemas.String }),
  // Incoming swap offer for the target: JSON { fromAddress, fromName, offeredPet, wantedPetName }.
  swapOffer: Schemas.Map({ json: Schemas.String }),
  // Swap outcome forwarded to the proposer.
  swapResult: Schemas.Map({ accepted: Schemas.Boolean, message: Schemas.String })
}

export const room = registerMessages(Messages)

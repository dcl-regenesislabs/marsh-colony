# Economy rebalance

What changed and why. All tunables live in `src/shared/config.ts`; the payout
rules are shared functions there, used by both the server (authoritative) and the
client's optimistic sim (`client/sim.ts`) so the "+coins" popup always matches.

## Coins from care

| Source | Before | Now |
|---|---|---|
| Feed (minigame) | 5 coins always, even with 0 fruit or a full belly | `feedCoins(caught)` = 1 per 2 fruits, max 8. Fewer than 3 fruits is a *snack*: hunger only, no growth / XP / coins |
| Bath (full) | 5 | 8 |
| Play | 9 | 9 (already energy-gated) |
| Kibble / Feast | +5 coins | 0 coins (`ITEM_USE_COINS`): XP + growth only — items are a sink |
| Feed / Bath only pay if… | always | the stat was **below 70** before the care (`CARE_PAY_STAT_THRESHOLD`) |

There is no daily cap on paid care: the stat threshold and the minigame result are what limit coins.

## Login

| | Before | Now |
|---|---|---|
| Daily login bonus | 10 | 5 |
| 7-day ladder | 20 / 35 / 50 / 75 / 110 / 150 / 300 (740/week) | 10 / 15 / 25 / 35 / 50 / 70 / 120 (325/week), same spins |
| Streak milestones (day 3/7/14/30) | 30 / 100 / 250 / 600 | 20 / 60 / 150 / 400, same spins |

## New sources (one-time)

- **Journey** (Goals panel): Adopt 20, Feed 15, Bath 20, Breed 50 + 1 spin, paid the first time each step is done (`JOURNEY_REWARDS`, claims stored as `journey_<step>` in `achievements`). Ark (wearable) comes with the Ark feature. The Goals ticks and the server use the same rule (`journeyStepDone`).
- **Album**: +10 coins (+20 Caretaker XP) per new creature, +50 per full head-family set (4), full page Common 200 / Rare 400 + 1 spin / Legendary 600 + 3 spins (placeholder until a legendary cosmetic exists). Claims in `PlayerData.albumClaims`; on the first load after this ships, everything the player already owns is marked claimed **without paying**.

## Sinks

- **Breeding** now costs 30 coins (`BREED_COST`), checked on the server and before the egg cinematic on the client (the name/potion modal shows the fee).
- Slots (50 +25) and the Rarity Potion (150) unchanged.

## Rarity

Thresholds Rare ≥ 6 → **8**, Legendary ≥ 10 → **12** (`d10 + care bonus 0–3 + potion 1.5`).

| Parents | Common | Rare | Legendary |
|---|---|---|---|
| 50% condition | 60% | 40% | 0% |
| 80% | 50% | 40% | 10% |
| 100% | 40% | 40% | 20% |
| 100% + potion | 30% | 40% | 30% |

## XP

- Passive pet XP 0.007/s → **0.002/s** (~25/h → ~7/h), so pet XP — which the Ark will convert into Caretaker XP — comes mostly from care.
- Caretaker XP: care 5, Play 8, cure 15, breed 25, hatching a bred egg 15, new album creature 20.

## Not in this change

- The Ark itself (redeem a pet for XP). Recommended there: only Adult pets, bonus by rarity (×1 / ×1.5 / ×2), tune the conversion rate after measuring.

## Notes for rollout

- Existing players who already did a Journey step get its reward once on their next qualifying action (the art promised it).
- Measure with PostHog (`ANALYTICS_ENABLED`) before the next tuning pass.

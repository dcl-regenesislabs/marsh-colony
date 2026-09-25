# Marsh Colony

> A cozy, multiplayer virtual-pet game built for Decentraland.

![Marsh Colony scene preview](assets/images/thumbnail.png)

**Marsh Colony** turns everyday pet care into a shared Decentraland adventure. Adopt a companion, keep it healthy and happy, help it grow, discover new family combinations through breeding, and meet other caretakers in a persistent social world.

## Play now

Marsh Colony is currently deployed in the Decentraland World **`marshcolony.dcl.eth`**.

## The experience

```text
Adopt a pet -> care for its needs -> grow together -> collect new companions -> share the world
```

Your pet's hunger, hygiene, energy, and happiness change over real time, including while you are away. Looking after it earns experience and coins, helps it grow from Junior to Teenager to Adult, and unlocks longer-term collection goals.

## Features

### Care, play, and wellbeing

- Adopt one of four starter pet families: **Sprout, Pepito, Amebita,** or **Fluflito**.
- Feed your pet through a fruit-catching minigame, clean it in a bubble-popping bath, let it rest in bed, and play fetch together.
- Pets express their needs, can be petted for a happiness boost, and may become sick after eating bad fruit. Visit the Caretaker to complete the cure sequence.
- Care actions are animated in the world: pets navigate to the relevant station, interact with it, and return to their routine.
- A responsive, mobile-friendly HUD keeps care, inventory, goals, rewards, and your pet roster close at hand.

### Growth, collection, and rewards

- Earn pet XP, Caretaker XP, coins, achievements, and login-streak rewards through consistent care.
- Use the shop for food, additional pet slots, and rarity potions.
- Grow pets through **Junior**, **Teenager**, and **Adult** stages. Adult pets can breed with another pet in your roster.
- Hatch offspring with inherited head/body family combinations. Four families create 16 possible visual combinations, with common, rare, and legendary cosmetic rarities.
- Build your collection with daily rewards, spin tickets, and a once-per-day meteor reward.

### A social pet world

- Your active pet follows you through the scene; choose whether it should follow or stay, and carry it when needed.
- See other players' active pets in real time, pet them to raise their happiness, and earn Giving progress.
- Offer a direct pet-for-pet swap to another nearby player.
- Compete on persistent coin and Caretaker XP leaderboards, while contributing to the shared pet-population counter.

## Built for Decentraland

Marsh Colony is a Decentraland SDK7 scene with an authoritative multiplayer server. The server validates gameplay actions, applies stat decay and rewards, saves player state by wallet, and sends snapshots back to the client. The client handles the responsive UI, local animation, navigation, minigames, and rendering of other players' pets.

```text
src/
  index.ts       Client/server entry point selected with isServer()
  shared/        Game types, balance configuration, and message contracts
  server/        Authoritative state, validation, persistence, and presence
  client/        UI, pet rendering, navigation, interactions, and minigames

assets/scene/main.composite
                  Static Creator Hub scene entities and interaction stations
```

Static objects such as the feeder, bed, pool, Caretaker, shop, and home are placed in `assets/scene/main.composite`. Game code finds those scene objects by name, keeping world layout in the Creator Hub and gameplay logic in TypeScript.

## Run locally

### Requirements

- Node.js 22 or later
- npm

### Commands

```bash
npm install
npm start
```

`npm start` launches the local Decentraland preview and its authoritative server. For an offline visual-preview workflow, use:

```bash
npm run start:offline
```

Build the project before sharing or deploying changes:

```bash
npm run build
```

To test social features locally, open the preview in two separate player sessions. Each session receives its own saved state and can see the other player's active pet.

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm start` | Start the local preview and authoritative server. |
| `npm run start:offline` | Start a local preview without the authentication screen. |
| `npm run build` | Type-check and bundle the scene. |
| `npm run deploy` | Deploy using the default Decentraland target. |
| `npm run deploy:testing` | Deploy to the Decentraland testing content server. |
| `npm run deploy:production` | Deploy to the Decentraland production content server. |
| `npm run server-logs` | Read logs from the authoritative server. |

## Configuration and development notes

- All gameplay balance lives in [`src/shared/config.ts`](src/shared/config.ts): stat decay, rewards, prices, XP, care effects, breeding odds, species, and progression thresholds.
- Shared player and pet data contracts are defined in [`src/shared/types.ts`](src/shared/types.ts), while client/server messages live in [`src/shared/messages.ts`](src/shared/messages.ts).
- The server is the source of truth for stats, currency, inventory, breeding, swaps, rewards, and persistence. Keep client-side changes responsive, but do not move authoritative rules out of `src/server/`.
- Before a production release, set `DEBUG_GROW_ENABLED` to `false` in `src/shared/config.ts` to disable the development growth shortcut. `DEV_SKIP_SERVER_GATE` is also intended only for visual scene work without a live server.
- To view server logs in the Explorer, add the appropriate wallet address to `logsPermissions` in `scene.json`.

## Project status

Marsh Colony is in active development. The current build focuses on a complete care loop, collectible pet progression, and meaningful social play in a persistent Decentraland scene.

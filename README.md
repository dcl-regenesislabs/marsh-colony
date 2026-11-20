# Marsh Colony

> A cozy, multiplayer virtual-pet game built for Decentraland.

<img width="2752" height="1536" alt="MarshColonyThumbnail (1)" src="https://github.com/user-attachments/assets/ade40d79-855c-4178-af92-29839de99c20" />


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
- The mushroom event is scheduled with server env vars, without a redeploy. See [Mushroom event](#mushroom-event).
- To view server logs in the Explorer, add the appropriate wallet address to `logsPermissions` in `scene.json`.

## Mushroom event

During the event, mushrooms appear around the colony for **one hour**. Picking one grows your pet into an Adult. There are two ways to start it, and both work at the same time.

Run the commands from the project folder, signed in with a wallet that can deploy `marshcolony.dcl.eth`.

### Schedule dates (automatic)

Put every start time in the `MUSHROOM_EVENT_SCHEDULE` env var:

```bash
npx sdk-commands storage env set MUSHROOM_EVENT_SCHEDULE --value "2026-11-10T18:00-03:00,2026-11-12T20:30-03:00"
```

That example opens two events: Nov 10 at 18:00 and Nov 12 at 20:30, Argentina time. Each one lasts one hour.

**Format of each date:** `YYYY-MM-DDTHH:MM` followed by the time zone.

| You write | It means |
| --- | --- |
| `2026-11-10T18:00-03:00` | 18:00 Argentina time (recommended: always add `-03:00`) |
| `2026-11-10T21:00Z` | 21:00 UTC (same moment as above) |
| `2026-11-10T21:00` | No time zone: read as **UTC**, so 18:00 in Argentina |
| `2026-11-10T18:00:30-03:00` | Seconds are optional |

Not accepted (the date is skipped): a space instead of the `T` (`2026-11-10 18:00`) or a time zone without the colon (`-0300`).

Rules:

- Date and time go together, joined by a `T`. Separate events with commas.
- Each `set` **replaces the whole list**. To add a date, send the full list again with the new one included. Dates that already passed can stay; they do nothing.
- A badly written date is skipped (the others still work) and shows up in the server logs as `Mushroom event schedule: ignored ...`. If no date in the new value is valid, the previous list stays and the log says `Mushroom event schedule unchanged`.
- A date less than an hour after another one is ignored, so an event can never restart in the middle (the log says `ignored overlapping`). This usually means the same hour was written twice.
- The server checks the value every 5 seconds, so changes apply almost right away.

**Check that it worked.** The `set` command doesn't show the saved value, so read the server logs. The log tool needs a newer SDK than the one this repo uses, so run it with `@dcl/sdk-commands@auth-server`:

```bash
npx @dcl/sdk-commands@auth-server scene-insights login
npx @dcl/sdk-commands@auth-server scene-insights logs --from 15m --query "Mushroom event"
```

`login` opens the browser to sign (read-only, no gas) and lasts up to 12 hours. The wallet must own `marshcolony.dcl.eth`, be a deploy collaborator, or be listed in `logsPermissions` in `scene.json`. You should see `Mushroom event schedule (UTC): ...` with your dates converted to UTC.

### Start it now (manual fallback)

Use this if the schedule fails or you need an event right away:

```bash
npx sdk-commands storage env set START_MUSHROOM_EVENT --value true
```

- The event opens within about 30 seconds and lasts one hour. The log prints `Mushroom event started manually`.
- If an event is already running, `true` joins that hour instead of restarting it, so nobody gets their mushrooms back. The log says `Mushroom event already running`.
- Leaving it on `true` does **not** start more events. For another manual event, set it to `false`, wait a minute, and set it back to `true` (the flag is checked every 30 seconds, so a quick `false` → `true` can be missed).
- Server restarts and redeploys don't restart a manual event that is already running.

### Stop an event now

Set **both** values:

```bash
npx sdk-commands storage env set MUSHROOM_EVENT_SCHEDULE --value off
npx sdk-commands storage env set START_MUSHROOM_EVENT --value false
```

- `off` only cancels the scheduled dates. An event started manually keeps running until `START_MUSHROOM_EVENT` is `false`.
- Don't `delete` either variable to stop an event: an empty value keeps the last state, so the event keeps running.
- Don't use `npx sdk-commands storage env clear`. It deletes **every** env var, including `ANALYTICS_ENABLED`.

## Project status

Marsh Colony is in active development. The current build focuses on a complete care loop, collectible pet progression, and meaningful social play in a persistent Decentraland scene.

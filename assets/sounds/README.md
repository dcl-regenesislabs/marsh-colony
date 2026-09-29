# Scene audio

## Jukebox tracks (issue #110)

The Marsh Colony jukebox (`src/client/music.ts`) plays two ambient tracks by
Daniel Garcia Aranda:

| File                              | Track label    | Notes            |
| --------------------------------- | -------------- | ---------------- |
| `assets/sounds/marshy_marsh.mp3`  | `Marshy Marsh` | default on load  |
| `assets/sounds/swampy_marsh.mp3`  | `Swampy Marsh` | alternate        |

Both loop (`loop: true`) — paths/labels live in `SONGS` in `src/client/music.ts`.

## Sound effects

All one-shot/looped SFX below follow the same pattern: a lazily-created
`AudioSource` entity, retriggered with `AudioSource.playSound(entity, clipUrl)`
(a fresh `playing`/`loop` component for the water-drop pour and the UI click).
File names are case-sensitive on deploy even though macOS won't complain
locally — keep new drops lowercase-and-underscore or match the casing used in
code exactly.

| File                          | Used for |
| ------------------------------ | -------- |
| `AlienNod.mp3`                | Talking to the Caretaker or the Captain |
| `Whistle01.mp3`               | Whistling to call your pet over |
| `meteorland.mp3`               | Daily meteor landing, and its collection "poof" |
| `FruitDrop01.mp3`             | A fruit missing the catch and hitting the ground (feed minigame); the potion hitting the floor after Pepito is hit with a rock; a thrown fetch ball's first bounce |
| `fruit_pick2.wav`             | Catching a fruit in the feed minigame |
| `breed.mp3`                   | The breeding cinematic's egg-appear burst, and again when the egg hatches |
| `Animal02.mp3` / `Animal03.mp3` / `Animal04.mp3` / `Animal05.mp3` | Per-species "voice" (`playPetVoice` in `pet.ts`) — Amebita → 03, Pepito → 04; Sprout/Fluflito share 02/05. Fired on click/select/feed/bath/pet/wake/breed-placement/hatch/cure/etc. — see `PET_VOICE_SOUND` in `pet.ts` |
| `waterdrop.mp3`                | Looped during the cure bottle's pour (starts/stops with the pour window in `cureCelebration.ts`); one-shot per bubble popped in the bath minigame |
| `bong_001.ogg`                 | Generic UI tap/click — wired into the shared button/modal-close primitives in `ui/theme.tsx` and `ui.tsx` (`playUiClick`) |

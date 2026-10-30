# Localization audit — issue #160

## Baseline inventory

The initial static scan covered every `.ts` and `.tsx` file under `src/`, plus
every PNG in the repository.

| Surface | Count | Interpretation |
| --- | ---: | --- |
| String-literal segments in `src/` | 4,788 | Includes diagnostics, ids, model paths, CSS-like values, and copy. |
| Distinct string-literal segments | 1,378 | Raw inventory before filtering. |
| Potential player-facing string segments | 496 | Heuristic: prose or UI-looking strings after excluding paths/ids. |
| Distinct potential player-facing strings | 379 | Translation migration backlog. |
| Direct JSX text values | 163 | 155 live in `src/client/ui.tsx`. |
| PNG files | 162 | 111 scene assets and 51 Pokédex assets. |
| PNGs with confirmed embedded English | 31 | Requires reviewed localized art (or an explicitly approved code overlay). |

The scan is intentionally an upper bound: a string can be an internal log,
player-generated pet name, or a UI caption. It is useful for tracking progress,
not for translating blindly.

## Embedded-text PNGs

Confirmed art with English copy includes the standalone buttons
`backbutton2.png`, `hatch_button.png`, `bath button.png`, tutorial
`btn_next.png`, plus these revamp assets:

- `adopt_choose_panel.png`, `adopt_name_panel.png`, `ark_lifted.png`,
  `ark_thanks.png`, `bath_hud.png`, `board_ark.png`, `breed.png`,
  `breed_ui_hud.png`, `buy_button_states.png`, `choose_partner_panel.png`,
  `dailyrewards_hud.png`,
  `dialogue.png`, `discardbutton.png`, `feed_hud_green.png`,
  `fruit_caught.png`, `goals.png`, `hud2.png`, `hud3.png`,
  `inv_buy_button.png`, `inv_use_button.png`, `inventory_panel.png`,
  `jukebox.png`, `keepbutton.png`, `mypets_panel.png`.
- Album/marketing art: `album_panel.png`, `album_parts.png`, and
  `assets/images/thumbnail.png`.

Pokédex creature sprites and textures were inspected as image art rather than
language content; they do not need localized variants.

## Implementation decision

Existing raster controls remain the source of truth. The scene preserves the
original PNG buttons (including Back, Keep, Discard, Hatch, Bath, Place Pet,
Breed, Buy, Use, Next, and Adopt) rather than replacing their art with generic
code buttons.

Every image with embedded copy therefore needs reviewed English, Spanish, and
Portuguese variants before that particular visual can be localized. A code
overlay is only acceptable after a visual/design decision for that asset; do
not stretch or machine-translate a raster atlas in production. Text that is
already rendered by code is localized now.

## Language-picker artwork

The in-game picker reuses Cozy Farm's `languages.png` flag atlas and its primary
and secondary button artwork (source revision `440805a68d4d93a665c42cf17830735804b54a71`).
Marsh Colony keeps its own `pet_actions_panel.png` as the picker background.

## Code typography

`assets/fonts/` contains the static Fredoka Regular, SemiBold and Bold TTFs,
plus the SIL Open Font License (`OFL-Fredoka.txt`). Use these local files through
React-ECS `fontSrc` when replacing embedded PNG copy: local TTFs work in Unity,
where a remote font-family name does not. The rounded Fredoka family matches the
existing panel headings and button labels closely while supporting Spanish and
Portuguese accents.

## Copy and layout rules

1. English is the fallback key. Spanish (`es`, `es-*`) and Portuguese (`pt`,
   `pt-*`, including `pt-BR`) resolve locally on the client.
2. When a localized asset or code label is used, keep labels short (one or two
   words where possible): for example
   `Keep → Conservar → Ficar`, `Buy → Comprar → Comprar`.
3. Fixed-width text rendered by code and narrative copy use wrapping. Any new
   static English player copy must be added to `src/client/i18n/index.ts` in the
   same change. Text baked into art needs a matching localized asset.
4. Gameplay messages remain language-neutral at the server boundary and are
   translated when the client renders them. The only persisted language value is
   the Bevy desktop preference, stored per player wallet.

## Manual QA matrix

- Mobile: test Explorer languages `en`, `es`, `es-AR`, `pt`, `pt-BR`, and an
  unsupported tag such as `fr` (falls back to English). Change Settings while
  the scene is open; confirm the code-rendered HUD, dialog text, toast, and
  language flag update without reload.
- Bevy desktop: open the flag, select each language, reload the scene, and
  confirm the saved selection returns for the same wallet.
- Verify the original PNG controls have their original art in every language.
  For each image containing English, use the audit list to request reviewed
  Spanish and Portuguese artwork before claiming that asset is localized.

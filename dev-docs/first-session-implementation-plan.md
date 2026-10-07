# First Session — plan de implementación

> Rama: `first-session-plan`. Basado en `first-session-tutorial.md` (spec) y en el código actual de `main` (#403).
> Regla de oro: **si no es tu primera vez, el juego queda exactamente igual que hoy.** Todo lo nuevo pasa por un único chequeo `firstSessionActive()`, y para un jugador que ya existe ese chequeo es siempre falso.

---

## 0. Cómo se decide "primera vez"

**No es un tutorial que se retoma: es una primera sesión a medida.** Solo existe durante la primera visita; la segunda vez que entran caen en la escena normal, sin importar hasta dónde llegaron. El avance se mide en PostHog (más adelante), no se guarda.

- El server ya sabe si un jugador es nuevo: al cargarlo no tenía save (`freshPlayers`). Ese mismo momento lo anota en un set en memoria `firstSessionPlayers`.
- El snapshot lleva `firstSession: true` mientras dure esa visita. El cliente lo guarda en `clientState.firstSession`.
- Cuando el server detecta que el jugador se fue (el mismo lugar que hoy dispara `session ended`), lo saca del set. Como al entrar se creó su save, la próxima visita ya no es "nueva": juego normal.
- **No se guarda nada nuevo en Storage.** Un jugador que ya existe nunca entra en la primera sesión, así que para él el juego queda exactamente igual.
- Los premios de un solo uso (regalo, cría gratis) se validan en el server contra ese mismo flag en memoria, así que no se pueden pedir fuera de la primera visita.
- **Para probar:** `DEBUG_FORCE_FIRST_SESSION` en `config.ts`. Con `true`, cada entrada es un jugador nuevo en memoria que nunca se guarda: tu save real no se toca y cada reload arranca de cero. Va en `false` para publicar.

## 1. Cambios respecto a la spec (por cómo está el juego hoy)

| Spec | Hoy en el juego | Propuesta |
|---|---|---|
| "Los huevos están en el Shop" | El Shop está suspendido. La 2.ª mascota se adopta hablando con el Caretaker; los slots se compran en **My Pets** (carta "Buy slot") o en el panel de adopción | El paso 11 lleva a **My Pets → comprar slot** y después al **Caretaker → adoptar**. Sin Shop. |
| Grow Potion como ítem de inventario | No existe | **Hongo en el bosque:** el Caretaker te la "concede" y te manda a buscar un hongo; tocarlo hace crecer la mascota (como el cheat, sin dinero). Sin ítem ni UI. Se hace al final, con el modelo del hongo. |
| Regalo de ~50 coins | Desde el rebalanceo, el Journey ya paga Adopt 20, Feed 15 y Bath 20 | Con eso + feed/bath/cure/fetch se llega a ~180 coins antes del paso 17, contra 125 necesarios. **Lo dejaría en 30** como red de seguridad (configurable). |
| Criar | Hoy criar cuesta **30 coins** (`BREED_COST`) | La cría del tutorial **no cobra** (si no, el presupuesto pasa a 155). |
| Lock de sueño de 3 min | La siesta dura 3 min, pero se puede despertar a los 30 s | Usamos la siesta tal cual; el "despertar" del paso 14 ya existe. |
| Pareja del Caretaker | Ya existe su mascota dorada (`caretakerPet.ts`), pero es un cruce Pepito/Fluflito | Para la cría usamos un **Fluflito Adult aparte** (o Amebita si tu pet 1 es Fluflito), puesto en el bowl B solo durante el tutorial. Así el bebé sale con el cuerpo que pide la spec. |

## 2. Pasos de la sesión

`intro → meet → feed → sick → cured → bath → play → grow → nest → slot3 → breed → hatchHybrid → wrapup → captain → done`

> **Cambio (oct 2026):** la primera sesión se juega con **una sola mascota**. Como la cría usa la mascota del Caretaker, se sacaron la siesta, el segundo huevo, el tiempo libre y el cambio de mascota. Adoptar queda cerrado desde que se queda la primera mascota hasta el final. Son 5 capítulos.

- Viven **solo en el cliente** (`src/client/firstSession.ts`) y avanzan con los eventos reales del juego (keep, resultado del Feed, cura, baño, rondas de fetch, cría…), igual que hoy los snapshots actualizan el HUD.
- Si recargan a mitad, ya no es su primera visita: juego normal. No hay checkpoints.
- Cada paso alcanzado se reporta a PostHog (`first_session_step`) cuando hagamos el tracking.

## 3. Sistema de guía (sin arte nuevo)

| Pieza | Qué reusa | Nuevo |
|---|---|---|
| Caretaker en persona | `openDialog('Caretaker', …)` de `ui/dialog.tsx` | Solo los textos nuevos |
| **Línea de objetivo remota** ("Caretaker: Feed your pet at the bowl") | Retrato del Caretaker que ya usa el diálogo + estilo de los toasts | **Un componente chico**: barra arriba al centro con retrato + texto + "Capítulo 2/6". Reemplaza al checklist como pieza aparte. ⚠️ Es la única UI nueva; sin arte nuevo. |
| Resaltado de un objetivo | Flecha guía (`showArrowTo`, nuevo owner `'tutorial'`) para cosas del mundo; `attentionPulse` para botones de UI | — |
| Escalado de pistas | — | Timer por beat: 0–10 s nada · 10 s aparece la línea · 25 s flecha/pulso · 60 s el Caretaker lo repite (emote + toast). Cualquier avance reinicia el timer. |
| Mascota reacciona | Burbujas de necesidad y emotes que ya existen | Durante el tutorial apago las burbujas de texto (`PET_SPEECH_LINES`) y dejo solo emotes (spec §8.1) |

Hints de una vez que hoy saltan solos (`firstPet`, `breed`, `meteor`) se silencian mientras dura el tutorial, para no pisar la guía.

## 4. Implementación por fases

Cada fase se puede probar sola y deja el juego jugable.

### Fase 1 — Base (sin cambios visibles) ✅ hecha
1. Server: `firstSessionPlayers` en memoria, `isFirstSession` / `endFirstSession`, `firstSession` en el snapshot.
2. Cliente: `clientState.firstSession` y `src/client/firstSession.ts` con `firstSessionActive()`.
3. Debug: `DEBUG_FORCE_FIRST_SESSION`.
- ✅ Test: jugador existente → nada cambia. Con el debug en `true` → `firstSession: true` en el snapshot y el save real intacto.

### Fase 2 — Capítulo 1: conocer la mascota (pasos 1–2)
- Intro actual + una línea más ("Raise a creature worth breeding").
- Tras keep: pausa de ~10 s y la línea "Feed your pet at the bowl" con flecha al bowl/árbol.

### Fase 3 — Capítulo 2: comida y problemas (pasos 3–6)
- **Veneno garantizado:** en la primera ronda de Feed del tutorial, `fruitGame.ts` programa una fruta venenosa que cae sobre el cajón. Si el jugador igual la esquiva, el resultado se envía con `poisoned: true` ("la mascota la comió del piso"). El resto del arco (diálogo, Care Center, Pepito, piedra, cura) ya existe.
- **Regalo:** al curar, el server suma el regalo una sola vez (`flags: gift`) y el diálogo de cura agrega "Take this for your bravery".
- Pausa: la mascota baila (`cureCelebration` ya lo hace).

### Fase 4 — Capítulo 3: baño y juego (pasos 7–9)
- Al terminar la persecución, el server baja la higiene (barro) para que el baño tenga sentido.
- Fetch: línea "Let's play!". Con una ronda alcanza; si no juega, a los ~2 min sigue igual. Sin siesta: de ahí directo al hongo.

### ~~Fase 5 — Segundo huevo~~ (sacada, ver el cambio arriba)
- Mientras duerme: línea del Caretaker → flecha y pulso a **My Pets → Buy slot** (50) → flecha al Caretaker → adoptar (flujo actual completo, incluye el nombre con el panel nuevo).
- Pausa libre ~30 s (si el meteorito está disponible, la línea lo menciona) y el Caretaker te vuelve a llamar.

### Fase 6 — Capítulo 4: crecer y criar
- **Crecer a Adult — se implementa al final (Fase 7b), cuando llegue el modelo del hongo.** El Caretaker dice que por ser la primera vez te concede una Grow Potion: "go find a mushroom in the woods". Flecha al hongo en el bosque; al tocarlo la mascota crece (como el cheat de debug, pero sin dar dinero) con un efecto armado con piezas que ya están (`starburst` + escalado animado + baile). Server: acción válida solo en la primera sesión y una sola vez. Mientras no esté, para probar se usa el tótem de debug que ya existe.
- **Nido:** flecha al nido; la pareja del Caretaker aparece sentada en el bowl B.
- **Slot 2** para el bebé, con el pulso en My Pets.
- **Cría:** el flujo actual sin el paso `pickB` (la pareja ya está). Server `breed` con `tutorialPartner: true`: no busca la pareja en `p.pets`, usa la familia fija, no cobra fee, sigue exigiendo Adult y slot libre para la tuya. Rareza aleatoria normal.
- Huevo → casa → eclosión → **Keep**.

### Fase 7 — Capítulo 5: cierre
- Diálogo final de la spec → `step: 'done'`. Desde ahí el juego es el de siempre; Goals y la racha siguen como hoy.

### Fase 7b — Hongo de crecimiento (al final)
- Modelo del hongo (lo consigue Giorgio) en el bosque, diálogo del Caretaker, flecha, acción de server de un solo uso y efecto de crecimiento.

### Fase 8 — Limpieza antes de publicar
- `DEBUG_GROW_ENABLED = false`.
- Revisar que regalo, pociones y pareja no se repitan con reloads ni desconexiones a mitad.
- Cronometrar la sesión completa (spec §8.2) y ajustar regalo y textos.

## 5. Plan de test

| Caso | Esperado |
|---|---|
| Jugador que ya tiene save | Entra igual que hoy, sin línea de objetivo ni cambios |
| Jugador nuevo, sesión completa | Termina con 2 mascotas (pet 1 Adult e híbrido) |
| Jugador nuevo que recarga a mitad | La segunda entrada es el juego normal, con lo que haya hecho |
| Esquivar la fruta venenosa | Igual se enferma |
| No jugar fetch | A los ~2 min pasa igual al hongo |
| Quedarse quieto 60 s en cualquier paso | Línea → flecha → recordatorio del Caretaker |
| Terminar la primera sesión y volver a entrar | Juego normal |
| Mobile | La línea de objetivo no tapa los botones; flechas visibles |

## 6. A confirmar antes de empezar

1. **Única UI nueva:** la barra de objetivo con el retrato del Caretaker, que también muestra "Capítulo X/6" en lugar de un checklist aparte. ¿OK?
2. ~~Pociones~~ → hongo en el bosque, al final (confirmado).
3. **Regalo de 30 coins** (y no 50), porque ahora el Journey ya paga bastante.
4. **Cría del tutorial gratis** (sin los 30 coins de fee).
5. **Segundo huevo vía Caretaker + My Pets**, porque el Shop está suspendido.
6. **Burbujas de texto de la mascota apagadas** durante el tutorial (solo emotes).
7. ¿Implementamos por fases con un commit por fase y lo vas probando, o todo junto?

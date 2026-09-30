# Pokédex — renders de criaturas

48 renders (1024×1024, fondo transparente): 4 familias × 4 cabezas × 3 rarezas.

```
creatures/common/      *_basecolor.png      (colores originales)
creatures/rare/        *_basecolor2.png     (variante de color)
creatures/legendary/   *_basecolorGold.png  (dorado)
```

Nombre de archivo = mismo que el GLB: `<cuerpo>_<cabeza>.png` (`sprout.png` = original).

Los GLB no tienen textura: el juego la aplica en runtime (`src/client/creatureSkins.ts`).
El render replica eso: cuerpo con la textura de su familia, cabeza con la de la
familia de la cabeza, material unlit, pose Idle.

`overview_<rareza>.png`: grilla — filas = cuerpo (sprout, pepito, amebita, fluflito),
columnas = cabeza (mismo orden).

## Regenerar
Desde la raíz del repo:
```
cp pokedex/tools/* . && npm i --no-save three playwright
node shoot.mjs   # escribe en ./out/<rareza>/
```
Variables: `RARITY` (def. `common,rare,legendary`), `YAW` (rotación, def. 0.5),
`ANIM` (Idle, Happy, Sleep…), `T` (segundo del clip), `ONLY` (prefijo de archivo).
Las capturas salen sin recortar; para el encuadre final se recortan al contenido
con un 6 % de margen y se escalan a 1024×1024.

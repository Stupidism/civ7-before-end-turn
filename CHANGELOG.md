# Changelog

## 1.0.1 — 2026-10-08

- Rename the displayed mod title to **Save Before End Turn**.
- Update the Workshop cover and add a real in-game screenshot of the `BeforeEndTurn` local save.
- Keep the mod ID, save filename and runtime behavior unchanged.

The screenshot shows an existing save in the native load menu; a save/load round trip for this release is still unverified.

## 1.0.0 — 2026-10-08

First public preview release.

- Save to the single local `BeforeEndTurn` slot before submitting the current turn.
- Wait for successful save completion; keep the current turn on failure or timeout.
- Support the standard mouse, keyboard, controller and automatic end-turn paths.
- Keep native quicksave and autosave behavior independent.
- Compose with Rest Guard by saving after its rest completes.

Validation: 31 automated checks with game/native API substitutes; mod initialization observed in the local game log. An actual save/load round trip is not yet verified. The Workshop cover is an original explanatory graphic, not a gameplay screenshot.

# Changelog

## 1.0.0 — 2026-10-08

First public preview release.

- Save to the single local `BeforeEndTurn` slot before submitting the current turn.
- Wait for successful save completion; keep the current turn on failure or timeout.
- Support the standard mouse, keyboard, controller and automatic end-turn paths.
- Keep native quicksave and autosave behavior independent.
- Compose with Rest Guard by saving after its rest completes.

Validation: 31 automated checks with game/native API substitutes; mod initialization observed in the local game log. An actual save/load round trip is not yet verified. The Workshop cover is an original explanatory graphic, not a gameplay screenshot.

# Floeterm built-in theme provenance

New themes introduced in Floeterm 0.8.0 are original Floeterm palettes released
under this package's MIT license. Public theme repositories were used for
interaction and color-system research; their color tables were not copied into
the new original themes. The exact per-theme records live in `THEME_PROVENANCE.json`.

## Solarized Dark

- Source: `altercation/solarized` commit `62f656a02f93c5190a8753159e34b385588d5ff3`
- Copyright: Copyright (c) 2011 Ethan Schoonover
- License: MIT, reproduced in `third_party_licenses/solarized-MIT.txt`
- Modification: existing Floeterm ANSI mapping retained; `cursorAccent` was added equal to the background.

## Tokyo Night

- Source: `folke/tokyonight.nvim` commit `cdc07ac78467a233fd62c493de29a17e0cf2b2b6`
- Copyright: Folke Lemaitre and Tokyo Night contributors
- License: Apache-2.0, reproduced in `third_party_licenses/tokyonight-Apache-2.0.txt`
- The fixed source tree contains no NOTICE file.
- Modification: existing Floeterm palette retained.

## Monokai legacy risk

The `monokai` ID, label, and palette predate Floeterm 0.8.0. The exact original
palette source and upstream naming authorization could not be reconstructed
reliably. Floeterm retains the existing values for persisted preference and API
compatibility, does not claim an official Monokai release, and adds no new
third-party palette material. A future legal review may change the display label
while preserving the persisted ID.

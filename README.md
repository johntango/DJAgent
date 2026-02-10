# Tango DJ Agent SPA

Node/Express single-page app for Tango DJs.

## Features
- Scans `/users/johnwilliams/Music/MyMusic` (or configurable path) and builds a metadata library JSON.
- Uses OpenAI to generate tanda/cortina playlist plans with tango flow constraints.
- Playlist pattern: tango(4), tango(4), vals(3), tango(4), tango(4), milonga(3), with a cortina after each tanda.
- Edit playlists: move tandas, replace individual tracks, and save great tandas into a tanda library.
- Plays tracks directly in the browser via HTML audio.

## Setup
```bash
npm install
export OPENAI_API_KEY=your_key_here
npm start
```

Open: `http://localhost:3000`

## Data Storage
- Library: `data/library/library.json`
- Playlists: `data/playlists/*.json`
- Saved tandas: `data/tanda-library/*.json`

## Catalog fallback
- On first start, if `data/library/library.json` does not exist, the server can seed the library from `CatalogArt.json` (or `catalog-Art.json`) when present in the repo root.

## Notes
- If OpenAI generation fails or API key is missing, the app falls back to deterministic random tanda selection.

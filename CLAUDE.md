# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MyVocalBooth is a browser-based multi-track audio editor — like a lightweight DAW. Record or import audio assets, place them as clips on multiple tracks, adjust per-track volume/pitch/mute/solo, and play back with a moving playhead via Tone.Transport.

## Tech Stack

- Zero build step — plain HTML/CSS/JS, CDN dependencies
- Tone.js v14+ (Transport-based playback and scheduling)
- Dexie.js 3.x (IndexedDB — assets table + project table)
- MediaRecorder API for recording
- Google Fonts: IBM Plex Sans + IBM Plex Mono

## Running

```bash
python3 -m http.server 8000
# Open http://localhost:8000
```

## Architecture

### Data model (IndexedDB via Dexie)

**assets** table: raw audio files (recordings, imports)
```js
{ audioBlob: Blob, name: string, isStarred: bool, createdAt: Date, duration: number }
```

**project** table: single document (`key: 'main'`) with track/clip timeline
```js
{ key: 'main', tracks: [
  { id, name, volume (0-1), pitchShift (-12..+12), mute, solo,
    clips: [{ assetId, startTime }] }
]}
```

### File structure

```
index.html           # App shell: transport, media bin, timeline, footer
css/style.css        # Dark DAW theme
js/
  app.js             # UI orchestration, asset/bin/timeline rendering, event delegation
  recorder.js        # MediaRecorder wrapper
  assets.js          # Dexie CRUD for assets + project
  player.js          # Transport-based multi-track playback
```

### Signal chain (per track, during playback)

```
Tone.Player (per clip) → Tone.PitchShift → Tone.Gain → Master Gain → Destination
```

All clips on a track share the same PitchShift and Gain. Solo/mute logic: if any track has solo, only soloed tracks play; mute silences the track.

### Playback flow

1. `Player.play(tracks, getBlobUrl)` iterates all tracks
2. For each non-muted/non-soloed-out track, creates Gain + PitchShift
3. For each clip on the track, creates a `Tone.Player` from the asset blob URL
4. Clips are scheduled via `player.start(clip.startTime)` relative to Transport
5. `Tone.Transport.start()` begins playback
6. Playhead position updates via rAF polling `Tone.Transport.seconds`

### Key interactions

- **Media bin**: list of all assets. Click ▶ to preview, + to add to selected track, × to delete.
- **Timeline tracks**: click a track row to select it (blue left border). The + button on assets adds clips to the selected track.
- **Transport**: REC (record new asset), play/pause/stop (timeline playback).
- **Track controls**: volume fader, pitch fader, S (solo), M (mute) — on each track header.
- **Clips**: positioned at `startTime * 40px`, width = `duration * 40px`. × button removes clip from track.
- **Playhead**: red vertical line with time display, updates during playback.

## Constraints

- AudioContext must be activated by user gesture (REC or Play buttons)
- MediaRecorder outputs `audio/webm`
- All audio data stored in IndexedDB (hundreds of MB limit)
- Track count fixed at 4 (defined in `AssetsDB._defaultProject()`)
- AI accompaniment and WAV export are not yet implemented

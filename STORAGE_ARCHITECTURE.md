# Storage Architecture

## Primary Source

SQLite is the primary startup source only when it is the richer valid source.

The backend decides startup source by comparing:
- SQLite reconstructed store counts
- `store.json`
- `store.last-good.json`

The selected source is exposed by:
- `GET /api/system/storage-status`

## SQLite Role

SQLite is the durable primary persistence layer for:
- sessions
- session needs
- invigilators
- engagements
- assignments
- super assignments
- control sessions
- control assignments
- course room assignment tables

On startup, SQLite can rebuild the JSON mirrors if SQLite is selected.

## JSON Mirror Role

`server/data/store.json` is a readable mirror and export/cache file.

It is not the only source anymore. It is used when:
- it is richer than SQLite
- SQLite is empty or behind

If selected, JSON is promoted back into SQLite.

## Last-Good Mirror Role

`server/data/store.last-good.json` is the backup mirror.

It is used when:
- `store.json` is unreadable or corrupted
- and it is the best valid JSON source available

## Startup Flow

1. Inspect SQLite.
2. Inspect `store.json`.
3. Inspect `store.last-good.json`.
4. Compare source richness.
5. Select startup source:
   - `sqlite`
   - `store-json`
   - `last-good-json`
   - `empty`
6. Initialize in-memory store from the selected source.
7. Rebuild JSON mirrors from SQLite if SQLite won.
8. Promote JSON into SQLite if JSON won.

## Write Flow

All shared-tab writes are expected to go through the central store write path:

1. build updated in-memory snapshot
2. persist snapshot to SQLite
3. rebuild `store.json`
4. rebuild `store.last-good.json`
5. update initialized in-memory state

If SQLite write fails, the route must return an error instead of pretending persistence succeeded.

## If JSON Is Corrupted

If `store.json` is corrupted:
- backend tries `store.last-good.json`
- if that also fails, backend can still recover from SQLite if SQLite is valid

The corruption and source choice are visible in:
- startup logs
- `/api/system/storage-status`

## If SQLite Is Empty

If SQLite is empty but JSON is richer:
- backend promotes JSON into SQLite
- JSON remains the chosen startup source for that startup

## Storage Status

Use:

- `GET /api/system/storage-status`

It reports:
- startup source
- startup timestamp
- mirror rebuild / SQLite promotion flags
- SQLite counts
- JSON mirror counts
- mismatch warnings
- health status

## Recovery Verification

Use:

- `node server/scripts/verify_storage_recovery.js`

The script:
- preserves original data files
- persists a known assignment through the central write path
- blanks JSON mirrors
- reinitializes startup from SQLite
- verifies counts and assignment survival
- restores original files after the test

## Known Limitations

- Course Room Assignment uses its own SQLite-backed module and does not share the common `store.json` live state.
- Shared-tab route consistency depends on routes using `readStore()` and the central `writeStore()` path.
- Existing data already lost before these safeguards cannot be reconstructed unless reimported or regenerated.

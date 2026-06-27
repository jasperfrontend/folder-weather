# Folder Weather handoff

A Firefox (MV3) WebExtension that turns a bookmark-toolbar folder into a live weather readout. Each data point becomes a child bookmark row inside the folder, with real separators between them. Configuration happens through an **options page**; naming a folder in the bracket syntax is a quick-add shortcut.

Status: working, with a config UI (v0.1). Loaded as a temporary add-on via `about:debugging`.

## Source-of-truth contract (decided 2026-06-22)

The options page is the canonical writer of `fw_config_<id>`. The `[w City :: ...]` folder-name syntax is a **quick-add**, not a competing source:

- **New `[w City]`** (no `::`) → adopts the **global default template** (stored, editable in the panel), not a hardcoded constant. The folder is renamed to the plain city.
- **`[w City :: tmpl]`** → sets an explicit per-folder template.
- **Re-typing `[w City]`** onto an already-managed folder → swaps the **city only** and *keeps* the existing custom template (`template: null` in config means "inherit the global default at render time").
- Because `onboard()` immediately renames the brackets away to the plain city, the bracket form is self-erasing and can never repeatedly clobber a UI edit on the tick.

**Ancestor rule:** the topmost `[w ...]` folder in a branch wins; any `[w ...]` nested *inside another weather folder* is ignored. A plain (non-bracketed) "Weather" hub folder full of `[w City]` subfolders is the intended multi-city pattern — each child is managed independently by its own stable id.

## Files in this folder

- `manifest.json` — MV3 manifest. Permissions: `bookmarks`, `alarms`, `storage`. Host permissions for `api.open-meteo.com` and `geocoding-api.open-meteo.com`. Background loads `["engine.js", "background.js"]` as an event page (not a service worker, because Firefox). Has `options_ui` (open-in-tab).
- `engine.js` — the reusable engine, loaded by **both** the background page and the options page (zero logic duplication): defaults, settings get/save, geocode (with place-name enrichment), forecast fetch (unit-aware, with a 5-min coord-keyed in-memory cache), token rendering, `previewRows`, `renderInto`, `clearGenerated`, per-folder status writes.
- `background.js` — scheduling, onboarding, and the single render queue: `onboard()` (ancestor-aware), `renderOne()`, `fullUpdate()`, the `enqueue()` serializer, the alarm, a `runtime.onMessage` handler (the options page delegates all rendering here), settings-change reschedule, and bookmark-event listeners for near-instant quick-add + eager delete cleanup. All bookmark writes are serialized through `enqueue()`; `onboard()` returning `[]` for our own rows prevents the render→event→render cascade.
- `options.html` / `options.css` / `options.js` — the config UI: folder picker, per-folder editor with geocode confirmation + live preview, global settings (default template, interval, dry-text, units), and a manage list (edit / refresh-now / detach, with status dots and error surfacing).

## How it works right now

A bookmark folder named in the edit syntax gets picked up:

```
[w Rotterdam]                          -> adopts the global default template
[w Rotterdam :: {emoji} {temp}° | ...] -> custom, pipes = rows
```

The full loop runs once on load and every `updateMinutes` (default 15, from settings) via an alarm; a light onboard-only pass also runs ~1.2s after any bookmark edit (debounced) so quick-adds appear almost immediately:

1. **onboard()** — walks the bookmark tree (ancestor-aware, see contract above) for any folder titled `[w ...]`. Parses `{ city, template }`, resolves the template per the source-of-truth rules, stores it under the folder's **id** (`fw_config_<id>`), renames the folder to the plain city, and returns the ids it touched. Bookmark ids are stable across renames and restarts, so the id is the durable anchor.
2. **fullUpdate()** — runs `onboard()`, then `renderOne()` for every `fw_config_*` key. `renderOne(id)` confirms the folder still exists and is a folder (`bookmarks.get(id)`); if not, it removes the config, status, and generated children.

**renderInto(folderId, config)** (in `engine.js`) geocodes the city (cached), fetches the forecast (unit-aware, coord-cached), splits `config.template || settings.defaultTemplate` on `|`, renders each segment, then **wipes its previously-created children** and recreates them as bookmark rows with `type: "separator"` dividers between. Rows link to a Google weather search for the city. Writes a `fw_status_<id>` record (ok / error) so the UI can surface failures.

**Folder-title readout (optional).** If an effective title template resolves to non-blank (`resolveTitleTemplate(config, settings)` — per-folder override else the global `titleTemplate`), `renderInto` also rewrites the folder's **own title** each refresh, e.g. `{city} {temp}°` → "Rotterdam 24°". Blank (the default) leaves the title alone (just the city), which keeps attached folders safe from being renamed. The rewritten title never matches `[w ...]`, so it doesn't retrigger onboarding.

**Concurrency (the v0.1.2 fix).** Every bookmark-mutating job runs through a single serialized queue (`enqueue()` in `background.js`); renders for a folder can never overlap. The options page **never renders directly** — Refresh / Save / Detach send `runtime.sendMessage({type})` and the background does the work inside the queue. The background also does **not** run a full update on every event-page wake (that used to race a user-triggered render and duplicate rows); the initial render is wired to `runtime.onInstalled` / `onStartup`, periodic refresh to the alarm, and quick-add reaction to debounced bookmark events. `onboard()` returning `[]` for non-`[w...]` titles still stops our own writes from looping.

**Self-healing cleanup.** `clearGenerated(folderId, link)` removes tracked children **and** any child carrying our exact weather-search URL (orphans from older races). Separators are only swept when *every* child is ours, so a user-attached folder keeps its own separators. This means installing v0.1.2 auto-clears any duplicated rows left by the earlier bug on the first render.

## Storage schema (storage.local)

| Key                      | Value                                         | Notes                                                                      |
|--------------------------|-----------------------------------------------|----------------------------------------------------------------------------|
| `fw_settings`            | `{ defaultTemplate, titleTemplate, dryText, updateMinutes, units }` | global settings; written by the options page. `units = { temperature, windSpeed, precipitation }` (Open-Meteo values). `titleTemplate` blank = leave folder titles as just the city. Changing it reschedules the alarm + refreshes. |
| `fw_config_<folderId>`   | `{ city, template, titleTemplate }`           | per-folder config. `template: null` = inherit `defaultTemplate`; `titleTemplate: null` = inherit the global `titleTemplate`; both resolved at render time |
| `fw_children_<folderId>` | `[ bookmarkId, ... ]`                         | rows + separators the extension created; used to clean up before re-render |
| `fw_status_<folderId>`   | `{ ok, error, at }`                           | last render outcome, surfaced in the manage list                           |
| `fw_geo_<cityLower>`     | `{ lat, lon, name, admin1, country }`         | geocode cache, keyed by lowercased city (enriched with place name)         |

## Template tokens

Literal text (`°`, `km/h`, `mm`, `u`) is just typed around the tokens.

Current conditions: `{emoji}` `{temp}` `{feels}` `{wind}` `{windarrow}` (points the way wind blows toward) `{rain}` (mm) `{humidity}` `{city}`

Daily: `{sunrise}` `{sunset}` (both bare `HH:MM`) `{max}` `{min}` `{uv}`

Next rain: `{nextrain}` (composite, e.g. `18:00u 4mm 15%`, or the dry-text value when nothing is coming) plus the pieces `{rainat}` `{rainmm}` `{rainprob}`.

## Config knobs

User-facing settings now live in the **options page** (written to `fw_settings`): default template, update interval, dry-text, and units. Code-level knobs:

- `DEFAULTS` (top of `engine.js`) — fallbacks used when `fw_settings` is missing a key.
- `FC_TTL_MS` (`engine.js`) — how long a forecast is reused across folders sharing coordinates (5 min).
- `forecast_days: "2"` inside `getForecast` — the next-rain lookahead horizon (48h). Bump for longer planning.

## Known constraints

- **Separators are Firefox-only.** `bookmarks.create({ type: "separator" })` is supported on Firefox but not Chrome. This extension is Firefox-only by design.
- **Signing.** Temporary add-ons unload on restart. For a permanent personal install, sign via AMO (unlisted is fine) or run on Developer Edition / Nightly with `xpinstall.signatures.required = false`.
- **Rain resolution is hourly.** Times land on the hour (`18:00`, not `18:06`). Open-Meteo has a 15-minute feed but it doesn't carry `precipitation_probability`, so pairing time + mm + % means staying on the hourly grid. Switching to `minutely_15` for finer onset timing, and back-filling probability from the matching hour, is a possible upgrade.
- **Unit labels in templates are literal.** Switching units changes the *numbers* (via the API), but `km/h`/`mm`/`°` text in a template is typed by the user — update the default template if you switch to imperial.
- **UI attach does not rename the folder.** A folder attached via the picker keeps its existing title (so you can manage a pre-existing folder); only the bracket quick-add renames to the plain city.

## Possible next steps

- **Batch forecasts.** Open-Meteo accepts comma-separated `latitude`/`longitude` for multiple places in one request — worth it if someone runs many cities.
- **Finer rain onset** via `minutely_15` (see constraint above).

Most of the engine (`render`, `buildContext`, `nextRain`, `renderInto`, `clearGenerated`, the token set) is reusable as-is. The refactor is mostly about adding a second, preferred path into `fw_config_<id>` and a UI around it, then deciding how `onboard()` coexists.

## Load / test

1. `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → pick `manifest.json`.
2. Make a folder named `[w Rotterdam]` on the toolbar. Within a tick it renames to `Rotterdam` and fills with rows.
3. Reload the add-on from `about:debugging` after code changes.

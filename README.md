# Folder Weather

A Firefox extension that turns a bookmark toolbar folder into a live weather readout. Each data point becomes a child bookmark row inside the folder, with real separators between them. You can also turn the folder's own name into a live readout, so a folder can literally read "Rotterdam 24°".

It started as a daft idea: can you name a toolbar folder `[w Rotterdam]` and have Firefox fill it with the weather? Turns out yes.

## How it looks

A folder named `[w Rotterdam]` becomes a folder called `Rotterdam` (or `Rotterdam 24°` if you enable the title readout) containing rows like:

```
☀️ 24°
feels 22°
→ 12 km/h
0 mm
```

Each row links to a Google weather search for the city. The folder refreshes itself on a timer (15 minutes by default).

## Two ways to add a city

**Quick add.** Make a bookmark toolbar folder and name it in the bracket syntax:

```
[w Rotterdam]                          uses your global default template
[w San Diego, CA :: {emoji} {temp}°]   custom template, pipes split rows
```

Within a moment the extension renames the folder to the plain city and fills it with weather rows. The bracket form is a one time "edit me" shortcut, not a permanent label.

**Settings page.** Open the extension's preferences for a full editor: pick an existing folder, confirm the city with a geocode lookup, write a row template and an optional folder title, and see a live preview before you save. The settings page is the canonical source of truth; the bracket syntax is a convenience layer on top of it.

## Template tokens

Type literal text (like `°`, `km/h`, `mm`) around the tokens. Use `|` to split a row template into separate rows.

Current conditions: `{emoji}` `{temp}` `{feels}` `{wind}` `{windarrow}` `{rain}` `{humidity}` `{city}`

Daily: `{sunrise}` `{sunset}` `{max}` `{min}` `{uv}`

Next rain: `{nextrain}` (a composite like `18:00u 4mm 15%`, or your "no rain" text when nothing is coming) plus the pieces `{rainat}` `{rainmm}` `{rainprob}`.

The folder title template uses the same tokens, for example `{city} {temp}°` or `{emoji} {city} {temp}°`. The settings page includes one click presets.

## Multiple cities

Each folder is configured independently, keyed by its stable bookmark id, so you can run as many as you like. A tidy pattern is a plain (non bracketed) folder named something like "Weather" with several `[w City]` subfolders inside it. The topmost weather folder in any branch wins; a weather folder nested inside another weather folder is ignored.

## Settings

The preferences page covers:

- Default row template and default folder title (with presets)
- Update interval, and the text shown when there is no rain coming
- Units: temperature (C or F), wind (km/h, m/s, mph, knots), precipitation (mm or inch)
- A managed list with per folder edit, refresh now, and detach, plus status and error reporting

## Install (temporary)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click "Load Temporary Add-on" and pick `manifest.json` from this folder.
3. Make a toolbar folder named `[w Rotterdam]`, or open the extension's settings to attach one.

Temporary add-ons unload when Firefox restarts. For a permanent personal install, sign the extension through addons.mozilla.org (an unlisted listing is fine), or run Firefox Developer Edition or Nightly with `xpinstall.signatures.required` set to false.

## How it is built

- `manifest.json` (Manifest V3, Firefox). Permissions: `bookmarks`, `alarms`, `storage`. Host permissions for the Open-Meteo forecast and geocoding APIs.
- `engine.js` is the shared engine, loaded by both the background page and the settings page so they run the exact same render path: settings, geocoding, forecast fetching (unit aware, with a short coordinate keyed cache), token rendering, and the live preview.
- `background.js` handles scheduling and onboarding only: it watches for bracket named folders, refreshes managed folders on an alarm, and reacts to bookmark edits for near instant quick add and eager cleanup on delete.
- `options.html`, `options.css`, `options.js` are the settings page.

Weather data comes from [Open-Meteo](https://open-meteo.com), a free and open API that needs no key.

## Notes and limits

- This is Firefox only by design. The row separators use `bookmarks.create({ type: "separator" })`, which Firefox supports and Chrome does not.
- Rain onset times land on the hour, because pairing time, amount, and probability requires the hourly feed.
- Unit labels in templates are literal text. Switching units changes the numbers, so update your template text if you move to imperial.

## License

MIT. See `LICENSE`.

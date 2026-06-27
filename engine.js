// engine.js — shared by background.js and options.js.
// Pure-ish weather engine: defaults, settings, geocode/forecast, rendering.
// No scheduling or onboarding here (that lives in background.js).

// --- defaults -----------------------------------------------
const DEFAULTS = {
  defaultTemplate:
    "{emoji} {temp}° | feels {feels}° | {windarrow} {wind} km/h | {rain} mm",
  titleTemplate: "", // blank = leave the folder's own title untouched (just the city)
  dryText: "dry", // shown by {nextrain} when no rain is in the forecast window
  updateMinutes: 15,
  units: { temperature: "celsius", windSpeed: "kmh", precipitation: "mm" }
};

// --- settings (global, single source) -----------------------
async function getSettings() {
  const s = (await browser.storage.local.get("fw_settings")).fw_settings || {};
  return {
    defaultTemplate: s.defaultTemplate || DEFAULTS.defaultTemplate,
    titleTemplate: s.titleTemplate != null ? s.titleTemplate : DEFAULTS.titleTemplate,
    dryText: s.dryText != null ? s.dryText : DEFAULTS.dryText,
    updateMinutes: Number(s.updateMinutes) || DEFAULTS.updateMinutes,
    units: { ...DEFAULTS.units, ...(s.units || {}) }
  };
}

async function saveSettings(patch) {
  const cur = await getSettings();
  const next = {
    ...cur,
    ...patch,
    units: { ...cur.units, ...(patch.units || {}) }
  };
  await browser.storage.local.set({ fw_settings: next });
  return next;
}

// --- per-folder status (so the UI can surface failures) -----
async function setStatus(folderId, ok, error) {
  await browser.storage.local.set({
    ["fw_status_" + folderId]: { ok, error: error || null, at: Date.now() }
  });
}

// --- helpers ------------------------------------------------
function weatherEmoji(code, isDay) {
  if (code === 0) return isDay ? "☀️" : "🌙";      // clear: sun / moon
  if (code <= 2) return isDay ? "🌤️" : "☁️"; // mainly clear / partly
  if (code === 3) return "☁️";                              // overcast
  if (code <= 48) return "🌫️";                        // fog
  if (code <= 57) return "🌦️";                        // drizzle
  if (code <= 67) return "🌧️";                        // rain
  if (code <= 77) return "🌨️";                        // snow
  if (code <= 82) return "🌦️";                        // rain showers
  if (code <= 86) return "🌨️";                        // snow showers
  return "⛈️";                                              // thunderstorm
}

// arrow points the way the wind is blowing TO (where it pushes you)
function windArrow(fromDeg) {
  const to = (fromDeg + 180) % 360;
  const arrows = ["↑","↗","→","↘","↓","↙","←","↖"];
  return arrows[Math.round(to / 45) % 8];
}

function render(template, ctx) {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in ctx ? String(ctx[key]) : m
  ).trim();
}

// Parse the quick-add syntax: "[w Rotterdam]" or "[w Rotterdam :: tmpl]".
// template === null means "no inline template given" (inherit / keep).
function parseFolder(title) {
  const m = title.match(/^\[w\s+([^\]:]+?)\s*(?:::\s*(.+?))?\]$/i);
  if (!m) return null;
  return { city: m[1].trim(), template: m[2] ? m[2].trim() : null };
}

// --- data ---------------------------------------------------
async function geocode(city) {
  const key = "fw_geo_" + city.toLowerCase();
  const cached = (await browser.storage.local.get(key))[key];
  if (cached) return cached;
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?name=" +
    encodeURIComponent(city) + "&count=1&language=en&format=json";
  const data = await (await fetch(url)).json();
  if (!data.results || !data.results.length) return null;
  const r = data.results[0];
  const coords = {
    lat: r.latitude, lon: r.longitude,
    name: r.name, admin1: r.admin1 || "", country: r.country || ""
  };
  await browser.storage.local.set({ [key]: coords });
  return coords;
}

// short-lived in-memory cache so several folders for the same place,
// refreshed on one tick, share a single forecast fetch
const _fcCache = new Map();
const FC_TTL_MS = 5 * 60 * 1000;

async function getForecast(lat, lon, units) {
  const u = units || DEFAULTS.units;
  const ck = [lat, lon, u.temperature, u.windSpeed, u.precipitation].join("|");
  const hit = _fcCache.get(ck);
  if (hit && (Date.now() - hit.at) < FC_TTL_MS) return hit.data;

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    timezone: "auto",
    forecast_days: "2",
    temperature_unit: u.temperature,
    wind_speed_unit: u.windSpeed,
    precipitation_unit: u.precipitation,
    current:
      "temperature_2m,apparent_temperature,weather_code,is_day," +
      "wind_speed_10m,wind_direction_10m,precipitation,relative_humidity_2m",
    hourly: "precipitation,precipitation_probability",
    daily: "sunrise,sunset,temperature_2m_max,temperature_2m_min,uv_index_max"
  });
  const url = "https://api.open-meteo.com/v1/forecast?" + params.toString();
  const data = await (await fetch(url)).json();
  _fcCache.set(ck, { data, at: Date.now() });
  return data;
}

// first upcoming hour with measurable rain, or null
function nextRain(fc) {
  const t = fc.hourly.time;
  const mm = fc.hourly.precipitation;
  const prob = fc.hourly.precipitation_probability;
  const now = fc.current.time; // local ISO, lexicographically comparable
  for (let i = 0; i < t.length; i++) {
    if (t[i] >= now && mm[i] > 0) {
      return { at: t[i].slice(11, 16), mm: mm[i], prob: prob[i] };
    }
  }
  return null;
}

function buildContext(fc, city, dryText) {
  const c = fc.current;
  const d = fc.daily;
  const ctx = {
    city,
    emoji: weatherEmoji(c.weather_code, c.is_day === 1),
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature),
    wind: Math.round(c.wind_speed_10m),
    windarrow: windArrow(c.wind_direction_10m),
    rain: c.precipitation,
    humidity: c.relative_humidity_2m,
    // daily
    sunrise: d.sunrise[0].slice(11, 16),
    sunset: d.sunset[0].slice(11, 16),
    max: Math.round(d.temperature_2m_max[0]),
    min: Math.round(d.temperature_2m_min[0]),
    uv: Math.round(d.uv_index_max[0])
  };
  const nr = nextRain(fc);
  ctx.rainat = nr ? nr.at : "";
  ctx.rainmm = nr ? nr.mm : 0;
  ctx.rainprob = nr ? nr.prob : 0;
  ctx.nextrain = nr
    ? nr.at + "u " + nr.mm + "mm " + nr.prob + "%"
    : (dryText != null ? dryText : DEFAULTS.dryText);
  return ctx;
}

// Resolve the effective folder-title template for a folder:
// an explicit per-folder one wins, else the global default ("" = leave alone).
function resolveTitleTemplate(config, settings) {
  const t = (config && config.titleTemplate != null)
    ? config.titleTemplate
    : settings.titleTemplate;
  return (t || "").trim();
}

// Render template segments for a city without touching bookmarks.
// Used by the options-page live preview. Returns { rows, title } or { error }.
async function previewRows(city, template, titleTemplate) {
  const settings = await getSettings();
  const geo = await geocode(city);
  if (!geo) return { error: "City not found: " + city };
  const fc = await getForecast(geo.lat, geo.lon, settings.units);
  const ctx = buildContext(fc, city, settings.dryText);
  const tmpl = (template && template.trim()) || settings.defaultTemplate;
  const rows = tmpl.split("|").map(s => render(s.trim(), ctx)).filter(Boolean);
  const tt = resolveTitleTemplate({ titleTemplate: titleTemplate || null }, settings);
  const title = tt ? render(tt, ctx).trim() : "";
  return { rows, title, geo };
}

// the Google weather-search URL every generated row links to; also used as a
// reliable fingerprint for "this row is ours" during cleanup
function weatherLink(city) {
  return "https://www.google.com/search?q=" +
    encodeURIComponent("weather " + city);
}

// --- child bookmark management ------------------------------
// Remove the rows/separators we created. We trust the tracked id list, but we
// also self-heal: any child carrying our weather link is unmistakably ours
// (clears orphans left by older races). Separators are only swept when the
// whole folder is ours, so a user-attached folder keeps its own separators.
async function clearGenerated(folderId, link) {
  const key = "fw_children_" + folderId;
  const tracked = new Set((await browser.storage.local.get(key))[key] || []);

  let children = [];
  try { children = await browser.bookmarks.getChildren(folderId); }
  catch (e) { children = []; } // folder gone

  const allOurs = children.length > 0 && children.every(c =>
    c.type === "separator" || (link && c.url === link));

  for (const c of children) {
    const ours =
      tracked.has(c.id) ||
      (link && c.url === link) ||
      (c.type === "separator" && allOurs);
    if (ours) {
      try { await browser.bookmarks.remove(c.id); } catch (e) { /* gone */ }
    }
  }
  await browser.storage.local.remove(key);
}

// render the weather rows into a known folder, using a stored config
async function renderInto(folderId, config) {
  const settings = await getSettings();
  try {
    const geo = await geocode(config.city);
    if (!geo) { await setStatus(folderId, false, "City not found: " + config.city); return; }
    const fc = await getForecast(geo.lat, geo.lon, settings.units);
    const ctx = buildContext(fc, config.city, settings.dryText);

    const tmpl = config.template || settings.defaultTemplate;
    const segments = tmpl.split("|").map(s => render(s.trim(), ctx)).filter(Boolean);

    const link = weatherLink(config.city);

    // optional live folder-title readout (e.g. "Rotterdam 24°"); blank = leave it
    const titleTmpl = resolveTitleTemplate(config, settings);
    if (titleTmpl) {
      const title = render(titleTmpl, ctx).trim();
      if (title) { try { await browser.bookmarks.update(folderId, { title }); } catch (e) { /* gone */ } }
    }

    await clearGenerated(folderId, link);

    const ids = [];
    let idx = 0;
    for (let i = 0; i < segments.length; i++) {
      const row = await browser.bookmarks.create({
        parentId: folderId, title: segments[i], url: link, index: idx++
      });
      ids.push(row.id);
      if (i < segments.length - 1) {
        const sep = await browser.bookmarks.create({
          parentId: folderId, type: "separator", index: idx++
        });
        ids.push(sep.id);
      }
    }
    await browser.storage.local.set({ ["fw_children_" + folderId]: ids });
    await setStatus(folderId, true, null);
  } catch (e) {
    await setStatus(folderId, false, String((e && e.message) || e));
  }
}

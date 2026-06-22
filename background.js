// background.js — scheduling + onboarding. Engine lives in engine.js,
// which is loaded first (see manifest "background.scripts").

// --- phase 1: onboard folders still wearing the [w ...] quick-add syntax ---
// Ancestor rule: the topmost [w ...] in a branch wins; any [w ...] nested
// inside another weather folder is ignored. Returns the ids it (re)configured.
async function onboard() {
  const settings = await getSettings();
  const tree = await browser.bookmarks.getTree();

  const fresh = [];
  (function walk(nodes, insideWeather) {
    for (const n of nodes) {
      const isWeather = !n.url && n.title && /^\[w\s+/i.test(n.title);
      if (isWeather && !insideWeather) fresh.push(n);
      if (n.children) walk(n.children, insideWeather || isWeather);
    }
  })(tree, false);

  const changed = [];
  for (const node of fresh) {
    const parsed = parseFolder(node.title);
    if (!parsed) continue;

    const key = "fw_config_" + node.id;
    const existing = (await browser.storage.local.get(key))[key];

    // template resolution: inline wins; else keep an existing custom one;
    // else null = inherit the global default at render time.
    let template;
    if (parsed.template != null) template = parsed.template;            // explicit inline
    else if (existing && existing.template != null) template = existing.template; // keep custom
    else template = null;                                               // inherit default

    // the bracket syntax never sets a title template; keep any existing one,
    // otherwise null = inherit the global default at render time.
    const titleTemplate = (existing && existing.titleTemplate !== undefined)
      ? existing.titleTemplate : null;

    await browser.storage.local.set({ [key]: { city: parsed.city, template, titleTemplate } });
    await browser.bookmarks.update(node.id, { title: parsed.city });
    changed.push(node.id);
  }
  return changed;
}

// --- phase 2: refresh every folder we already remember (by id) --------
async function updateManaged() {
  const all = await browser.storage.local.get(null);
  for (const key of Object.keys(all)) {
    if (!key.startsWith("fw_config_")) continue;
    const id = key.slice("fw_config_".length);
    let node = null;
    try { node = (await browser.bookmarks.get(id))[0]; } catch (e) { node = null; }

    // folder was deleted or is no longer a folder: forget it and tidy up
    if (!node || node.url || node.type === "separator") {
      await clearGenerated(id);
      await browser.storage.local.remove([key, "fw_status_" + id]);
      continue;
    }
    await renderInto(id, all[key]);
  }
}

// --- run coordination ---------------------------------------
// _busy guards against the cascade: our own bookmark writes fire bookmark
// events, which must not retrigger a render while one is already running.
let _busy = false;

async function updateAll() {
  if (_busy) return;
  _busy = true;
  try {
    await onboard();
    await updateManaged();
  } catch (e) {
    console.error("Folder Weather:", e);
  } finally {
    _busy = false;
  }
}

// Light, event-driven pass: onboard only, then render just what changed.
// onboard() returns [] for our own row writes (they aren't [w ...] folders),
// so the create/remove events from rendering don't loop back into more work.
async function onBookmarksChanged() {
  if (_busy) return;
  _busy = true;
  try {
    const changed = await onboard();
    for (const id of changed) {
      const cfg = (await browser.storage.local.get("fw_config_" + id))["fw_config_" + id];
      if (cfg) await renderInto(id, cfg);
    }
  } catch (e) {
    console.error("Folder Weather:", e);
  } finally {
    _busy = false;
  }
}

// --- scheduling ---------------------------------------------
async function scheduleAlarm() {
  const s = await getSettings();
  browser.alarms.create("tick", { periodInMinutes: s.updateMinutes });
}

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick") updateAll();
});

// Settings change (from the options page) → reschedule + refresh now.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.fw_settings) {
    scheduleAlarm();
    updateAll();
  }
});

// --- live reaction to bookmark edits (near-instant quick-add) ----------
let _debounce = null;
function scheduleOnboard() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => { onBookmarksChanged(); }, 1200);
}
browser.bookmarks.onCreated.addListener(scheduleOnboard);
browser.bookmarks.onChanged.addListener(scheduleOnboard);
browser.bookmarks.onMoved.addListener(scheduleOnboard);

// Eager cleanup when a managed folder is deleted (no waiting for the tick).
browser.bookmarks.onRemoved.addListener(async (id) => {
  const key = "fw_config_" + id;
  const cfg = (await browser.storage.local.get(key))[key];
  if (cfg) {
    await clearGenerated(id);
    await browser.storage.local.remove([key, "fw_status_" + id]);
  }
});

// --- boot ---------------------------------------------------
scheduleAlarm();
updateAll();

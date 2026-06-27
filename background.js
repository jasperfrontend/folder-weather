// background.js — scheduling + onboarding + the single render queue.
// Engine lives in engine.js, loaded first (see manifest "background.scripts").
//
// Concurrency model: every operation that writes bookmarks goes through
// enqueue(), so renders for a folder can never overlap. The options page does
// NOT render directly; it sends a message and the background renders here, in
// this one serialized queue. That is what prevents duplicated rows.

// --- serialized work queue ----------------------------------
let _chain = Promise.resolve();
function enqueue(fn) {
  const run = _chain.then(() => fn()).catch(e => console.error("Folder Weather:", e));
  // keep the chain alive even after an error
  _chain = run.catch(() => {});
  return run;
}

// --- phase 1: onboard folders still wearing the [w ...] quick-add syntax ---
// Ancestor rule: the topmost [w ...] in a branch wins; any [w ...] nested
// inside another weather folder is ignored. Returns the ids it (re)configured.
async function onboard() {
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

// render a single managed folder by id (tidying up if it no longer qualifies)
async function renderOne(id) {
  const key = "fw_config_" + id;
  const cfg = (await browser.storage.local.get(key))[key];
  if (!cfg) return;

  let node = null;
  try { node = (await browser.bookmarks.get(id))[0]; } catch (e) { node = null; }
  if (!node || node.url || node.type === "separator") {
    await clearGenerated(id, weatherLink(cfg.city));
    await browser.storage.local.remove([key, "fw_status_" + id]);
    return;
  }
  await renderInto(id, cfg);
}

// stop managing a folder: remove its rows and forget it
async function detach(id) {
  const cfg = (await browser.storage.local.get("fw_config_" + id))["fw_config_" + id];
  await clearGenerated(id, cfg ? weatherLink(cfg.city) : undefined);
  await browser.storage.local.remove(["fw_config_" + id, "fw_status_" + id]);
}

// --- full pass: onboard, then refresh everything we remember ----------
async function fullUpdate() {
  await onboard();
  const all = await browser.storage.local.get(null);
  for (const key of Object.keys(all)) {
    if (key.startsWith("fw_config_")) await renderOne(key.slice("fw_config_".length));
  }
}

// event-driven pass: onboard, then render only the folders that just changed.
// onboard() returns [] for our own row writes, so rendering doesn't loop.
async function onboardChanged() {
  const changed = await onboard();
  for (const id of changed) await renderOne(id);
}

// --- scheduling ---------------------------------------------
async function scheduleAlarm() {
  const s = await getSettings();
  const existing = await browser.alarms.get("tick");
  // only (re)create when missing or the period changed, so frequent event-page
  // wake-ups don't keep resetting the alarm clock
  if (!existing || existing.periodInMinutes !== s.updateMinutes) {
    browser.alarms.create("tick", { periodInMinutes: s.updateMinutes });
  }
}

browser.alarms.onAlarm.addListener((a) => {
  if (a.name === "tick") enqueue(fullUpdate);
});

// Settings change (from the options page) → reschedule + refresh now.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.fw_settings) {
    scheduleAlarm();
    enqueue(fullUpdate);
  }
});

// --- messages from the options page (it never renders directly) --------
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === "render")     return enqueue(() => renderOne(msg.id));
  if (msg.type === "detach")     return enqueue(() => detach(msg.id));
  if (msg.type === "refreshAll") return enqueue(fullUpdate);
});

// --- live reaction to bookmark edits (near-instant quick-add) ----------
let _debounce = null;
function scheduleOnboard() {
  clearTimeout(_debounce);
  _debounce = setTimeout(() => { enqueue(onboardChanged); }, 1200);
}
browser.bookmarks.onCreated.addListener(scheduleOnboard);
browser.bookmarks.onChanged.addListener(scheduleOnboard);
browser.bookmarks.onMoved.addListener(scheduleOnboard);

// Eager cleanup when a managed folder is deleted (no waiting for the tick).
browser.bookmarks.onRemoved.addListener((id) => {
  enqueue(async () => {
    const key = "fw_config_" + id;
    const cfg = (await browser.storage.local.get(key))[key];
    if (cfg) {
      await clearGenerated(id, weatherLink(cfg.city));
      await browser.storage.local.remove([key, "fw_status_" + id]);
    }
  });
});

// --- boot ---------------------------------------------------
// Listeners above are registered synchronously on every event-page wake.
// The actual initial render only runs on install/update/browser-start, not on
// every wake, so a wake can never race a user-triggered render.
browser.runtime.onInstalled.addListener(() => { scheduleAlarm(); enqueue(fullUpdate); });
browser.runtime.onStartup.addListener(() => { scheduleAlarm(); enqueue(fullUpdate); });
scheduleAlarm(); // make sure the alarm exists even on a bare wake

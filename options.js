// options.js — UI controller. Reuses the engine (engine.js) directly:
// getSettings, saveSettings, previewRows, geocode, renderInto, clearGenerated.

const $ = (id) => document.getElementById(id);

const TOKENS =
  "Now: {emoji} {temp} {feels} {wind} {windarrow} {rain} {humidity} {city}  ·  " +
  "Day: {sunrise} {sunset} {max} {min} {uv}  ·  " +
  "Rain: {nextrain} {rainat} {rainmm} {rainprob}  ·  Use | to split rows.";

// one-click folder-title templates
const TITLE_PRESETS = [
  { label: "Rotterdam 24°", value: "{city} {temp}°" },
  { label: "☀️ Rotterdam 24°", value: "{emoji} {city} {temp}°" },
  { label: "Rotterdam 24° ↑26 ↓14", value: "{city} {temp}° ↑{max} ↓{min}" },
  { label: "☀️ 24° Rotterdam", value: "{emoji} {temp}° {city}" },
  { label: "Rotterdam · rain {nextrain}", value: "{city} · rain {nextrain}" }
];

// fill a <select> with the presets; on pick, drop the value into `inputId`
function wirePreset(selectId, inputId) {
  const sel = $(selectId);
  for (const p of TITLE_PRESETS) {
    const o = document.createElement("option");
    o.value = p.value;
    o.textContent = p.label;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => {
    if (!sel.value) return;
    $(inputId).value = sel.value;
    sel.selectedIndex = 0; // reset back to the "Presets…" label
  });
}

// ---- small helpers ----------------------------------------
function flash(el, msg, ok) {
  el.textContent = msg;
  el.className = "status " + (ok ? "ok" : "err");
  if (msg) setTimeout(() => { if (el.textContent === msg) { el.textContent = ""; el.className = "status"; } }, 4000);
}

async function folderPath(id) {
  try {
    const parts = [];
    let cur = (await browser.bookmarks.get(id))[0];
    while (cur) {
      if (cur.title) parts.unshift(cur.title);
      if (!cur.parentId) break;
      cur = (await browser.bookmarks.get(cur.parentId))[0];
    }
    return parts.join(" / ") || "(root)";
  } catch (e) {
    return null; // folder missing
  }
}

// ---- folder picker ----------------------------------------
async function buildPicker() {
  const tree = await browser.bookmarks.getTree();
  const picker = $("folder-picker");
  picker.innerHTML = "";
  (function walk(nodes, depth) {
    for (const n of nodes) {
      if (n.url) continue;                 // folders only
      if (n.title) {
        const opt = document.createElement("option");
        opt.value = n.id;
        opt.textContent = " ".repeat(depth * 2) + (n.title || "(unnamed)");
        picker.appendChild(opt);
      }
      if (n.children) walk(n.children, n.title ? depth + 1 : depth);
    }
  })(tree, 0);
}

// ---- managed list -----------------------------------------
async function loadManaged() {
  const all = await browser.storage.local.get(null);
  const ids = Object.keys(all)
    .filter(k => k.startsWith("fw_config_"))
    .map(k => k.slice("fw_config_".length));

  const list = $("managed");
  list.innerHTML = "";
  $("managed-empty").hidden = ids.length > 0;

  for (const id of ids) {
    const cfg = all["fw_config_" + id];
    const status = all["fw_status_" + id];
    const path = await folderPath(id);

    const li = document.createElement("li");

    const meta = document.createElement("div");
    meta.className = "meta";
    const dot = status
      ? `<span class="dot ${status.ok ? "ok" : "err"}" title="${status.ok ? "OK" : (status.error || "error")}">${status.ok ? "●" : "▲"}</span> `
      : "";
    meta.innerHTML =
      `<div class="name">${dot}${escapeHtml(cfg.city)}</div>` +
      `<div class="path">${path === null ? "⚠ folder missing" : escapeHtml(path)}</div>` +
      `<div class="tmpl">${cfg.template ? escapeHtml(cfg.template) : "(global default)"}</div>` +
      (status && !status.ok && status.error ? `<div class="path" style="color:var(--err)">${escapeHtml(status.error)}</div>` : "");
    li.appendChild(meta);

    const btns = document.createElement("div");
    btns.className = "btns";
    btns.appendChild(mkBtn("Edit", "tiny ghost", () => editFolder(id, cfg)));
    btns.appendChild(mkBtn("Refresh", "tiny ghost", async (b) => {
      b.disabled = true; b.textContent = "…";
      await renderInto(id, cfg);
      await loadManaged();
    }));
    btns.appendChild(mkBtn("Detach", "tiny ghost danger", async () => {
      await clearGenerated(id);
      await browser.storage.local.remove(["fw_config_" + id, "fw_status_" + id]);
      await loadManaged();
    }));
    li.appendChild(btns);

    list.appendChild(li);
  }
}

function mkBtn(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- editor (attach + edit share one form) ----------------
function setEditMode(editing, city, template, titleTemplate) {
  $("editor-title").textContent = editing ? "Edit folder" : "Attach a folder";
  $("picker-field").hidden = editing;           // can't repoint an existing entry's folder
  $("cancel").hidden = !editing;
  $("city").value = city || "";
  $("template").value = template || "";
  $("title-template").value = titleTemplate || "";
  $("resolved").textContent = "";
  $("resolved").className = "resolved";
  $("preview").innerHTML = "";
}

function editFolder(id, cfg) {
  $("folder-id").value = id;
  setEditMode(true, cfg.city, cfg.template || "", cfg.titleTemplate || "");
  document.querySelector("#editor-title").scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetEditor() {
  $("folder-id").value = "";
  setEditMode(false, "", "", "");
}

async function doLookup() {
  const city = $("city").value.trim();
  const r = $("resolved");
  if (!city) { r.textContent = ""; return; }
  r.className = "resolved"; r.textContent = "Looking up…";
  const geo = await geocode(city);
  if (!geo) { r.className = "resolved err"; r.textContent = "✗ Not found — check the spelling."; return; }
  const where = [geo.name, geo.admin1, geo.country].filter(Boolean).join(", ");
  r.className = "resolved ok";
  r.textContent = `✓ ${where}  (${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)})`;
}

async function doPreview() {
  const city = $("city").value.trim();
  const box = $("preview");
  if (!city) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="prow">Loading…</div>`;
  const res = await previewRows(city, $("template").value, $("title-template").value);
  if (res.error) { box.innerHTML = `<div class="prow perr">${escapeHtml(res.error)}</div>`; return; }
  box.innerHTML = "";
  if (res.title) {
    const t = document.createElement("div");
    t.className = "ptitle";
    t.textContent = "📁 " + res.title;
    box.appendChild(t);
  }
  res.rows.forEach((row, i) => {
    const d = document.createElement("div");
    d.className = "prow";
    d.textContent = row;
    box.appendChild(d);
    if (i < res.rows.length - 1) {
      const s = document.createElement("div");
      s.className = "psep";
      box.appendChild(s);
    }
  });
}

async function doSave() {
  const editing = !!$("folder-id").value;
  const id = editing ? $("folder-id").value : $("folder-picker").value;
  const city = $("city").value.trim();
  const template = $("template").value.trim() || null;
  const titleTemplate = $("title-template").value.trim() || null;
  const st = $("editor-status");

  if (!id) { flash(st, "Pick a folder first.", false); return; }
  if (!city) { flash(st, "Enter a city.", false); return; }

  const geo = await geocode(city);
  if (!geo) { flash(st, "City not found — check spelling.", false); return; }

  const config = { city, template, titleTemplate };
  await browser.storage.local.set({ ["fw_config_" + id]: config });
  await renderInto(id, config);
  await loadManaged();
  resetEditor();
  flash(st, "Saved.", true);
}

// ---- global settings --------------------------------------
async function loadSettings() {
  const s = await getSettings();
  $("default-template").value = s.defaultTemplate;
  $("default-title").value = s.titleTemplate;
  $("interval").value = s.updateMinutes;
  $("dry-text").value = s.dryText;
  $("u-temp").value = s.units.temperature;
  $("u-wind").value = s.units.windSpeed;
  $("u-precip").value = s.units.precipitation;
  $("template").placeholder = s.defaultTemplate;
  $("title-template").placeholder = s.titleTemplate || "(global default)";
}

async function doSaveSettings() {
  const st = $("settings-status");
  const mins = Math.max(1, Math.min(1440, Number($("interval").value) || DEFAULTS.updateMinutes));
  await saveSettings({
    defaultTemplate: $("default-template").value.trim() || DEFAULTS.defaultTemplate,
    titleTemplate: $("default-title").value.trim(),
    dryText: $("dry-text").value,
    updateMinutes: mins,
    units: {
      temperature: $("u-temp").value,
      windSpeed: $("u-wind").value,
      precipitation: $("u-precip").value
    }
  });
  // saving fw_settings triggers background to reschedule + refresh everything
  await loadSettings();
  await loadManaged();
  flash(st, "Saved — folders will refresh on the new settings.", true);
}

// ---- wire up ----------------------------------------------
async function init() {
  $("tokens").textContent = TOKENS;
  wirePreset("title-preset", "title-template");
  wirePreset("default-title-preset", "default-title");
  await buildPicker();
  await loadSettings();
  await loadManaged();
  resetEditor();

  $("lookup").addEventListener("click", doLookup);
  $("preview-btn").addEventListener("click", doPreview);
  $("save").addEventListener("click", doSave);
  $("cancel").addEventListener("click", resetEditor);
  $("save-settings").addEventListener("click", doSaveSettings);
  $("city").addEventListener("change", doLookup);

  // keep the manage list fresh if folders change while the page is open
  browser.bookmarks.onRemoved.addListener(() => loadManaged());
  browser.bookmarks.onChanged.addListener(() => loadManaged());
}

init();

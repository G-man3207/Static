// Probe-log viewer. Loads the full log from the service worker and renders a
// searchable table of origins; each row expands to show per-ID probe counts
// for that origin. Also handles Export / Clear.
const fmt = (n) => n.toLocaleString();
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleString() : "—");

const totalProbesFor = (entry) => {
  let sum = 0;
  for (const c of Object.values(entry.idCounts || {})) sum += c;
  return sum;
};

const buildIdList = (entry) => {
  const box = document.createElement("div");
  box.className = "id-list";
  const ids = Object.entries(entry.idCounts || {}).sort((a, b) => b[1] - a[1]);
  for (const [id, count] of ids) {
    const row = document.createElement("div");
    row.className = "id-entry";
    const idSpan = document.createElement("span");
    idSpan.textContent = id;
    const cSpan = document.createElement("span");
    cSpan.className = "c";
    cSpan.textContent = fmt(count);
    row.appendChild(idSpan);
    row.appendChild(cSpan);
    box.appendChild(row);
  }
  return box;
};

const originMatches = (origin, entry, filter) => {
  if (!filter) return true;
  const f = filter.toLowerCase();
  if (origin.toLowerCase().includes(f)) return true;
  return Object.keys(entry.idCounts || {}).some((id) => id.toLowerCase().includes(f));
};

let fullData = null;

const render = (filter) => {
  const content = document.getElementById("content");
  content.innerHTML = "";
  if (!fullData) return;

  const origins = fullData.origins || {};
  const allEntries = Object.entries(origins);

  if (allEntries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML =
      '<p class="big">No probes logged yet.</p>' +
      "<p>Visit a site that fingerprints browser extensions " +
      "(LinkedIn, X, major e-commerce) and the log will populate here.</p>";
    content.appendChild(empty);
    document.getElementById("summary").textContent = "";
    return;
  }

  const filtered = allEntries
    .filter(([origin, entry]) => originMatches(origin, entry, filter))
    .sort((a, b) => totalProbesFor(b[1]) - totalProbesFor(a[1]));

  let grand = 0;
  for (const [, entry] of allEntries) grand += totalProbesFor(entry);

  document.getElementById("summary").textContent =
    fmt(filtered.length) +
    " of " +
    fmt(allEntries.length) +
    " origin" +
    (allEntries.length === 1 ? "" : "s") +
    "  ·  " +
    fmt(grand) +
    " total probes recorded  ·  " +
    fmt(fullData.cumulative || 0) +
    " probes blocked since install";

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = '<p class="big">No matches.</p>';
    content.appendChild(empty);
    return;
  }

  const table = document.createElement("table");
  table.className = "log-table";
  table.innerHTML =
    "<thead><tr>" +
    "<th>Origin</th>" +
    "<th class='num'>Unique IDs</th>" +
    "<th class='num'>Total probes</th>" +
    "<th>Last seen</th>" +
    "</tr></thead>";
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  for (const [origin, entry] of filtered) {
    const unique = Object.keys(entry.idCounts || {}).length;
    const total = totalProbesFor(entry);

    const tr = document.createElement("tr");
    tr.className = "origin-row";
    const caret = '<span class="caret">›</span> ';
    tr.innerHTML =
      "<td>" +
      caret +
      origin.replace(/</g, "&lt;") +
      "</td>" +
      "<td class='num'>" +
      fmt(unique) +
      "</td>" +
      "<td class='num'>" +
      fmt(total) +
      "</td>" +
      "<td>" +
      fmtDate(entry.lastUpdated) +
      "</td>";
    tbody.appendChild(tr);

    const detailTr = document.createElement("tr");
    detailTr.className = "detail-row";
    const detailTd = document.createElement("td");
    detailTd.colSpan = 4;
    detailTr.appendChild(detailTd);
    tbody.appendChild(detailTr);

    tr.addEventListener("click", () => {
      if (!detailTd.firstChild) detailTd.appendChild(buildIdList(entry));
      const list = detailTd.firstChild;
      const open = list.classList.toggle("open");
      tr.classList.toggle("open", open);
    });
  }

  content.appendChild(table);
};

const reload = async () => {
  try {
    fullData = await chrome.runtime.sendMessage({ type: "static_export_log" });
  } catch {
    fullData = null;
  }
  render(document.getElementById("search").value);
};

document.getElementById("search").addEventListener("input", (e) => render(e.target.value));

const bucketCount = (n) => {
  if (n < 2) return null; // drop: canary filter
  if (n < 6) return "2-5";
  if (n < 21) return "6-20";
  if (n < 101) return "21-100";
  if (n < 1001) return "101-1000";
  return "1000+";
};

// Anonymize the raw log for public sharing / aggregate research. Removes
// per-user timing signal (timestamps, cumulative counter), coarsens counts
// into log-scale buckets, drops single-occurrence IDs (canaries), and drops
// origins with too few surviving IDs (low-signal noise).
const buildShareableExport = (raw) => {
  const out = {
    schema: "static.probe-log.shareable.v1",
    exportMonth: new Date().toISOString().slice(0, 7),
    origins: {},
  };
  const originsIn = raw.origins || {};
  for (const origin of Object.keys(originsIn)) {
    const entry = originsIn[origin] || {};
    const ids = entry.idCounts || {};
    const buckets = {};
    for (const [id, count] of Object.entries(ids)) {
      const b = bucketCount(count);
      if (b) buckets[id] = b;
    }
    const surviving = Object.keys(buckets).length;
    if (surviving >= 3) {
      out.origins[origin] = { idBuckets: buckets };
    }
  }
  return out;
};

const downloadJson = (obj, filename) => {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
};

document.getElementById("export-raw").addEventListener("click", () => {
  if (!fullData) return;
  downloadJson(fullData, "static-probe-log-" + new Date().toISOString().slice(0, 10) + ".json");
});

document.getElementById("export-shareable").addEventListener("click", () => {
  if (!fullData) return;
  const shareable = buildShareableExport(fullData);
  const originCount = Object.keys(shareable.origins).length;
  if (originCount === 0) {
    alert(
      "Nothing to export yet — no origins have ≥3 IDs probed ≥2 times. " +
        "Visit a few sites that fingerprint extensions and try again."
    );
    return;
  }
  downloadJson(
    shareable,
    "static-probe-log-shareable-" + new Date().toISOString().slice(0, 7) + ".json"
  );
});

document.getElementById("clear").addEventListener("click", async () => {
  const ok = confirm("Clear all probe logs? This also resets the since-install counter.");
  if (!ok) return;
  try {
    await chrome.runtime.sendMessage({ type: "static_clear_log" });
    await reload();
  } catch {}
});

reload();

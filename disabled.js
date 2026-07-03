// Disabled-sites viewer. Loads the disabled_origins list from storage and
// renders a searchable table; each row has a Re-enable button to restore
// Static on that origin.

const fmt = (n) => n.toLocaleString();

const renderEmpty = () => {
  const content = document.getElementById("content");
  content.innerHTML = `<div class="empty-state">
    <p class="big">No sites are paused</p>
    <p>Use the site toggle in the popup to pause Static on a site.</p>
  </div>`;
};

const reenableOrigin = async (origin, button) => {
  button.disabled = true;
  try {
    await chrome.runtime.sendMessage({
      type: "static_set_site_disabled",
      disabled: false,
      origin,
    });
    // Remove the row from the UI
    const row = button.closest("tr");
    if (row) row.remove();
    updateSummary();
    // If table is empty, show empty state
    const tbody = document.querySelector(".disabled-table tbody");
    if (!tbody || tbody.children.length === 0) {
      document.querySelector(".disabled-table")?.remove();
      renderEmpty();
    }
  } catch (e) {
    console.error("[Static] re-enable failed", e);
    button.disabled = false;
  }
};

const renderTable = (origins) => {
  const content = document.getElementById("content");
  const sorted = [...origins].sort();

  const table = document.createElement("table");
  table.className = "disabled-table";

  const thead = document.createElement("thead");
  thead.innerHTML = `<tr><th>Origin</th><th class="action-cell"></th></tr>`;
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const origin of sorted) {
    const tr = document.createElement("tr");
    const originTd = document.createElement("td");
    originTd.className = "origin-cell";
    originTd.textContent = origin;

    const actionTd = document.createElement("td");
    actionTd.className = "action-cell";
    const btn = document.createElement("button");
    btn.className = "btn-reenable";
    btn.textContent = "Enable";
    btn.addEventListener("click", () => reenableOrigin(origin, btn));
    actionTd.appendChild(btn);

    tr.appendChild(originTd);
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  content.innerHTML = "";
  content.appendChild(table);
};

const updateSummary = () => {
  const rows = document.querySelectorAll(".disabled-table tbody tr");
  const summary = document.getElementById("summary");
  const count = rows.length;
  if (count > 0) {
    summary.textContent = `${fmt(count)} site${count === 1 ? "" : "s"} paused`;
  } else {
    summary.textContent = "";
  }
};

const filterTable = (query) => {
  const rows = document.querySelectorAll(".disabled-table tbody tr");
  const lower = query.toLowerCase();
  for (const row of rows) {
    const origin = row.querySelector(".origin-cell")?.textContent?.toLowerCase() || "";
    row.style.display = lower && !origin.includes(lower) ? "none" : "";
  }
  updateSummary();
};

(async () => {
  const { disabled_origins = {} } = await chrome.storage.local.get({
    disabled_origins: {},
  });

  const origins = Object.keys(disabled_origins).filter((o) => disabled_origins[o]);

  if (origins.length === 0) {
    renderEmpty();
    document.getElementById("reenable-all").disabled = true;
    return;
  }

  renderTable(origins);
  updateSummary();

  // Search filter
  const searchInput = document.getElementById("search");
  searchInput.addEventListener("input", () => filterTable(searchInput.value));

  // Re-enable all
  document.getElementById("reenable-all").addEventListener("click", async () => {
    const btn = document.getElementById("reenable-all");
    btn.disabled = true;
    try {
      const originsCopy = [...origins];
      for (const origin of originsCopy) {
        await chrome.runtime.sendMessage({
          type: "static_set_site_disabled",
          disabled: false,
          origin,
        });
      }
      document.querySelector(".disabled-table")?.remove();
      renderEmpty();
    } catch (e) {
      console.error("[Static] re-enable all failed", e);
      btn.disabled = false;
    }
  });
})();

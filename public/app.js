// public/app.js

async function postJSON(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  // try parse JSON; if not JSON, return { ok: res.ok }
  try { return await res.json(); }
  catch { return { ok: res.ok }; }
}

async function deleteFetch(url) {
  const res = await fetch(url, { method: 'DELETE' });
  try { return await res.json(); }
  catch { return { ok: res.ok }; }
}

function qs(selector, el = document) { return el.querySelector(selector); }
function qsa(selector, el = document) { return Array.from(el.querySelectorAll(selector)); }

// ----- Index page: create list -----
document.addEventListener('DOMContentLoaded', () => {
  const newListForm = qs('#newListForm');
  if (newListForm) {
    newListForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = newListForm.name.value.trim();
      if (!name) return alert('Name required');
      try {
        const r = await postJSON('/api/lists', { name });
        if (r.ok) {
          // go to the list page
          location.href = `/list/${encodeURIComponent(name)}`;
        } else {
          alert('Error: ' + JSON.stringify(r));
        }
      } catch (err) {
        console.error(err);
        alert('Network or server error');
      }
    });
  }

  // ----- List page: add item, delete, sync -----
  const addItemForm = qs('#addItemForm');
  if (addItemForm) {
    const pathParts = location.pathname.split('/');
    const listName = decodeURIComponent(pathParts[pathParts.length - 1]);
    const itemsEl = qs('#items');
    const logEl = qs('#log');

    // helper to append log lines
    function log(msg) {
      if (!logEl) return console.log(msg);
      logEl.textContent = (logEl.textContent ? logEl.textContent + '\n' : '') + msg;
    }

    addItemForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const source = addItemForm.source.value;
      const id = addItemForm.id.value.trim();
      if (!id) return alert('ID required');
      try {
        const r = await postJSON(`/api/lists/${encodeURIComponent(listName)}/items`, { source, id });
        if (r.ok) {
          location.reload();
        } else {
          alert('Error adding item: ' + JSON.stringify(r));
        }
      } catch (err) {
        console.error(err);
        alert('Network or server error');
      }
    });

    // delegated delete handler
    if (itemsEl) {
      itemsEl.addEventListener('click', async (e) => {
        const btn = e.target.closest('button.del');
        if (!btn) return;
        const idx = btn.dataset.index;
        if (typeof idx === 'undefined') return;
        if (!confirm('Delete this item?')) return;
        try {
          const resp = await deleteFetch(`/api/lists/${encodeURIComponent(listName)}/items/${idx}`);
          if (resp.ok || resp.success) location.reload();
          else {
            // some APIs return {ok:true} or just 200 status with no body
            if (resp && resp.ok === false) alert('Delete failed: ' + JSON.stringify(resp));
            else location.reload();
          }
        } catch (err) {
          console.error(err);
          alert('Network or server error during delete');
        }
      });
    }

    // Sync buttons
    const syncRadarrBtn = qs('#syncRadarr');
    const syncSonarrBtn = qs('#syncSonarr');

    async function disableButtons(val = true) {
      [syncRadarrBtn, syncSonarrBtn].forEach(b => { if (b) b.disabled = val; });
    }

    async function doSync(target) {
      if (!confirm(`Sync list "${listName}" to ${target}?`)) return;
      log(`Sync started: ${target}`);
      await disableButtons(true);
      try {
        const res = await postJSON(`/api/sync/${target}/${encodeURIComponent(listName)}`, {});
        log(`Result for ${target}:\n` + JSON.stringify(res, null, 2));
      } catch (err) {
        console.error(err);
        log('Sync error: ' + (err.message || err));
      } finally {
        await disableButtons(false);
      }
    }

    if (syncRadarrBtn) syncRadarrBtn.addEventListener('click', () => doSync('radarr'));
    if (syncSonarrBtn) syncSonarrBtn.addEventListener('click', () => doSync('sonarr'));
  } // end if addItemForm
}); // DOMContentLoaded

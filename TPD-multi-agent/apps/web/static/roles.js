(() => {
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#role-list");
  const statusEl = $("#status");
  const form = $("#role-form");
  const idInput = $("#role-id");
  const nameInput = $("#role-name");
  const descInput = $("#role-desc");
  const perspectiveInput = $("#role-perspective");
  const toolInput = $("#role-tool");
  const whenInput = $("#role-when");
  const systemInput = $("#role-system");
  const kindRt = $("#kind-roundtable");
  const kindCs = $("#kind-consult");
  const editorTitle = $("#editor-title");
  const btnDelete = $("#btn-delete");

  let creating = false;
  let currentId = null;

  function setStatus(msg, kind = "") {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? ` ${kind}` : "");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function blankRole() {
    return {
      id: "",
      name: "",
      description: "",
      kinds: ["roundtable"],
      perspective: "",
      tool: "",
      when: "",
      system: "",
    };
  }

  function fillForm(role, { isNew = false } = {}) {
    creating = isNew;
    currentId = isNew ? null : role.id;
    editorTitle.textContent = isNew ? "新建角色" : `编辑 · ${role.id}`;
    idInput.value = role.id || "";
    idInput.readOnly = !isNew;
    nameInput.value = role.name || "";
    descInput.value = role.description || "";
    perspectiveInput.value = role.perspective || "";
    toolInput.value = role.tool || "";
    whenInput.value = role.when || "";
    systemInput.value = role.system || "";
    const kinds = role.kinds || [];
    kindRt.checked = kinds.includes("roundtable");
    kindCs.checked = kinds.includes("consult");
    btnDelete.hidden = isNew;
    setStatus(isNew ? "填写后保存为新角色" : `已加载 ${role.id}`);
  }

  function collectPayload() {
    const kinds = [];
    if (kindRt.checked) kinds.push("roundtable");
    if (kindCs.checked) kinds.push("consult");
    return {
      id: idInput.value.trim(),
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      kinds,
      perspective: perspectiveInput.value.trim(),
      tool: toolInput.value.trim(),
      when: whenInput.value.trim(),
      system: systemInput.value.trim(),
    };
  }

  async function refreshList(selectId) {
    const res = await fetch("/api/roles");
    if (!res.ok) throw new Error(`列表失败 ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<li class="empty">暂无角色</li>`;
      return items;
    }
    items.forEach((r) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pack-item";
      if (selectId && r.id === selectId) btn.setAttribute("aria-current", "true");
      const kinds = (r.kinds || []).join(" · ") || "—";
      btn.innerHTML = `<strong>${escapeHtml(r.id)}</strong>
        <span class="sub">${escapeHtml(r.name)} · ${escapeHtml(kinds)}</span>`;
      btn.addEventListener("click", () => openRole(r.id));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
    return items;
  }

  async function openRole(id) {
    setStatus(`加载 ${id}…`);
    const res = await fetch(`/api/roles/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `打开失败 ${res.status}`, "error");
      return;
    }
    fillForm(data, { isNew: false });
    await refreshList(id);
  }

  $("#btn-new").addEventListener("click", () => {
    fillForm(blankRole(), { isNew: true });
    [...listEl.querySelectorAll(".pack-item")].forEach((b) => b.removeAttribute("aria-current"));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = collectPayload();
    if (!payload.kinds.length) {
      setStatus("至少勾选一种 kind", "error");
      return;
    }
    const btn = $("#btn-save");
    btn.disabled = true;
    setStatus("保存中…");
    try {
      const url = creating
        ? "/api/roles"
        : `/api/roles/${encodeURIComponent(currentId || payload.id)}`;
      const res = await fetch(url, {
        method: creating ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `保存失败 ${res.status}`, "error");
        return;
      }
      fillForm(data, { isNew: false });
      await refreshList(data.id);
      setStatus(`已保存 ${data.id}`, "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    } finally {
      btn.disabled = false;
    }
  });

  btnDelete.addEventListener("click", async () => {
    if (!currentId) return;
    if (!confirm(`确认删除角色 ${currentId}？Pack 仍可内联引用该 id，但不再从角色库合并。`)) {
      return;
    }
    setStatus("删除中…");
    try {
      const res = await fetch(`/api/roles/${encodeURIComponent(currentId)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `删除失败 ${res.status}`, "error");
        return;
      }
      const items = await refreshList();
      if (items.length) await openRole(items[0].id);
      else fillForm(blankRole(), { isNew: true });
      setStatus(`已删除 ${currentId}`, "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });

  refreshList()
    .then((items) => {
      if (items.length) return openRole(items[0].id);
      fillForm(blankRole(), { isNew: true });
    })
    .catch((err) => setStatus(String(err.message || err), "error"));
})();

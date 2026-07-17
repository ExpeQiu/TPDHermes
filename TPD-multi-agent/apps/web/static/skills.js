(() => {
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#skill-list");
  const statusEl = $("#status");
  const form = $("#skill-form");
  const idInput = $("#skill-id");
  const nameInput = $("#skill-name");
  const descInput = $("#skill-desc");
  const kindInput = $("#skill-kind");
  const runtimeInput = $("#skill-runtime");
  const entryInput = $("#skill-entry");
  const whenInput = $("#skill-when");
  const riskInput = $("#skill-risk");
  const enabledInput = $("#skill-enabled");
  const safeInput = $("#skill-safe");
  const editorTitle = $("#editor-title");
  const btnDelete = $("#btn-delete");
  const importMd = $("#import-md");

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

  function blankSkill() {
    return {
      id: "",
      name: "",
      description: "",
      kind: "tool",
      runtime: "builtin",
      entry: "",
      when: "",
      risk: "none",
      enabled: true,
      agent_safe: true,
    };
  }

  function fillForm(skill, { isNew = false } = {}) {
    creating = isNew;
    currentId = isNew ? null : skill.id;
    editorTitle.textContent = isNew ? "新建 Skill" : `编辑 · ${skill.id}`;
    idInput.value = skill.id || "";
    idInput.readOnly = !isNew;
    nameInput.value = skill.name || "";
    descInput.value = skill.description || "";
    kindInput.value = skill.kind || "tool";
    runtimeInput.value = skill.runtime || "builtin";
    entryInput.value = skill.entry || "";
    whenInput.value = skill.when || "";
    riskInput.value = skill.risk || "none";
    enabledInput.checked = skill.enabled !== false;
    safeInput.checked = skill.agent_safe !== false;
    btnDelete.hidden = isNew;
    setStatus(isNew ? "填写后保存为新 Skill" : `已加载 ${skill.id}`);
  }

  function collectPayload() {
    return {
      id: idInput.value.trim(),
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      kind: kindInput.value,
      runtime: runtimeInput.value,
      entry: entryInput.value.trim(),
      when: whenInput.value.trim(),
      risk: riskInput.value,
      enabled: enabledInput.checked,
      agent_safe: safeInput.checked,
    };
  }

  async function refreshList(selectId) {
    const res = await fetch("/api/skills");
    if (!res.ok) throw new Error(`列表失败 ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<li class="empty">暂无 Skill</li>`;
      return items;
    }
    items.forEach((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pack-item";
      if (selectId && s.id === selectId) btn.setAttribute("aria-current", "true");
      const off = s.enabled ? "" : " · 已禁用";
      btn.innerHTML = `<strong>${escapeHtml(s.id)}</strong>
        <span class="sub">${escapeHtml(s.name)} · ${escapeHtml(s.kind)}/${escapeHtml(
        s.runtime
      )}${off}</span>`;
      btn.addEventListener("click", () => openSkill(s.id));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
    return items;
  }

  async function openSkill(id) {
    setStatus(`加载 ${id}…`);
    const res = await fetch(`/api/skills/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `打开失败 ${res.status}`, "error");
      return;
    }
    fillForm(data, { isNew: false });
    await refreshList(id);
  }

  $("#btn-new").addEventListener("click", () => {
    fillForm(blankSkill(), { isNew: true });
    [...listEl.querySelectorAll(".pack-item")].forEach((b) => b.removeAttribute("aria-current"));
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = collectPayload();
    const btn = $("#btn-save");
    btn.disabled = true;
    setStatus("保存中…");
    try {
      const url = creating
        ? "/api/skills"
        : `/api/skills/${encodeURIComponent(currentId || payload.id)}`;
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
    if (!confirm(`确认删除 Skill ${currentId}？`)) return;
    setStatus("删除中…");
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(currentId)}`, {
        method: "DELETE",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `删除失败 ${res.status}`, "error");
        return;
      }
      const items = await refreshList();
      if (items.length) await openSkill(items[0].id);
      else fillForm(blankSkill(), { isNew: true });
      setStatus(`已删除 ${currentId}`, "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });

  $("#btn-import").addEventListener("click", async () => {
    const text = importMd.value.trim();
    if (!text) {
      setStatus("请粘贴 SKILL.md 内容", "error");
      return;
    }
    setStatus("导入中…");
    try {
      const res = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: text, source: "paste" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `导入失败 ${res.status}`, "error");
        return;
      }
      importMd.value = "";
      fillForm(data, { isNew: false });
      await refreshList(data.id);
      setStatus(`已导入 ${data.id}`, "ok");
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });

  refreshList()
    .then((items) => {
      if (items.length) return openSkill(items[0].id);
      fillForm(blankSkill(), { isNew: true });
    })
    .catch((err) => setStatus(String(err.message || err), "error"));
})();

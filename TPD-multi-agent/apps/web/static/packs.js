(() => {
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#pack-list");
  const rolesEl = $("#roles");
  const expertsEl = $("#experts");
  const statusEl = $("#status");
  const form = $("#pack-form");
  const idInput = $("#pack-id");
  const nameInput = $("#pack-name");
  const descInput = $("#pack-desc");
  const editorTitle = $("#editor-title");

  let creating = false;
  let currentId = null;
  let catalog = [];

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

  async function loadCatalog() {
    const res = await fetch("/api/roles");
    if (!res.ok) throw new Error(`角色库加载失败 ${res.status}`);
    const data = await res.json();
    catalog = data.items || [];
    fillImportSelects();
  }

  function fillImportSelects() {
    const rt = $("#import-roundtable");
    const cs = $("#import-consult");
    const fill = (sel, kind) => {
      sel.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = kind === "roundtable" ? "从角色库选圆桌…" : "从角色库选专家…";
      sel.appendChild(placeholder);
      catalog
        .filter((r) => (r.kinds || []).includes(kind))
        .forEach((r) => {
          const opt = document.createElement("option");
          opt.value = r.id;
          opt.textContent = `${r.id} · ${r.name}`;
          sel.appendChild(opt);
        });
    };
    fill(rt, "roundtable");
    fill(cs, "consult");
  }

  async function importRole(kind) {
    const sel = kind === "roundtable" ? $("#import-roundtable") : $("#import-consult");
    const rid = sel.value;
    if (!rid) {
      setStatus("请先选择角色", "error");
      return;
    }
    const res = await fetch(`/api/roles/${encodeURIComponent(rid)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `导入失败 ${res.status}`, "error");
      return;
    }
    const existing = collectRows(
      kind === "roundtable" ? rolesEl : expertsEl,
      kind === "roundtable" ? "role" : "expert"
    );
    if (existing.some((x) => x.id === data.id)) {
      setStatus(`已存在 ${data.id}`, "error");
      return;
    }
    if (kind === "roundtable") {
      rolesEl.appendChild(
        roleCard(
          { id: data.id, name: data.name, perspective: data.perspective || "" },
          "role"
        )
      );
    } else {
      expertsEl.appendChild(
        roleCard(
          {
            id: data.id,
            name: data.name,
            tool: data.tool || `consult_${data.id}`,
            when: data.when || "",
          },
          "expert"
        )
      );
    }
    setStatus(`已导入 ${data.id}`, "ok");
  }

  function roleCard(data = {}, kind = "role") {
    const isExpert = kind === "expert";
    const wrap = document.createElement("div");
    wrap.className = "card-row";
    wrap.innerHTML = `
      <div class="card-grid">
        <label>id<input data-f="id" value="${escapeHtml(data.id || "")}" required /></label>
        <label>name<input data-f="name" value="${escapeHtml(data.name || "")}" required /></label>
        ${
          isExpert
            ? `<label>tool<input data-f="tool" value="${escapeHtml(data.tool || "")}" /></label>
               <label class="span2">when<input data-f="when" value="${escapeHtml(data.when || "")}" /></label>`
            : `<label class="span2">perspective<input data-f="perspective" value="${escapeHtml(
                data.perspective || ""
              )}" /></label>`
        }
      </div>
      <button type="button" class="btn-inline danger" data-remove aria-label="删除">删除</button>
    `;
    wrap.querySelector("[data-remove]").addEventListener("click", () => wrap.remove());
    return wrap;
  }

  function collectRows(container, kind) {
    return [...container.querySelectorAll(".card-row")].map((row) => {
      const get = (f) => (row.querySelector(`[data-f="${f}"]`)?.value || "").trim();
      if (kind === "expert") {
        return { id: get("id"), name: get("name"), tool: get("tool"), when: get("when") };
      }
      return { id: get("id"), name: get("name"), perspective: get("perspective") };
    });
  }

  function fillForm(pack, { isNew = false } = {}) {
    creating = isNew;
    currentId = isNew ? null : pack.id;
    editorTitle.textContent = isNew ? "新建 Pack" : `编辑 · ${pack.id}`;
    idInput.value = pack.id || "";
    idInput.readOnly = !isNew;
    nameInput.value = pack.name || "";
    descInput.value = pack.description || "";
    rolesEl.innerHTML = "";
    expertsEl.innerHTML = "";
    (pack.roundtable_roles || []).forEach((r) => rolesEl.appendChild(roleCard(r, "role")));
    (pack.consult_experts || []).forEach((e) => expertsEl.appendChild(roleCard(e, "expert")));
    if (!(pack.roundtable_roles || []).length) {
      rolesEl.appendChild(
        roleCard(
          { id: "moderator", name: "主持人", perspective: "控场、升维冲突、收束可执行方案" },
          "role"
        )
      );
    }
    setStatus(isNew ? "填写后保存为新 Pack" : `已加载 ${pack.id}`);
  }

  function blankPack() {
    return {
      id: "",
      name: "",
      description: "",
      roundtable_roles: [
        { id: "moderator", name: "主持人", perspective: "控场、升维冲突、收束可执行方案" },
        { id: "analyst", name: "分析师", perspective: "拆解目标与约束" },
      ],
      consult_experts: [
        { id: "domain", name: "领域专家", tool: "consult_domain", when: "需要领域判断" },
      ],
    };
  }

  async function refreshList(selectId) {
    const res = await fetch("/api/packs");
    if (!res.ok) throw new Error(`列表失败 ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    listEl.innerHTML = "";
    if (!items.length) {
      listEl.innerHTML = `<li class="empty">暂无 Pack</li>`;
      return items;
    }
    items.forEach((p) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "pack-item";
      if (selectId && p.id === selectId) btn.setAttribute("aria-current", "true");
      btn.innerHTML = `<strong>${escapeHtml(p.id)}</strong>
        <span class="sub">${escapeHtml(p.name)} · 角色 ${p.roles} · 专家 ${p.experts}</span>`;
      btn.addEventListener("click", () => openPack(p.id));
      li.appendChild(btn);
      listEl.appendChild(li);
    });
    return items;
  }

  async function openPack(id) {
    setStatus(`加载 ${id}…`);
    const res = await fetch(`/api/packs/${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || `打开失败 ${res.status}`, "error");
      return;
    }
    fillForm(data, { isNew: false });
    await refreshList(id);
  }

  $("#btn-new").addEventListener("click", () => {
    fillForm(blankPack(), { isNew: true });
    [...listEl.querySelectorAll(".pack-item")].forEach((b) => b.removeAttribute("aria-current"));
  });

  $("#btn-add-role").addEventListener("click", () => {
    rolesEl.appendChild(roleCard({ id: "", name: "", perspective: "" }, "role"));
  });

  $("#btn-add-expert").addEventListener("click", () => {
    expertsEl.appendChild(roleCard({ id: "", name: "", tool: "", when: "" }, "expert"));
  });

  $("#btn-import-roundtable").addEventListener("click", () => importRole("roundtable"));
  $("#btn-import-consult").addEventListener("click", () => importRole("consult"));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      id: idInput.value.trim(),
      name: nameInput.value.trim(),
      description: descInput.value.trim(),
      roundtable_roles: collectRows(rolesEl, "role"),
      consult_experts: collectRows(expertsEl, "expert"),
    };
    const btn = $("#btn-save");
    btn.disabled = true;
    setStatus("保存中…");
    try {
      const url = creating
        ? "/api/packs"
        : `/api/packs/${encodeURIComponent(currentId || payload.id)}`;
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

  Promise.all([refreshList(), loadCatalog()])
    .then(([items]) => {
      if (items.length) return openPack(items[0].id);
      fillForm(blankPack(), { isNew: true });
    })
    .catch((err) => setStatus(String(err.message || err), "error"));
})();

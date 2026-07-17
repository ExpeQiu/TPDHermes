(() => {
  const $ = (sel) => document.querySelector(sel);
  const mockEl = $("#mock-mode");
  const keyEl = $("#api-key");
  const baseEl = $("#api-base");
  const modelEl = $("#model");
  const keyHint = $("#key-hint");
  const llmMeta = $("#llm-meta");
  const llmStatus = $("#llm-status");
  const kbEl = $("#knowledge-base");
  const kbProbe = $("#kb-probe");
  const kbList = $("#kb-list");
  const kbStatus = $("#kb-status");

  let kbItems = [];
  let view = null;

  function setStatus(el, msg, kind = "") {
    el.textContent = msg || "";
    el.className = "status" + (kind ? ` ${kind}` : "");
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function applySettings(data) {
    view = data;
    const s = data.settings || {};
    mockEl.checked = Boolean(s.mock_mode);
    keyEl.value = "";
    keyEl.placeholder = s.has_api_key ? "已配置（留空保留 / 填新值覆盖）" : "粘贴 API Key";
    keyHint.textContent = s.has_api_key ? "已配置密钥（脱敏，不会回显明文）" : "未配置密钥；无 Key 时 Live 会强制 Mock";
    baseEl.value = s.api_base || "";
    modelEl.value = s.model || "gpt-4o-mini";

    const overrides = data.env_overrides || [];
    const overrideHint = overrides.length
      ? `环境变量覆盖：${overrides.join(", ")}（保存 yaml 后仍以 env 为准）`
      : "当前无环境变量覆盖";
    llmMeta.textContent = `生效 llm=${s.llm_mode || "?"} · 配置文件 ${data.config_path || "~/.multi-agent/config.yaml"} · ${overrideHint}`;

    if (kbEl.options.length) {
      const want = s.knowledge_base || "none";
      if ([...kbEl.options].some((o) => o.value === want)) kbEl.value = want;
    }
    renderProbe(kbEl.value);
  }

  function renderKbOptions(selected) {
    kbEl.innerHTML = "";
    if (!kbItems.length) {
      const opt = document.createElement("option");
      opt.value = "none";
      opt.textContent = "不绑定";
      kbEl.appendChild(opt);
      return;
    }
    kbItems.forEach((k) => {
      const opt = document.createElement("option");
      opt.value = k.id;
      const mark = k.id !== "none" && k.path_ok === false && !k.api_base ? "（不可用）" : "";
      opt.textContent = `${k.name || k.id}${mark}`;
      kbEl.appendChild(opt);
    });
    const want = selected || view?.settings?.knowledge_base || "none";
    if ([...kbEl.options].some((o) => o.value === want)) kbEl.value = want;
    else kbEl.selectedIndex = 0;
  }

  function renderKbList() {
    kbList.innerHTML = "";
    if (!kbItems.length) {
      kbList.innerHTML = `<li class="empty">暂无知识库条目</li>`;
      return;
    }
    kbItems.forEach((k) => {
      const li = document.createElement("li");
      const path = k.path ? escapeHtml(k.path) : "—";
      const api = k.api_base ? escapeHtml(k.api_base) : "—";
      const flags = [];
      if (k.id === "none") flags.push("不检索");
      else {
        flags.push(k.path_ok ? "path✓" : "path✗");
        flags.push(k.api_base ? "api" : "local");
        flags.push(k.available ? "可用" : "不可用");
      }
      li.innerHTML = `<strong>${escapeHtml(k.name || k.id)}</strong>
        <span class="sub">${escapeHtml(k.id)} · ${escapeHtml(flags.join(" · "))}</span>
        <span class="sub mono">path: ${path}</span>
        <span class="sub mono">api: ${api}</span>`;
      kbList.appendChild(li);
    });
  }

  function findKb(id) {
    return kbItems.find((k) => k.id === id) || null;
  }

  function renderProbe(id) {
    const k = findKb(id);
    if (!k) {
      kbProbe.innerHTML = `<p class="hint">未找到该知识库。</p>`;
      return;
    }
    if (k.id === "none") {
      kbProbe.innerHTML = `<p class="hint">当前为「不绑定」：运行时不注入外部检索上下文。</p>`;
      return;
    }
    const pathLine = k.path
      ? `路径 ${escapeHtml(k.path)} · ${k.path_ok ? "存在" : "不存在 / 不可用"}`
      : "未配置本地 path";
    const apiLine = k.api_base
      ? `检索 API ${escapeHtml(k.api_base)}`
      : "未配置 api_base（将尝试本地 wiki）";
    const avail = k.available ? "可用" : "不可用";
    kbProbe.innerHTML = `
      <p class="probe-title">${escapeHtml(k.name || k.id)} · ${avail}</p>
      <p class="hint tight">${pathLine}</p>
      <p class="hint tight">${apiLine}</p>
      <p class="hint tight">${escapeHtml(k.description || "")}</p>`;
  }

  async function loadSettings() {
    const res = await fetch("/api/settings");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `加载设置失败 ${res.status}`);
    applySettings(data);
    return data;
  }

  async function loadKnowledgeBases() {
    const res = await fetch("/api/knowledge-bases");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `加载知识库失败 ${res.status}`);
    kbItems = data.items || [];
    renderKbOptions(view?.settings?.knowledge_base);
    renderKbList();
    renderProbe(kbEl.value);
  }

  async function savePatch(patch, statusEl) {
    setStatus(statusEl, "保存中…");
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(statusEl, data.error || `保存失败 ${res.status}`, "error");
      return null;
    }
    applySettings(data);
    setStatus(statusEl, "已保存", "ok");
    return data;
  }

  $("#llm-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const patch = {
      mock_mode: mockEl.checked,
      api_base: baseEl.value.trim(),
      model: modelEl.value.trim(),
    };
    const key = keyEl.value.trim();
    if (key) patch.api_key = key;
    try {
      await savePatch(patch, llmStatus);
      keyEl.value = "";
    } catch (err) {
      setStatus(llmStatus, String(err.message || err), "error");
    }
  });

  $("#kb-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await savePatch({ knowledge_base: kbEl.value }, kbStatus);
      renderProbe(kbEl.value);
    } catch (err) {
      setStatus(kbStatus, String(err.message || err), "error");
    }
  });

  kbEl.addEventListener("change", () => {
    renderProbe(kbEl.value);
    setStatus(kbStatus, "");
  });

  $("#btn-probe-kb").addEventListener("click", async () => {
    setStatus(kbStatus, "检测中…");
    try {
      await loadKnowledgeBases();
      const k = findKb(kbEl.value);
      if (!k) {
        setStatus(kbStatus, "未找到条目", "error");
        return;
      }
      if (k.id === "none" || k.available) {
        setStatus(kbStatus, k.id === "none" ? "不绑定 · 跳过检索" : "检测通过：可用", "ok");
      } else {
        setStatus(kbStatus, "检测未通过：path 不可用且无可用 api_base", "error");
      }
      renderProbe(kbEl.value);
    } catch (err) {
      setStatus(kbStatus, String(err.message || err), "error");
    }
  });

  Promise.all([loadSettings(), loadKnowledgeBases()])
    .then(() => {
      renderKbOptions(view?.settings?.knowledge_base);
      renderProbe(kbEl.value);
      setStatus(llmStatus, "已加载");
    })
    .catch((err) => {
      setStatus(llmStatus, String(err.message || err), "error");
      setStatus(kbStatus, String(err.message || err), "error");
    });
})();

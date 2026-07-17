(() => {
  const $ = (sel) => document.querySelector(sel);
  const out = $("#out");
  const statusEl = $("#status");
  const meta = $("#meta");
  const goalEl = $("#goal");
  const packEl = $("#pack");
  const kbEl = $("#kb");
  const modesEl = $("#modes");
  const discussEl = $("#discuss-modes");
  const roundsEl = $("#rounds");
  const roundtableExtra = $("#roundtable-extra");
  const runHint = $("#run-hint");

  let mode = "auto";
  let discussionMode = "round_robin";
  let rounds = 2;
  let tab = "delivery";
  let current = null;
  let runsCache = [];

  const MODE_OPTIONS = [
    {
      id: "auto",
      title: "自动选型",
      desc: "按目标特征挑选圆桌 / Consult / Swarm，再进入对应流转",
    },
    {
      id: "roundtable",
      title: "圆桌辩论",
      desc: "多角色共享会话、交锋后由主持人收束唯一方案",
    },
    {
      id: "consult",
      title: "主控 Consult",
      desc: "主控持有对话权，按需调用专家工具箱后统一交付",
    },
    {
      id: "swarm",
      title: "Swarm 并行",
      desc: "拆成弱依赖子任务并行执行，再 Rollup 成端到端交付",
    },
  ];

  const DISCUSS_OPTIONS = [
    {
      id: "round_robin",
      title: "轮流发言",
      desc: "专家按顺序依次发言，讨论更有条理",
    },
    {
      id: "parallel",
      title: "并行模式",
      desc: "同轮专家同时发言，讨论更高效",
    },
    {
      id: "debate",
      title: "正反方辩论",
      desc: "正反方交替发言，裁判点评后收束",
    },
  ];

  const MODE_FLOWS = {
    auto: {
      title: "自动选型 · 选型后进入对应模式",
      blurb: "不预先锁定编排；由选型器按目标特征挑一种模式，再按该模式的流转执行。",
      steps: [
        { label: "目标输入", detail: "用户给出 goal / 议题" },
        { label: "模式选型", detail: "开放需冲突 → 圆桌；需统一叙事 → Consult；可拆并行 → Swarm" },
        { label: "进入子模式", detail: "沿用所选模式的协调者与信息流" },
        { label: "唯一交付", detail: "对用户只输出一份 delivery + 全量轨迹" },
      ],
      rule: "嵌套时仍只保留一层协调者对用户负责。",
    },
    roundtable: {
      title: "圆桌 · 辩论交锋后融合",
      blurb: "主持人控场；多角色共享会话；冲突暴露盲区后收束方案。讨论方式见下方细分。",
      steps: [
        { label: "开场", detail: "主持人定议题、立规则" },
        { label: "专家发言", detail: "按所选讨论模式发声（轮流 / 并行 / 辩论）" },
        { label: "升维冲突", detail: "主持人推动对立交锋，防跑题" },
        { label: "收束交付", detail: "主持人综合共识与分歧 → 唯一 delivery" },
      ],
      rule: "上下文共享全场对话；价值在观点质量，不在盲目并行。",
    },
    consult: {
      title: "Consult · 主控调用专家工具箱",
      blurb: "主控是 Owner；专家按需 Consult，输出回主控综合，不对用户抢场。",
      steps: [
        { label: "主控接单", detail: "持有全局目标与用户对话权" },
        { label: "按需咨询", detail: "依 Pack 专家链（可裁剪）串行调用 Input→Output" },
        { label: "主控综合", detail: "专家结论内化，统一口吻与策略" },
        { label: "唯一交付", detail: "主控输出 delivery；专家过程写入轨迹" },
      ],
      rule: "专家是工具不是平等发言人；禁止把原始专家回复原样甩给用户。",
    },
    swarm: {
      title: "Swarm · 分解并行再聚合",
      blurb: "Orchestrator 拆任务；子 Agent 独立执行；Rollup 聚合成端到端交付。",
      steps: [
        { label: "任务分解", detail: "Orchestrator 切成弱依赖子任务" },
        { label: "上下文分片", detail: "子 Agent 只拿局部输入，互不共享可变状态" },
        { label: "并行执行", detail: "多路同时跑，以最慢子路径衡量关键路径" },
        { label: "Rollup 交付", detail: "Orchestrator 聚合精炼结论 → 唯一 delivery" },
      ],
      rule: "子任务独立完成、独立交付；禁止强依赖链硬并行。",
    },
  };

  const DISCUSS_FLOWS = {
    round_robin: {
      title: "圆桌 · 轮流发言",
      blurb: "专家按固定顺序依次发言；同轮内串行，利于承接与反驳。",
      steps: [
        { label: "开场立规", detail: "主持人定议题、发言顺序与收束标准" },
        { label: "顺序发言", detail: "Pack 角色按席位串行发声，可读前文" },
        { label: "升维冲突", detail: "主持人点名对立视角，防跑题与复读" },
        { label: "收束交付", detail: "综合共识与分歧 → 唯一 Master Plan" },
      ],
      rule: "共享全场上下文；适合需要条理与承接的议题。",
    },
    parallel: {
      title: "圆桌 · 并行发言",
      blurb: "同轮专家同时独立发言，再由主持人对照差异升维。",
      steps: [
        { label: "开场立规", detail: "主持人定议题与本轮并行约束" },
        { label: "同轮并行", detail: "专家只拿议题上下文，互不读彼此草稿" },
        { label: "对照升维", detail: "主持人汇总分歧点，推动下一轮或收束" },
        { label: "收束交付", detail: "聚合并行观点 → 唯一 delivery" },
      ],
      rule: "并行换吞吐，不共享可变草稿；价值在多路盲区对照。",
    },
    debate: {
      title: "圆桌 · 正反方辩论",
      blurb: "正反方交替交锋，裁判点评后收束；未指定阵营时引擎自动均分。",
      steps: [
        { label: "分边立规", detail: "划分正 / 反 / 裁判（默认可由主持人兼任）" },
        { label: "交替交锋", detail: "正反方轮流立论、反驳，暴露冲突" },
        { label: "裁判点评", detail: "裁判判定有效论据与缺口" },
        { label: "收束交付", detail: "裁判 / 主持人输出可执行方案" },
      ],
      rule: "辩论为暴露盲区，不是赢输；最终仍只交付一份方案。",
    },
  };

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderModeCards(container, options, selected, onSelect) {
    container.innerHTML = "";
    options.forEach((opt) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mode";
      btn.dataset.mode = opt.id;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-pressed", String(opt.id === selected));
      btn.innerHTML = `
        <span class="mode-radio" aria-hidden="true"></span>
        <span class="mode-copy">
          <span class="mode-title">${escapeHtml(opt.title)}</span>
          <span class="mode-desc">${escapeHtml(opt.desc)}</span>
        </span>`;
      btn.addEventListener("click", () => onSelect(opt.id));
      container.appendChild(btn);
    });
  }

  function syncModeUI() {
    renderModeCards(modesEl, MODE_OPTIONS, mode, (id) => {
      mode = id;
      syncModeUI();
      renderFlow();
      updateRunHint();
    });
    const showDiscuss = mode === "roundtable";
    roundtableExtra.hidden = !showDiscuss;
    if (showDiscuss) {
      renderModeCards(discussEl, DISCUSS_OPTIONS, discussionMode, (id) => {
        discussionMode = id;
        syncModeUI();
        renderFlow();
        updateRunHint();
      });
      roundsEl.innerHTML = "";
      [1, 2, 3, 4, 5].forEach((n) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "round-btn";
        b.textContent = String(n);
        b.setAttribute("aria-pressed", String(n === rounds));
        b.addEventListener("click", () => {
          rounds = n;
          syncModeUI();
          updateRunHint();
        });
        roundsEl.appendChild(b);
      });
    }
  }

  function flowData() {
    if (mode === "roundtable") {
      return DISCUSS_FLOWS[discussionMode] || DISCUSS_FLOWS.round_robin;
    }
    return MODE_FLOWS[mode] || MODE_FLOWS.auto;
  }

  function renderFlow() {
    const flowEl = $("#flow");
    const data = flowData();
    flowEl.innerHTML = `
      <p class="flow-title">${escapeHtml(data.title)}</p>
      <p class="flow-blurb">${escapeHtml(data.blurb)}</p>
      <ol class="flow-steps">
        ${data.steps
          .map(
            (s, i) => `
          <li>
            <span class="flow-idx">${i + 1}</span>
            <div>
              <strong>${escapeHtml(s.label)}</strong>
              <span class="flow-detail">${escapeHtml(s.detail)}</span>
            </div>
          </li>`
          )
          .join("")}
      </ol>
      <p class="flow-rule">${escapeHtml(data.rule)}</p>
    `;
  }

  function discussLabel() {
    const hit = DISCUSS_OPTIONS.find((o) => o.id === discussionMode);
    return hit ? hit.title : discussionMode;
  }

  function updateRunHint() {
    if (mode === "roundtable") {
      runHint.textContent = `即将：圆桌 · ${discussLabel()} · ${rounds} 轮 · Pack 与知识库见上。`;
    } else {
      const hit = MODE_OPTIONS.find((o) => o.id === mode);
      runHint.textContent = `即将：${hit ? hit.title : mode}。执行走本机 Runtime；日志见 stderr / logs/web.log。`;
    }
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => {
        b.setAttribute("aria-selected", String(b === btn));
      });
      render();
    });
  });

  function setStatus(msg, kind = "") {
    statusEl.textContent = msg || "";
    statusEl.className = "status" + (kind ? ` ${kind}` : "");
  }

  function renderMeta(env) {
    if (!env) {
      meta.innerHTML = "";
      return;
    }
    const discuss = env.meta?.discussion_mode;
    const pills = [
      env.run_id,
      env.mode,
      discuss ? `discuss:${discuss}` : null,
      env.coordinator,
      env.data_source ? `kb:${env.data_source}` : null,
      env.meta?.llm_mode ? `llm:${env.meta.llm_mode}` : null,
      env.status || "completed",
    ].filter(Boolean);
    meta.innerHTML = pills.map((p) => `<span class="pill">${escapeHtml(String(p))}</span>`).join("");
  }

  function render() {
    if (tab === "runs") {
      if (!runsCache.length) {
        out.textContent = "暂无历史 run。";
        return;
      }
      out.innerHTML = "";
      const ul = document.createElement("ul");
      ul.className = "run-list";
      runsCache.forEach((r) => {
        const li = document.createElement("li");
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<strong>${escapeHtml(r.id)}</strong><span class="sub">${escapeHtml(
          `${r.mode} · ${r.status} · ${r.title || ""}`
        )}</span>`;
        b.addEventListener("click", () => openRun(r.id));
        li.appendChild(b);
        ul.appendChild(li);
      });
      out.appendChild(ul);
      return;
    }

    if (!current) {
      out.textContent = "选择模式并输入目标，或从历史中打开一次 run。";
      renderMeta(null);
      return;
    }

    renderMeta(current.envelope || current);
    if (tab === "delivery") {
      out.textContent =
        (current.delivery ||
          current.envelope?.delivery?.body_markdown ||
          "") || "(空交付)";
    } else if (tab === "trajectory") {
      out.textContent = current.trajectory || "(无轨迹)";
    } else if (tab === "json") {
      out.textContent = JSON.stringify(current.envelope || current, null, 2);
    }
  }

  async function refreshRuns() {
    const res = await fetch("/api/runs");
    if (!res.ok) throw new Error(`加载列表失败 ${res.status}`);
    const data = await res.json();
    runsCache = data.items || [];
  }

  async function openRun(runId) {
    setStatus(`加载 ${runId}…`);
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    if (!res.ok) {
      setStatus(`打开失败 ${res.status}`, "error");
      return;
    }
    current = await res.json();
    tab = "delivery";
    document.querySelectorAll(".tab").forEach((b) => {
      b.setAttribute("aria-selected", String(b.dataset.tab === "delivery"));
    });
    setStatus(`已打开 ${runId}`, "ok");
    render();
  }

  async function runOnce() {
    const goal = goalEl.value.trim();
    if (!goal) {
      setStatus("请填写目标 / 议题", "error");
      return;
    }
    const btn = $("#btn-run");
    btn.disabled = true;
    setStatus("运行中…");
    try {
      const body = {
        goal,
        mode,
        pack: packEl.value,
        knowledge_base: kbEl.value || "none",
      };
      if (mode === "roundtable") {
        body.discussion_mode = discussionMode;
        body.rounds = rounds;
        body.moderator_enabled = true;
      }
      const res = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(data.error || `失败 ${res.status}`, "error");
        return;
      }
      current = data;
      tab = "delivery";
      document.querySelectorAll(".tab").forEach((b) => {
        b.setAttribute("aria-selected", String(b.dataset.tab === "delivery"));
      });
      await refreshRuns();
      setStatus(`完成 · ${data.envelope?.run_id || ""}`, "ok");
      render();
    } catch (err) {
      setStatus(String(err.message || err), "error");
    } finally {
      btn.disabled = false;
    }
  }

  $("#btn-run").addEventListener("click", runOnce);
  $("#btn-refresh").addEventListener("click", async () => {
    try {
      await refreshRuns();
      tab = "runs";
      document.querySelectorAll(".tab").forEach((b) => {
        b.setAttribute("aria-selected", String(b.dataset.tab === "runs"));
      });
      setStatus(`已刷新 ${runsCache.length} 条`, "ok");
      render();
    } catch (err) {
      setStatus(String(err.message || err), "error");
    }
  });

  async function loadPacks() {
    const res = await fetch("/api/packs");
    if (!res.ok) throw new Error(`加载 Pack 失败 ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    packEl.innerHTML = "";
    if (!items.length) {
      const opt = document.createElement("option");
      opt.value = "nev-tech";
      opt.textContent = "nev-tech";
      packEl.appendChild(opt);
      return;
    }
    items.forEach((p, i) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name ? `${p.id} · ${p.name}` : p.id;
      if (i === 0) opt.selected = true;
      packEl.appendChild(opt);
    });
  }

  async function loadKnowledgeBases(preferredId) {
    const res = await fetch("/api/knowledge-bases");
    if (!res.ok) throw new Error(`加载知识库失败 ${res.status}`);
    const data = await res.json();
    const items = data.items || [];
    kbEl.innerHTML = "";
    if (!items.length) {
      const opt = document.createElement("option");
      opt.value = "none";
      opt.textContent = "不绑定";
      kbEl.appendChild(opt);
      return;
    }
    items.forEach((k) => {
      const opt = document.createElement("option");
      opt.value = k.id;
      const mark = k.id !== "none" && k.path_ok === false ? "（路径不可用）" : "";
      opt.textContent = k.name ? `${k.name}${mark}` : k.id;
      kbEl.appendChild(opt);
    });
    const want = preferredId || "none";
    if ([...kbEl.options].some((o) => o.value === want)) kbEl.value = want;
    else kbEl.selectedIndex = 0;
  }

  async function loadDefaultSettings() {
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return null;
      const data = await res.json();
      return data.settings || null;
    } catch {
      return null;
    }
  }

  syncModeUI();
  renderFlow();
  updateRunHint();

  goalEl.value = "半固态电池如何包装成抖音脚本";
  Promise.all([refreshRuns(), loadPacks(), loadDefaultSettings()])
    .then(async ([, , settings]) => {
      await loadKnowledgeBases(settings?.knowledge_base);
      if (settings?.default_pack && [...packEl.options].some((o) => o.value === settings.default_pack)) {
        packEl.value = settings.default_pack;
      }
      setStatus(`历史 ${runsCache.length} 条`);
    })
    .catch((err) => setStatus(String(err.message || err), "error"));
})();

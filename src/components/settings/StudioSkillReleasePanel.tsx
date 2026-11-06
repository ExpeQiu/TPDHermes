"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiGet, apiPut } from "@/lib/api";
import { STUDIO_SCENES, studioSkillStatusLabel, type StudioSkill } from "@/lib/studio-skills";

type SkillRow = StudioSkill & { released: boolean };

type ReleasePayload = {
  data_source: string;
  skills: SkillRow[];
};

export default function StudioSkillReleasePanel() {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [source, setSource] = useState("default");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((payload: ReleasePayload) => {
    setRows(payload.skills);
    setSource(payload.data_source);
  }, []);

  useEffect(() => {
    let alive = true;
    apiGet<ReleasePayload>("/system/studio-skills")
      .then((payload) => {
        if (alive) apply(payload);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : "加载技能卡失败");
      });
    return () => {
      alive = false;
    };
  }, [apply]);

  const openCount = useMemo(() => rows.filter((row) => row.released).length, [rows]);

  const toggle = (id: string) => {
    setSaved(false);
    setRows((current) => current.map((row) => (row.id === id ? { ...row, released: !row.released } : row)));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const payload = await apiPut<ReleasePayload>("/system/studio-skills", {
        released: Object.fromEntries(rows.map((row) => [row.id, row.released])),
      });
      apply(payload);
      setSaved(true);
      console.info("[settings] 技能卡释放已保存", {
        event: "settings.studio_skills.save",
        open_count: payload.skills.filter((row) => row.released).length,
        open_ids: payload.skills.filter((row) => row.released).map((row) => row.id),
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  if (error && rows.length === 0) {
    return <p className="mt-4 text-sm text-red-500 dark:text-red-400">{error}</p>;
  }
  if (rows.length === 0) {
    return <p className="mt-4 text-sm text-slate-500">读取技能卡…</p>;
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          已对用户开放 {openCount} / {rows.length}
          {source === "saved" ? " · 已保存" : " · 默认仅开放可验证卡片"}
        </p>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm text-white disabled:opacity-60 dark:bg-white dark:text-slate-900"
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
      {error ? <p className="text-sm text-red-500 dark:text-red-400">{error}</p> : null}
      {saved ? <p className="text-sm text-emerald-600 dark:text-emerald-400">已保存。场景创作侧栏会按这里的开关显示。</p> : null}
      <div className="space-y-6">
        {STUDIO_SCENES.map((scene) => {
          const sceneRows = rows.filter((row) => row.scene === scene);
          if (sceneRows.length === 0) return null;
          return (
            <section key={scene}>
              <h2 className="text-sm font-medium text-slate-900 dark:text-slate-100">{scene}</h2>
              <ul className="mt-2 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white/80 dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900/50">
                {sceneRows.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm text-slate-900 dark:text-slate-100">
                        <span className="mr-2 font-medium text-slate-500">{row.id}</span>
                        {row.name}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {row.phase} · {studioSkillStatusLabel(row)}
                        {row.status !== "ready" ? " · 仍在开发或验证，默认不开放" : ""}
                      </p>
                    </div>
                    <label className="flex shrink-0 items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                      <input
                        type="checkbox"
                        checked={row.released}
                        onChange={() => toggle(row.id)}
                        aria-label={`${row.name}对用户开放`}
                      />
                      对用户开放
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

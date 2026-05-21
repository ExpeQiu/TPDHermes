"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChatMarkdownBody } from "@/components/chat-markdown-body";
import {
  layoutScore,
  SkillPackageLayoutTags,
} from "@/components/skills/SkillPackageLayoutTags";
import { apiFetch, readJson } from "@/lib/api";
import { CONTENT_MAX_CLASS } from "@/lib/content-shell";
import { skillScopeLabel } from "@/lib/ui-labels";

interface SkillMeta {
  id: string;
  name: string;
  description: string;
  version: string;
  enabled: boolean;
  source: string;
  scope?: string;
  config: Record<string, unknown>;
  version_history: Array<{ version: string; changelog: string; installed_at: string }>;
  installed_at: string;
  updated_at: string;
}

interface PackageTreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  editable?: boolean;
  children?: PackageTreeNode[];
}

interface SkillPackage {
  name: string;
  standard_layout: Record<string, boolean>;
  tree: PackageTreeNode[];
}

interface PackageFilePayload {
  path: string;
  editable: boolean;
  binary?: boolean;
  size: number;
  content: string | null;
  message?: string;
}

const SKILLS_BASE = "/skills/";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function TreeList({
  nodes,
  depth,
  selectedPath,
  onSelect,
}: {
  nodes: PackageTreeNode[];
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <ul className={depth === 0 ? "space-y-0.5" : "ml-3 mt-0.5 space-y-0.5 border-l border-slate-300 dark:border-slate-700 pl-2"}>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.type === "dir" ? (
            <>
              <div
                className="flex items-center gap-1.5 py-1 text-xs font-medium text-slate-500"
                style={{ paddingLeft: depth * 4 }}
              >
                <span aria-hidden>📁</span>
                <span>{node.name}/</span>
              </div>
              {node.children && node.children.length > 0 && (
                <TreeList
                  nodes={node.children}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                />
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => onSelect(node.path)}
              className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition ${
                selectedPath === node.path
                  ? "bg-blue-600/20 text-blue-300"
                  : "text-slate-600 hover:bg-slate-200/80 dark:text-slate-300 dark:hover:bg-slate-800/80"
              }`}
              style={{ paddingLeft: 4 + depth * 4 }}
            >
              <span aria-hidden>{node.editable ? "📄" : "📦"}</span>
              <span className="truncate">{node.name}</span>
              {typeof node.size === "number" && (
                <span className="ml-auto shrink-0 text-[10px] text-slate-500">
                  {formatBytes(node.size)}
                </span>
              )}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function SkillDetailPage() {
  const params = useParams();
  const skillName = decodeURIComponent(String(params.name ?? ""));

  const [skill, setSkill] = useState<SkillMeta | null>(null);
  const [pkg, setPkg] = useState<SkillPackage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [fileEditable, setFileEditable] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileDirty, setFileDirty] = useState(false);
  const [previewMode, setPreviewMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const [creatingItem, setCreatingItem] = useState<string | null>(null);

  const showMsg = (msg: string) => {
    setActionMsg(msg);
    setTimeout(() => setActionMsg(""), 3000);
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [metaRes, pkgRes] = await Promise.all([
        apiFetch(`${SKILLS_BASE}${encodeURIComponent(skillName)}`),
        apiFetch(`${SKILLS_BASE}${encodeURIComponent(skillName)}/package`),
      ]);
      const meta = await readJson<SkillMeta>(metaRes);
      const packageData = await readJson<SkillPackage>(pkgRes);
      setSkill(meta);
      setPkg(packageData);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [skillName]);

  useEffect(() => {
    if (skillName) loadAll();
  }, [skillName, loadAll]);

  const loadFile = useCallback(
    async (relPath: string) => {
      setFileLoading(true);
      setSelectedPath(relPath);
      setFileDirty(false);
      try {
        const res = await apiFetch(
          `${SKILLS_BASE}${encodeURIComponent(skillName)}/package/file?path=${encodeURIComponent(relPath)}`,
        );
        const data = await readJson<PackageFilePayload>(res);
        setFileEditable(Boolean(data.editable));
        setFileContent(data.content ?? "");
        if (data.path.endsWith(".md")) setPreviewMode(true);
        else setPreviewMode(false);
        if (!data.editable && data.message) showMsg(data.message);
      } catch (e: unknown) {
        showMsg(`读取失败: ${e instanceof Error ? e.message : ""}`);
      } finally {
        setFileLoading(false);
      }
    },
    [skillName],
  );

  useEffect(() => {
    if (!pkg?.standard_layout["SKILL.md"]) return;
    if (!selectedPath) loadFile("SKILL.md");
  }, [pkg, selectedPath, loadFile]);

  const handleSaveFile = async () => {
    if (!selectedPath || !fileEditable) return;
    setSaving(true);
    try {
      const res = await apiFetch(
        `${SKILLS_BASE}${encodeURIComponent(skillName)}/package/file`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: selectedPath, content: fileContent }),
        },
      );
      await readJson(res);
      setFileDirty(false);
      showMsg("已保存");
      await loadAll();
    } catch (e: unknown) {
      showMsg(`保存失败: ${e instanceof Error ? e.message : ""}`);
    } finally {
      setSaving(false);
    }
  };

  const handleCreateLayoutItem = async (itemKey: string) => {
    setCreatingItem(itemKey);
    try {
      const res = await apiFetch(
        `${SKILLS_BASE}${encodeURIComponent(skillName)}/package/layout-item`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item: itemKey }),
        },
      );
      const data = await readJson<{ open_path?: string; path?: string; item: string }>(res);
      await loadAll();
      const open = data.open_path || data.path;
      if (open) await loadFile(open);
      showMsg(`已创建 ${itemKey}`);
    } catch (e: unknown) {
      showMsg(`创建失败: ${e instanceof Error ? e.message : ""}`);
    } finally {
      setCreatingItem(null);
    }
  };

  const handleToggle = async () => {
    if (!skill) return;
    try {
      const res = await apiFetch(`${SKILLS_BASE}${skill.name}/enable`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !skill.enabled }),
      });
      const updated = await readJson<SkillMeta>(res);
      setSkill(updated);
      showMsg(`${skill.name} 已${updated.enabled ? "启用" : "禁用"}`);
    } catch (e: unknown) {
      showMsg(`操作失败: ${e instanceof Error ? e.message : ""}`);
    }
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        加载技能详情…
      </main>
    );
  }

  if (error || !skill) {
    return (
      <main className="min-h-screen p-8">
        <div className={CONTENT_MAX_CLASS}>
          <Link href="/skills" className="text-sm text-slate-400 hover:text-white">
            ← 返回技能列表
          </Link>
          <p className="mt-6 text-red-400">{error || "技能不存在"}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-slate-100 p-4 text-slate-900 sm:p-6 md:p-8 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-white">
      <div className={CONTENT_MAX_CLASS}>
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Link href="/skills" className="text-sm text-slate-400 transition hover:text-slate-900 dark:hover:text-white">
              ← 技能策略
            </Link>
            <h1 className="mt-3 text-2xl font-bold sm:text-3xl">{skill.name}</h1>
            <p className="mt-1 max-w-2xl text-sm text-slate-500">
              {skill.description || "暂无描述"} · v{skill.version} · {skillScopeLabel(skill.scope)}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span
              className={`self-center rounded-full px-2.5 py-1 text-xs font-medium ${
                skill.enabled ? "bg-green-500/20 text-green-400" : "bg-orange-500/20 text-orange-400"
              }`}
            >
              {skill.enabled ? "已启用" : "已禁用"}
            </span>
            <button
              type="button"
              onClick={handleToggle}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
                skill.enabled
                  ? "border border-orange-600/40 bg-orange-600/20 text-orange-300"
                  : "bg-green-600 text-white hover:bg-green-500"
              }`}
            >
              {skill.enabled ? "禁用" : "启用"}
            </button>
          </div>
        </div>

        {actionMsg && (
          <div className="mb-4 rounded-lg border border-blue-600/40 bg-blue-600/20 px-4 py-3 text-sm text-blue-300">
            {actionMsg}
          </div>
        )}

        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/50 lg:col-span-2">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">标准 Skill 目录结构</h2>
            <pre className="mt-3 overflow-x-auto rounded-lg bg-slate-100 p-3 font-mono text-xs text-slate-700 dark:bg-slate-950 dark:text-slate-300">
{`${skill.name}/
├── SKILL.md          # 核心（Agent 规则）
├── scripts/          # 可选
├── references/       # 可选
└── assets/           # 可选`}
            </pre>
            <SkillPackageLayoutTags
              className="mt-4"
              layout={pkg?.standard_layout}
              mode="interactive"
              skillName={skill.name}
              creatingItem={creatingItem}
              onCreateItem={handleCreateLayoutItem}
              onOpenFile={loadFile}
            />
            <p className="mt-2 text-xs text-slate-500">
              标准布局符合度：{layoutScore(pkg?.standard_layout)}/4
            </p>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/80 p-4 dark:border-slate-800 dark:bg-slate-900/50">
            <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">元信息</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <div>
                <dt className="text-slate-500">来源</dt>
                <dd className="font-medium">{skill.source}</dd>
              </div>
              <div>
                <dt className="text-slate-500">安装</dt>
                <dd>{new Date(skill.installed_at).toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt className="text-slate-500">更新</dt>
                <dd>{new Date(skill.updated_at).toLocaleString("zh-CN")}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white/80 p-3 dark:border-slate-800 dark:bg-slate-900/50 lg:col-span-1">
            <h2 className="mb-2 px-1 text-sm font-semibold">包内文件</h2>
            {pkg?.tree && pkg.tree.length > 0 ? (
              <div className="max-h-[32rem] overflow-y-auto">
                <TreeList
                  nodes={pkg.tree}
                  depth={0}
                  selectedPath={selectedPath}
                  onSelect={loadFile}
                />
              </div>
            ) : (
              <p className="px-2 py-4 text-center text-xs text-slate-500">目录为空</p>
            )}
          </div>

          <div className="flex min-h-[24rem] flex-col rounded-xl border border-slate-200 bg-white/80 dark:border-slate-800 dark:bg-slate-900/50 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <span className="truncate font-mono text-xs text-slate-500">
                {selectedPath ?? "选择左侧文件查看或编辑"}
              </span>
              {selectedPath && fileEditable && (
                <div className="flex gap-2">
                  {selectedPath.endsWith(".md") && (
                    <button
                      type="button"
                      onClick={() => setPreviewMode((v) => !v)}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs dark:border-slate-600"
                    >
                      {previewMode ? "编辑" : "预览"}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!fileDirty || saving}
                    onClick={handleSaveFile}
                    className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              )}
            </div>

            <div className="flex-1 overflow-auto p-4">
              {fileLoading && (
                <p className="text-center text-sm text-slate-500">加载文件…</p>
              )}
              {!fileLoading && !selectedPath && (
                <p className="text-center text-sm text-slate-500">从文件树选择要查看的文件</p>
              )}
              {!fileLoading && selectedPath && !fileEditable && (
                <p className="text-center text-sm text-slate-500">该文件不支持在线预览，请本地打开技能目录</p>
              )}
              {!fileLoading && selectedPath && fileEditable && previewMode && selectedPath.endsWith(".md") && (
                <ChatMarkdownBody content={fileContent || "_（空）_"} />
              )}
              {!fileLoading && selectedPath && fileEditable && (!previewMode || !selectedPath.endsWith(".md")) && (
                <textarea
                  value={fileContent}
                  onChange={(e) => {
                    setFileContent(e.target.value);
                    setFileDirty(true);
                  }}
                  className="h-[28rem] w-full resize-y rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-xs text-slate-800 focus:border-blue-500 focus:outline-none dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200"
                  spellCheck={false}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

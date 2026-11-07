"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { apiDelete, apiGet, apiPost, apiPut } from "@/lib/api";

const STYLES = ["目标明确", "证据优先", "动作可追溯", "事实先行", "流程推进", "风险克制", "及时追问"];
const MODES = ["识别意图", "补齐信息", "调用技能", "确认后执行", "转人工"];

type Binding = {
  resource_type: string;
  resource_id: string;
  resource_version: string;
  internal: boolean;
};

type EmployeeDetail = {
  id: string;
  name: string;
  display_name: string;
  role_name: string;
  description: string;
  persona_prompt: string;
  onboarded_at: string;
  work_styles: string[];
  work_modes: string[];
  status: string;
  published_to_gallery: boolean;
  scenario_id: string;
  scenario_version: string;
  pack_id: string;
  bindings: Binding[];
  can_manage: boolean;
};

export default function EmployeeProfilePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [skill, setSkill] = useState("");
  const [skillVersion, setSkillVersion] = useState("1.0.0");
  const [knowledge, setKnowledge] = useState("");
  const [template, setTemplate] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [review, setReview] = useState("");

  const load = () => {
    apiGet<EmployeeDetail>(`/employees/${id}`)
      .then(setEmployee)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "加载失败"));
  };

  useEffect(() => {
    load();
  }, [id]);

  if (!employee) {
    return <p>{error || "加载档案…"}</p>;
  }

  const save = async () => {
    setError("");
    try {
      const saved = await apiPut<EmployeeDetail>(`/employees/${employee.id}`, {
        name: employee.name,
        role_name: employee.role_name,
        description: employee.description,
        persona_prompt: employee.persona_prompt,
        onboarded_at: employee.onboarded_at,
        work_styles: employee.work_styles,
        work_modes: employee.work_modes,
        scenario_id: employee.scenario_id,
        scenario_version: employee.scenario_version,
        pack_id: employee.pack_id,
        published_to_gallery: employee.published_to_gallery,
      });
      const bindings: Binding[] = [];
      if (employee.scenario_id) {
        bindings.push({
          resource_type: "scenario",
          resource_id: employee.scenario_id,
          resource_version: employee.scenario_version,
          internal: false,
        });
      }
      if (employee.pack_id) {
        bindings.push({
          resource_type: "pack",
          resource_id: employee.pack_id,
          resource_version: "",
          internal: false,
        });
      }
      for (const item of employee.bindings) {
        if (item.resource_type === "scenario" || item.resource_type === "pack") continue;
        bindings.push(item);
      }
      if (skill.trim()) {
        bindings.push({
          resource_type: "skill",
          resource_id: skill.trim(),
          resource_version: skillVersion.trim() || "1.0.0",
          internal: false,
        });
      }
      if (knowledge.trim()) {
        bindings.push({
          resource_type: "knowledge",
          resource_id: knowledge.trim(),
          resource_version: "",
          internal: false,
        });
      }
      if (template.trim()) {
        bindings.push({
          resource_type: "template",
          resource_id: template.trim(),
          resource_version: "",
          internal: false,
        });
      }
      const withBindings = await apiPut<EmployeeDetail>(`/employees/${employee.id}/bindings`, { items: bindings });
      setEmployee({ ...saved, bindings: withBindings.bindings });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  };

  const toggle = (list: string[], value: string) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

  return (
    <section aria-label="员工档案">
        <Link href="/ops/employees" className="text-sm text-slate-500">
          ← 花名册
        </Link>
        <h2 className="mt-3 text-2xl font-bold">{employee.display_name}</h2>
        <p className="mt-1 text-sm text-slate-500">
          这里改的是员工岗位：姓名、岗位、人设和绑定的场景合同。圆桌里的发言角色在
          <Link href="/ops/roles" className="mx-1 text-blue-600">
            P-team Roles
          </Link>
          修改，不在这张档案里。
          {employee.can_manage ? "" : "当前账号不能改这份原件，可以回广场复制一份再编辑。"}
        </p>
        {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <label className="text-sm">
            姓名
            <input disabled={!employee.can_manage} className="mt-1 w-full rounded-lg border px-3 py-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900" value={employee.name} onChange={(event) => setEmployee({ ...employee, name: event.target.value })} />
          </label>
          <label className="text-sm">
            岗位
            <input disabled={!employee.can_manage} className="mt-1 w-full rounded-lg border px-3 py-2 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900" value={employee.role_name} onChange={(event) => setEmployee({ ...employee, role_name: event.target.value })} />
          </label>
          <label className="text-sm md:col-span-2">
            职责
            <textarea className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.description} onChange={(event) => setEmployee({ ...employee, description: event.target.value })} />
          </label>
          <label className="text-sm md:col-span-2">
            人设
            <textarea className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.persona_prompt} onChange={(event) => setEmployee({ ...employee, persona_prompt: event.target.value })} />
          </label>
          <label className="text-sm">
            上岗日期
            <input className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.onboarded_at} onChange={(event) => setEmployee({ ...employee, onboarded_at: event.target.value })} />
          </label>
          <label className="text-sm">
            场景合同
            <input className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.scenario_id} onChange={(event) => setEmployee({ ...employee, scenario_id: event.target.value })} />
          </label>
          <label className="text-sm">
            场景版本
            <input className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.scenario_version} onChange={(event) => setEmployee({ ...employee, scenario_version: event.target.value })} />
          </label>
          <label className="text-sm">
            P-team 包 id
            <input className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" value={employee.pack_id} onChange={(event) => setEmployee({ ...employee, pack_id: event.target.value })} />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {STYLES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setEmployee({ ...employee, work_styles: toggle(employee.work_styles, item) })}
              className={`rounded-full px-3 py-1 text-sm ${employee.work_styles.includes(item) ? "bg-slate-900 text-white" : "bg-slate-100 dark:bg-slate-800"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {MODES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setEmployee({ ...employee, work_modes: toggle(employee.work_modes, item) })}
              className={`rounded-full px-3 py-1 text-sm ${employee.work_modes.includes(item) ? "bg-blue-600 text-white" : "bg-slate-100 dark:bg-slate-800"}`}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <input placeholder="技能名" value={skill} onChange={(event) => setSkill(event.target.value)} className="rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
          <input placeholder="技能版本" value={skillVersion} onChange={(event) => setSkillVersion(event.target.value)} className="rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
          <input placeholder="知识范围" value={knowledge} onChange={(event) => setKnowledge(event.target.value)} className="rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
          <input placeholder="模板 id" value={template} onChange={(event) => setTemplate(event.target.value)} className="rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900" />
        </div>
        <p className="mt-3 text-sm text-slate-500">
          已绑定 {employee.bindings.length} 项。场景编排仍在
          <Link href="/create" className="mx-1 text-blue-600">
            场景编排
          </Link>
          修改，这里只钉版本。
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={employee.published_to_gallery}
            onChange={(event) => setEmployee({ ...employee, published_to_gallery: event.target.checked })}
          />
          发布到广场
        </label>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={!employee.can_manage} onClick={() => void save()} className="rounded-lg bg-slate-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-white dark:text-slate-900">
            保存档案
          </button>
          <button
            type="button"
            className="rounded-lg border px-4 py-2"
            onClick={() => void apiPost(`/employees/${employee.id}/unpublish`, {}).then(load)}
          >
            下架
          </button>
          <button
            type="button"
            className="rounded-lg border px-4 py-2"
            onClick={() => void apiPost(`/employees/${employee.id}/archive`, {}).then(load)}
          >
            归档
          </button>
          <button
            type="button"
            className="rounded-lg border px-4 py-2"
            onClick={() =>
              void apiPost<{ token: string }>(`/employees/${employee.id}/credentials`, {}).then((data) => setToken(data.token))
            }
          >
            签发员工钥匙
          </button>
        </div>
        {token ? <p className="mt-3 break-all text-sm">钥匙只显示这一次：{token}</p> : null}
        <label className="mt-6 block text-sm">
          档案意见
          <textarea
            value={review}
            onChange={(event) => setReview(event.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
            placeholder="接受或拒绝某次成长建议时写在这里，不写入聊天。"
          />
        </label>
        <button
          type="button"
          className="mt-2 text-sm text-slate-500"
          onClick={() => {
            window.localStorage.setItem(`employee-review:${employee.id}`, review);
            setReview("");
          }}
        >
          记下这条意见
        </button>
        <button
          type="button"
          className="mt-6 block text-sm text-red-600"
          onClick={() => void apiDelete(`/employees/${employee.id}`).then(() => (window.location.href = "/ops/employees"))}
        >
          删除或转为归档
        </button>
    </section>
  );
}

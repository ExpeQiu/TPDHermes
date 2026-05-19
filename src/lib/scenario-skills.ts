/**
 * 从场景合同解析「绑定技能」展示与工坊执行用技能名列表。
 */

export type ScenarioSkillBinding = {
  name: string;
  source: "allowed" | "preferred" | "output";
  templatePath?: string;
  templateLabel?: string;
};

export type ParsedScenarioSkills = {
  mode: string;
  allowAgentFreeChoice: boolean;
  bindings: ScenarioSkillBinding[];
  /** 工坊 manual_only 执行时使用的技能名（去重） */
  runSkillNames: string[];
};

function normList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    const s = String(x).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const MODE_LABELS: Record<string, string> = {
  allowed_list: "强制白名单",
  manual_only: "指定技能执行",
  agent_select: "智能体自选",
};

export function skillsPolicyModeLabel(mode: string): string {
  if (!mode) return "未指定";
  return MODE_LABELS[mode] ?? mode;
}

export function parseScenarioSkills(
  skillsPolicy: Record<string, unknown> | null | undefined,
  outputPolicy: Record<string, unknown> | null | undefined,
): ParsedScenarioSkills {
  const sp = skillsPolicy ?? {};
  const op = outputPolicy ?? {};
  const mode = typeof sp.mode === "string" ? sp.mode : "";
  const allowAgentFreeChoice = sp.allow_agent_free_choice !== false;

  const bindings: ScenarioSkillBinding[] = [];
  const push = (b: ScenarioSkillBinding) => {
    if (!b.name) return;
    const dup = bindings.find((x) => x.name === b.name && x.source === b.source);
    if (!dup) bindings.push(b);
  };

  for (const name of normList(sp.allowed)) {
    push({ name, source: "allowed" });
  }
  for (const name of normList(sp.preferred)) {
    if (!bindings.some((x) => x.name === name)) {
      push({ name, source: "preferred" });
    }
  }

  const outSkill = typeof op.skill_name === "string" ? op.skill_name.trim() : "";
  const outTpl = typeof op.skill_template === "string" ? op.skill_template.trim() : "";
  if (outSkill) {
    const existing = bindings.find((x) => x.name === outSkill);
    if (existing) {
      if (outTpl) {
        existing.templatePath = outTpl;
        existing.source = "output";
      }
    } else {
      push({
        name: outSkill,
        source: "output",
        ...(outTpl ? { templatePath: outTpl } : {}),
      });
    }
  }

  const allowed = normList(sp.allowed);
  const preferred = normList(sp.preferred);
  let runSkillNames = allowed.length > 0 ? allowed : preferred;
  if (runSkillNames.length === 0 && outSkill) {
    runSkillNames = [outSkill];
  }

  return {
    mode,
    allowAgentFreeChoice,
    bindings,
    runSkillNames,
  };
}

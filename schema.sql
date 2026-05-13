-- TPDHermes SQLite Schema
-- 项目管理 + 输出物 + 模板 + 技能配置

-- ============================================================
-- projects 表：项目主表
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,       -- UUID
    name        TEXT NOT NULL,
    description TEXT,
    background  TEXT,
    audience    TEXT,
    deadline    TEXT,                    -- ISO8601 日期字符串
    constraints TEXT,                    -- JSON 约束条件
    status      TEXT NOT NULL DEFAULT 'active',  -- active | paused | completed | archived
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_status   ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_deadline ON projects(deadline);
CREATE INDEX IF NOT EXISTS idx_projects_created  ON projects(created_at);

-- ============================================================
-- templates 表：模板库（先于 outputs 定义，因 outputs 引用它）
-- ============================================================
CREATE TABLE IF NOT EXISTS templates (
    id          TEXT PRIMARY KEY,       -- UUID
    name        TEXT NOT NULL,
    content     TEXT NOT NULL,          -- 模板正文（Markdown/JSON 等）
    version     TEXT NOT NULL DEFAULT '1.0.0',
    category    TEXT,                   -- 如：技术文档、周报、方案等
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_version  ON templates(version);

-- ============================================================
-- outputs 表：项目产出物
-- ============================================================
CREATE TABLE IF NOT EXISTS outputs (
    id          TEXT PRIMARY KEY,       -- UUID
    project_id  TEXT NOT NULL,
    template_id TEXT,
    content     TEXT NOT NULL,          -- 产出内容
    status      TEXT NOT NULL DEFAULT 'draft',  -- draft | reviewing | approved | published
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id)  REFERENCES projects(id)  ON DELETE CASCADE,
    FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_outputs_project_id  ON outputs(project_id);
CREATE INDEX IF NOT EXISTS idx_outputs_template_id ON outputs(template_id);
CREATE INDEX IF NOT EXISTS idx_outputs_status     ON outputs(status);
CREATE INDEX IF NOT EXISTS idx_outputs_created     ON outputs(created_at);

-- ============================================================
-- skills 表：技能配置表
-- ============================================================
CREATE TABLE IF NOT EXISTS skills (
    id          TEXT PRIMARY KEY,       -- UUID
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    config      TEXT NOT NULL DEFAULT '{}',  -- JSON 配置
    version     TEXT NOT NULL DEFAULT '1.0.0',
    enabled     INTEGER NOT NULL DEFAULT 1,  -- 0=禁用, 1=启用
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_skills_name     ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_enabled  ON skills(enabled);
CREATE INDEX IF NOT EXISTS idx_skills_version  ON skills(version);

-- ============================================================
-- 自动更新 updated_at 触发器
-- ============================================================
CREATE TRIGGER IF NOT EXISTS trg_projects_updated_at
AFTER UPDATE ON projects
BEGIN
    UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_outputs_updated_at
AFTER UPDATE ON outputs
BEGIN
    UPDATE outputs SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_templates_updated_at
AFTER UPDATE ON templates
BEGIN
    UPDATE templates SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_skills_updated_at
AFTER UPDATE ON skills
BEGIN
    UPDATE skills SET updated_at = datetime('now') WHERE id = NEW.id;
END;

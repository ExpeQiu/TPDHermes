标准上传 skill（ZIP）按当前后端规则，分为**最低可上传**和**推荐完整包**两层：

### 1) 最低可上传（满足其一即可）

- `__init__.py`  
  - 用途：作为 Python skill 入口，供 `SkillLoader` 加载与注册；通常包含 `Skill` 子类及 `generate()`。
- `SKILL.md`  
  - 用途：定义 skill 说明/规则（Agent 侧可读）。  
  - 说明：如果只有 `SKILL.md`，系统会自动补一个 `__init__.py` 桩文件，确保可加载。


### 2) 推荐完整包（标准布局）

- `SKILL.md`（推荐必有）  
  - 用途：skill 的行为说明、触发场景、输出要求。  
  - 建议 frontmatter：
    - `name`: skill 名（应与目录名一致）
    - `description`: skill 描述
- `__init__.py`（推荐保留）  
  - 用途：明确 Python 入口，避免仅依赖自动桩。
- `skill.json`（可选但推荐）  
  - 用途：元数据（名称、版本、作者、模板等），便于管理与展示。
- `scripts/`（可选）  
  - 用途：脚本逻辑（Python/Shell/JS），例如预处理、后处理。
- `references/`（可选）  
  - 用途：参考文档、API 说明、案例。
- `assets/`（可选）  
  - 用途：模板、图片、配置等静态资源。


### 3) ZIP 结构要求（很关键）

- 允许两种结构：
  - 单一顶层目录，目录内含 `__init__.py` 或 `SKILL.md`
  - 或 ZIP 根目录直接放 `__init__.py` / `SKILL.md`（这种情况通常要在上传表单填 `name`）
- skill 目录名规则：字母开头，仅字母/数字/下划线。

---

你这个问题要先区分 3 个“长得像配置”的东西：

- `skills` 表里的 `config` 字段（DB JSON）
- 技能包里的 `skill.json` 文件（文件系统元数据）
- 我给你的批量修复里每个 skill 的 `*.config.json`（修复输入文件）

### 1) 每个 skill 的 `config.json`（你现在在用的修复文件）怎么生成？

它**不是系统自动生成**，是你为批量 PATCH 人工准备的输入文件。  
来源通常是：

- 原始上传包里的规则/参数（`SKILL.md`、旧 `skill.json`、模板文件等）整理出来
- 或平台维护者提供的历史配置导出
- 或先给最小可用配置，再逐步补全

你写好后，脚本会把它作为 `PATCH /api/v1/skills/{name}/config` 的请求体写回 DB。

### 2) DB `config` 的具体用途（当前代码里）

当前后端里，`config` 主要用于：

- 技能市场展示字段（如 `market_icon`、`market_tags`、`market_category`、`market_rating`）
- 市场安装时把上游 skill 的 `config` 继承到安装副本
- 作为技能记录的一部分持久化（方便后续扩展）

### 3) 一个关键点（和你这次故障直接相关）

- 上传接口当前调用链里默认传 `config=None`，最终入库成 `{}`（空对象）
- 所以你看到 `source=upload` 的 skills 都“可见但不可用”，本质就是上传链路没把可执行配置内容落进 DB `config`


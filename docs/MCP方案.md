
          
**方案目标**
- 通过扩展现有 `tphermes-mcp`，持续给 `hermes-agent` 增加业务型工具，而不改 Hermes 内部工具框架。
- 保持当前接入方式不变：`hermes-agent` 继续通过 `mcp_servers.tphermes` 连接 `TPDHermes MCP`，[config.yaml](file:///Volumes/Lexar/git/03T/TPDHermes/deploy/hermes-agent/config.yaml)。
- 新能力统一沉淀在 `TPDHermes backend`，Hermes 只负责发现、选择、调用。

**现状基线**
- 当前 `tphermes-mcp` 已经是标准 `FastMCP` 服务器，入口在 [mcp_server.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/mcp_server.py)。
- HTTP 暴露入口在 [mcp_http_server.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/mcp_http_server.py)，通过 `streamable-http` 对外提供 `/mcp`。
- 已有工具按领域分层：
  - KB 工具在 [mcp_server.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/mcp_server.py) 中注册
  - Project 业务逻辑在 [project_tools.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/tools/project_tools.py)
  - Workshop 业务逻辑在 [workshop_tools.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/tools/workshop_tools.py)
- Hermes 会把 MCP 工具注册成 `mcp_<server>_<tool>` 格式，[mcp.md](file:///Volumes/Lexar/git/03T/TPDHermes/hermes-agent/hermes-agent-main/website/docs/user-guide/features/mcp.md#L129-L145)。

**总体架构**
- `TPDHermes backend` 负责：
  - 对接内部系统和第三方系统
  - 做业务鉴权、参数校验、审计日志、限流
  - 封装稳定的业务动作
- `tphermes-mcp` 负责：
  - 把业务动作暴露为 MCP tools
  - 提供统一描述、参数签名、调用入口
- `hermes-agent` 负责：
  - 在启动时发现 `tphermes` 工具
  - 在推理时自动选择工具
  - 将结果回编进对话

**推荐目录设计**
- 建议按“领域工具文件 + MCP 暴露层”组织，保持和当前项目一致。
- 推荐新增目录/文件：
  - `backend/tools/feishu_tools.py`
  - `backend/tools/task_tools.py`
  - `backend/tools/crm_tools.py`
  - `backend/tools/pipeline_tools.py`
  - `backend/tools/report_tools.py`
  - `backend/services/crm_client.py`
  - `backend/services/pipeline_client.py`
  - `backend/services/report_client.py`
- 约束：
  - `backend/tools/*.py` 只写“业务动作封装”
  - `backend/services/*.py` 只写“外部 API/SDK 访问”
  - `backend/mcp_server.py` 只做暴露，不写复杂业务逻辑

**职责分层**
- `services` 层：
  - 负责 HTTP/SDK 调用
  - 处理 token、重试、超时、错误码映射
- `tools` 层：
  - 负责业务参数校验
  - 负责聚合多个 service 调用
  - 负责统一返回结构
- `mcp_server.py`：
  - 使用 `@mcp.tool()` 暴露工具
  - 保持函数名语义清晰、参数简单

**工具设计原则**
- 优先暴露“业务动作”，不要暴露“底层原语”。
- 推荐工具形态：
  - `feishu_send_text_message(chat_id, content)`
  - `task_create(project_id, title, assignee, due_date)`
  - `crm_search_customer(keyword, limit)`
  - `pipeline_get_status(project_name, environment)`
  - `report_generate_sales_summary(project_id, period)`
- 不推荐工具形态：
  - `run_shell(command)`
  - `execute_sql(sql)`
  - `generic_http_request(url, method, body)`
- 原因：
  - 模型更容易理解业务动作
  - 参数更稳定
  - 风险面更小
  - 更容易做权限控制和审计

**命名规范**
- Python 函数名使用业务前缀：
  - `feishu_*`
  - `task_*`
  - `crm_*`
  - `pipeline_*`
  - `report_*`
- `title` 用用户语言描述能力，`description` 用明确动作边界。
- 暴露后工具名会变成：
  - `mcp_tphermes_feishu_send_text_message`
  - `mcp_tphermes_task_create`
  - `mcp_tphermes_crm_search_customer`

**推荐第一阶段工具清单**
- 飞书文档/消息：
  - `feishu_send_text_message`
  - `feishu_send_task_card`
  - `feishu_upload_file`
  - `feishu_send_file`
- 项目任务：
  - `task_list`
  - `task_create`
  - `task_update_status`
  - `task_assign`
- CRM：
  - `crm_search_customer`
  - `crm_get_customer_detail`
  - `crm_list_recent_opportunities`
- 发布流水线：
  - `pipeline_list_recent_runs`
  - `pipeline_get_run_status`
  - `pipeline_trigger_deploy`
  - `pipeline_rollback_preview`
- 内部报表：
  - `report_list_available`
  - `report_get_summary`
  - `report_export_link`

**接口返回规范**
- 所有工具统一返回 `dict`
- 推荐统一字段：
  - `ok: bool`
  - `message: str`
  - `data: object | list`
  - `count: int`
  - `error_code: str | null`
  - `trace_id: str | null`
- 示例：

```python
return {
    "ok": True,
    "message": "customer found",
    "data": {...},
    "count": 1,
    "error_code": None,
    "trace_id": trace_id,
}
```

- 好处：
  - 模型更容易总结
  - 日志和前端联调更统一
  - 错误处理更稳定

**错误处理规范**
- 不把底层异常原样抛给模型。
- 推荐在 `tools` 层把异常转成结构化结果：
  - 参数错误
  - 权限错误
  - 外部接口超时
  - 数据不存在
  - 上游服务异常
- 示例字段：
  - `ok: false`
  - `error_code: "crm_timeout"`
  - `message: "CRM service timeout"`

**鉴权与安全**
- 这是方案里最重要的部分。
- 不能因为工具挂到 MCP 就默认可信，真正安全边界必须在 `backend/tools` 或 `backend/services` 里。
- 建议做 4 层控制：
- 第 1 层：环境变量控制是否启用工具
  - 例如未配置 `CRM_API_KEY` 就不允许 `crm_*`
- 第 2 层：服务端角色/租户校验
  - 校验用户身份、项目归属、可操作范围
- 第 3 层：高风险动作显式限制
  - 如 `pipeline_trigger_deploy` 只允许预发布环境
- 第 4 层：完整审计
  - 记录工具名、参数摘要、调用时间、结果、trace_id

**配置策略**
- 当前 `hermes-agent` 已有 `mcp_servers.tphermes`，不需要再改 Hermes 框架。
- 如果后面工具太多，建议在 Hermes 侧加白名单过滤：
  
```yaml
mcp_servers:
  tphermes:
    url: http://tphermes-mcp:8801/mcp
    enabled: true
    tools:
      include:
        - kb_query
        - project_list
        - task_list
        - task_create
        - feishu_send_text_message
        - crm_search_customer
```

- 这样可以逐步放量，而不是一次性全开放。
- 官方支持 `include/exclude`，[mcp.md](file:///Volumes/Lexar/git/03T/TPDHermes/hermes-agent/hermes-agent-main/website/docs/user-guide/features/mcp.md#L169-L239)。

**代码接入模板**
- 业务实现放在 `backend/tools/task_tools.py`：

```python
from typing import Optional

async def task_create(
    project_id: str,
    title: str,
    assignee: Optional[str] = None,
    due_date: Optional[str] = None,
) -> dict:
    if not project_id or not title:
        return {
            "ok": False,
            "message": "project_id and title are required",
            "data": None,
            "error_code": "invalid_args",
            "trace_id": None,
        }

    # 这里接 DB / 内部服务 / 第三方任务系统
    result = {
        "id": "task_xxx",
        "project_id": project_id,
        "title": title,
        "assignee": assignee,
        "due_date": due_date,
        "status": "open",
    }

    return {
        "ok": True,
        "message": "task created",
        "data": result,
        "count": 1,
        "error_code": None,
        "trace_id": None,
    }
```

- 在 [mcp_server.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/mcp_server.py) 暴露：

```python
@mcp.tool(
    title="Task Create",
    description="Create a project task with title, optional assignee, and due date.",
)
async def task_create(
    project_id: str,
    title: str,
    assignee: str | None = None,
    due_date: str | None = None,
) -> dict:
    from backend.tools.task_tools import task_create as _impl
    return await _impl(project_id, title, assignee, due_date)
```

**飞书能力接入建议**
- 你仓库里已经有飞书 service 能力基础，在 [feishu.py](file:///Volumes/Lexar/git/03T/TPDHermes/backend/services/feishu.py) 和 `feishu_auth` 相关代码里。
- 最佳做法不是直接把 service 暴露成 MCP，而是再包一层 `backend/tools/feishu_tools.py`。
- 推荐先做 3 个工具：
  - `feishu_send_text_message`
  - `feishu_send_task_card`
  - `feishu_send_file_by_path`
- 这样能快速形成“生成内容 -> 发送飞书”的闭环。

**发布流水线接入建议**
- 不建议第一版就开放“任意触发生产发布”。
- 推荐分两步：
- 第一步只读：
  - `pipeline_list_recent_runs`
  - `pipeline_get_run_status`
- 第二步可写：
  - `pipeline_trigger_deploy(environment="staging")`
- 第三步高风险动作单独审批：
  - `pipeline_trigger_production`
  - `pipeline_rollback_production`
- 这些工具要有额外校验，例如固定允许环境枚举，而不是让模型传任意字符串。

**内部报表接入建议**
- 最适合 MCP 的不是“报表 SQL”，而是“报表视图”。
- 推荐工具：
  - `report_list_available`
  - `report_get_summary(report_name, period)`
  - `report_export_link(report_name, period, format)`
- 让模型只在既定报表集合里选择，避免自由查询导致错误和泄露风险。

**开发流程**
- 建议每个新领域都走统一 6 步：
1. 在 `services` 层打通外部系统
2. 在 `tools` 层定义业务动作
3. 在 `mcp_server.py` 暴露为 `@mcp.tool`
4. 在本地或容器内通过 `hermes mcp test tphermes` 验证发现
5. 用真实 `/chat` 验证模型实际调用
6. 写入部署文档和环境变量模板

**测试与验证**
- 静态验证：
  - 导入是否正常
  - 配置是否完整
  - 工具签名是否清晰
- MCP 发现验证：
  - `hermes mcp list`
  - `hermes mcp test tphermes`
- 真实会话验证：
  - 走 `/api/v1/chat/completions`
  - 用提示词强制模型调用某个工具
- 日志验证：
  - 检查 `agent.log` 中是否出现 `tool mcp_tphermes_xxx completed`
- 你现有文档中的 MCP 验证套路已经可以直接复用，[EPLOY.md](file:///Volumes/Lexar/git/03T/TPDHermes/EPLOY.md#L286-L307)、[EPLOY.md](file:///Volumes/Lexar/git/03T/TPDHermes/EPLOY.md#L538-L569)。

**部署影响**
- 这套方案对 `hermes-agent` 影响很小。
- 主要变更点都在 `TPDHermes backend` 和 `tphermes-mcp`。
- 发布时通常只需要：
  - 重建 `backend`
  - 重启 `tphermes-mcp`
  - 视情况重启 `hermes-agent` 让它重新发现工具
- 如果 Hermes 支持动态 `tools/list_changed` 通知，可做热刷新；否则按当前运维方式重启最稳，[mcp.md](file:///Volumes/Lexar/git/03T/TPDHermes/hermes-agent/hermes-agent-main/website/docs/user-guide/features/mcp.md#L272-L288)。

**迭代建议**
- 第 1 期：飞书 + 任务
  - 价值高
  - 改动小
  - 现有代码可复用多
- 第 2 期：CRM 查询 + 报表摘要
  - 以只读为主
  - 风险低
- 第 3 期：流水线只读 + 预发布触发
  - 先做低风险动作
- 第 4 期：生产级变更动作
  - 必须补齐审批、鉴权、审计

**推荐里程碑**
- M1：新增 6 个工具
  - `feishu_send_text_message`
  - `feishu_send_task_card`
  - `task_list`
  - `task_create`
  - `crm_search_customer`
  - `report_get_summary`
- M2：完成白名单过滤和日志审计
- M3：接入流水线只读工具
- M4：引入高风险动作审批策略

**一句话结论**
- 对你当前项目，最优路径就是继续把 `TPDHermes` 当成“业务能力 MCP 网关”。
- 新工具一律按“`services` 对接外部系统 -> `tools` 封装业务动作 -> `mcp_server.py` 暴露 MCP tool”的三层结构落地。
- 这样 `hermes-agent` 端几乎零侵入，扩展性、可控性、运维成本都最好。

**如果你要继续，我可以下一步直接输出两份东西之一**
- 一份“可开发任务清单版”，把飞书/任务/CRM/流水线/报表拆成具体开发任务
- 一份“代码骨架版”，直接给你 `task_tools.py`、`feishu_tools.py` 和 `mcp_server.py` 的新增示例代码
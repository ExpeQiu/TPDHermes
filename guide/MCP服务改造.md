总体判断

- 当前 TPDHermes 已经具备扩展 tphermes-mcp 的基础骨架：MCP Server 已独立、HTTP 入口已稳定、 hermes-agent 已完成接入， mcp_server.py 、 mcp_http_server.py 、 config.yaml 。
- 但如果要把它真正演进成“业务能力 MCP 网关”，还缺几类关键优化：工具治理、权限边界、返回规范、可观测性、部署标准化。
- 也就是说，当前不是“不能做”，而是“可以做，但需要先补平台化能力”。
优先级最高

- mcp_server.py 现在是手工平铺注册，随着工具增多会快速膨胀，建议尽快按领域拆分注册层，至少分成 kb / workshop / project / feishu / task / crm / pipeline / report 模块，避免单文件失控；当前集中暴露已较明显， mcp_server.py 。
- hermes-agent 侧目前只配置了 mcp_servers.tphermes ，但没有做 tools.include/exclude 白名单治理；工具一多后，模型可见工具面会迅速失控，建议尽早补白名单配置， config.yaml 。
- 当前项目已有 trace_id 请求日志，但还没有看到 MCP 工具级别的统一审计层；未来一旦接入飞书、CRM、流水线，没有“谁调用了什么工具、参数摘要是什么、结果如何”的审计会很危险， request_logger.py 、 exception_handler.py 。
- 现有 Project/Workshop/KB 工具返回结构并不完全统一，后面如果再接更多系统，模型对结果的消费稳定性会下降；建议统一为 ok/message/data/count/error_code/trace_id 结构， project_tools.py 、 docs/MCP方案.md 。
架构优化

- 把 backend/mcp_server.py 从“注册中心 + 领域混排”改成“注册聚合层”。
- 推荐新增：
  - backend/mcp/kb.py
  - backend/mcp/workshop.py
  - backend/mcp/project.py
  - backend/mcp/feishu.py
  - backend/mcp/task.py
  - backend/mcp/crm.py
  - backend/mcp/pipeline.py
  - backend/mcp/report.py
- mcp_server.py 只保留 FastMCP 初始化和各领域注册调用。
- 这样做的价值：
  - 领域边界更清晰
  - 后续新增工具不需要反复改一个大文件
  - 更利于做工具启停和分阶段灰度
工具层优化

- 当前 project_tools.py 、 workshop_tools.py 已经有“工具逻辑下沉”的雏形，这条路是对的，但需要更彻底。
- 需要统一约束：
  - services 层只做 SDK/HTTP 调用
  - tools 层只做业务动作封装
  - mcp 层只做 @mcp.tool() 暴露
- 还需要补一个“公共工具基类/辅助模块”，例如：
  - 参数校验辅助
  - 统一错误包装
  - 统一结果格式化
  - trace/audit 打点
- 否则后面每个新工具文件都会重复造轮子。
权限与安全

- 这是当前最需要提前设计的部分。
- 现在项目里有请求级 trace_id ，也有部分业务审批概念，但还没看到面向 MCP 工具的系统化权限框架；例如对“谁可以触发发布、谁可以查 CRM、谁可以发飞书群消息”需要单独建模。
- 建议新增 4 层控制：
  - 环境级开关：没配 CRM_API_KEY 、 FEISHU_APP_ID 就不注册对应工具
  - 工具级权限：只读工具和写工具分层
  - 业务级校验：项目归属、租户、角色、资源范围
  - 风险级控制：生产发布、批量写入、消息群发必须二次确认或拒绝
- 这里最大的优化点不是“加多少工具”，而是“工具上线前先有边界”。
配置治理

- config.yaml 现在只声明了 tphermes ，但没有利用 Hermes 的 tools.include/exclude 能力做收口。
- 推荐把配置策略分 3 套：
  - 开发环境：全量工具
  - 测试环境：领域白名单
  - 生产环境：最小白名单
- 例如生产先只放：
  - kb_query
  - project_list
  - project_get
  - workshop_list_skills
  - 后续再逐步加入 feishu_* 、 crm_*
- 这样能避免“刚接一个高风险工具，模型就能直接调用”。
可观测性

- 当前已有请求日志基础，但还缺 MCP 工具维度观测。
- 建议新增三类日志：
  - 工具注册日志：启动时注册了哪些工具、哪些被禁用
  - 工具调用日志：工具名、参数摘要、耗时、结果状态
  - 工具失败日志：错误码、上游接口、重试次数、trace_id
- 同时建议加 4 个指标：
  - 每个工具调用次数
  - 每个工具失败率
  - 每个工具 P95 耗时
  - 各上游依赖健康状态
- 没有这层，后面很难判断“是模型没选工具，还是工具本身不稳定”。
返回结构标准化

- 当前不同工具返回的数据风格不完全一致。
- 这会带来两个问题：
  - 模型难以稳定消费
  - 前后端联调成本增加
- 建议项目级统一一套 MCP 返回 schema：
  - 成功： ok=true
  - 失败： ok=false
  - 必有： message/data/error_code/trace_id
  - 列表型加 count
- 这是小改动，但对后续扩展收益很大。
错误处理优化

- 当前飞书等 service 里还能看到直接抛异常或返回上游原始错误的趋势， feishu.py 。
- 建议统一错误分层：
  - invalid_args
  - not_found
  - forbidden
  - upstream_timeout
  - upstream_unavailable
  - internal_error
- 模型最怕“异常文本风格不一致”，因为这会直接影响它后续如何解释和补救。
外部系统接入准备

- 飞书基础已经有了，这是最容易先落地的一块， feishu.py 、 feishu_auth.py 。
- 但 CRM、流水线、报表目前更像规划目标，还缺统一 client 层。
- 建议先补：
  - backend/services/crm_client.py
  - backend/services/pipeline_client.py
  - backend/services/report_client.py
- 这样未来不会把 HTTP 调用散落在 tools 层里。
部署与运维

- 现在部署链路已经能跑，但对“新增 MCP 工具后的发布动作”还不够标准化。
- 建议补 3 类文档/脚本：
  - 新增工具后的重建顺序
  - MCP 工具发现验证命令
  - 真实 /chat 强制调用验证模板
- 你当前 EPLOY.md 已经有很好的 MCP 验证基础，可以继续扩成“新增工具发布 SOP”， EPLOY.md 。
建议的实施顺序

- 第一阶段：平台化基础
  - 拆分 mcp_server.py
  - 统一返回结构
  - 增加工具级审计日志
  - 增加生产白名单配置
- 第二阶段：低风险工具
  - 飞书消息
  - 任务查询/创建
  - 只读报表
- 第三阶段：中风险工具
  - CRM 查询
  - 预发布流水线状态/触发
- 第四阶段：高风险工具
  - 生产发布
  - 批量写操作
  - 高权限管理动作
一句话结论

- 当前 TPDHermes 最需要的优化，不是先“多接几个工具”，而是先把它从“能接 MCP”升级成“可治理、可审计、可灰度发布的 MCP 业务平台”。
- 如果只做功能扩展而不先补这些基础，工具一多就会在 mcp_server.py 、权限控制、日志审计和生产安全上同时失控。
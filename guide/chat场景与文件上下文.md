# /chat 场景二分与文件上下文

## 场景

| 场景 | 说明 | 约束 |
|------|------|------|
| 对话共创 | 自由对话与输出 | 项目/文件均可不选 |
| 文稿优化 | 对指定项目输出物做局部优化 | 必须选项目 + 输出物；改写目标必填 |

## 上下文规则

1. **已选项目、未选文件**：默认注入项目背景（描述/背景/受众等），走 `GET /projects/{id}/context`。
2. **已选项目、已选输出物**：请求携带 `source_output_id`，后端将输出正文写入 `task_input.source_material`。
3. **已选项目、已选附件（仅共创）**：在 `task_input.extra` 写入附件提示，由 Agent 按需 kb 检索。
4. **文稿优化**：前端与后端双重校验，缺少 `source_output_id` 返回 400。

## 请求字段

```json
{
  "entrypoint": "chat",
  "chat_mode": "co_create | doc_optimize",
  "project_id": "...",
  "source_output_id": "...",
  "task_input": {
    "extra": "[局部改写约束]\n目标章节/段落: ...\n原文片段: ...\n改写目标: ..."
  }
}
```

## 版本沉淀

助手消息快捷操作「存为新版本」调用：

`POST /projects/{project_id}/outputs/{output_id}/versions`

## 验收步骤

1. 打开 `/chat`，右侧「场景选择」切换「对话共创 / 文稿优化」。
2. 选择项目但不选文件，发送消息；日志应含 `[chat-output-context]` 且无 `source_output_id`。
3. 选择项目 + 输出物，发送；请求体应含 `source_output_id`。
4. 文稿优化不选输出物时，前端拦截或后端 400。
5. 选中输出物后，助手回复点击「存为新版本」，项目详情应出现新版本。

## 日志前缀

- 前端：`[chat-output-context]`
- 后端：`[chat-output-context] tasks execute ...`

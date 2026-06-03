---
name: video_script_skill
description: 用于生成中文《技术推广视频策划/创意/导演脚本》的 Python 类型技能。适用于技术推广视频、广告、宣传片、剧情片、纪录片、MV等完整导演脚本制作，覆盖项目信息、核心创意、故事框架、分镜脚本、技术需求和协作备注。
---

# 技术推广视频导演脚本 Skill

## 目标

根据用户输入的视频项目基础信息、技术 IP、核心主题、创意概念、故事主线、分镜内容和制作要求，生成符合平台标准模板的中文《技术推广视频策划/创意/导演脚本》。

## 标准结构

本技能文件夹名固定为 `video_script_skill`，符合平台单个 Skill 目录规范：

```text
video_script_skill/
├── SKILL.md
├── references/
├── scripts/
├── templates/
└── assets/
```

## 使用流程

1. 识别项目名称、视频类型、时长、交付格式、核心主题和核心诉求。
2. 参考 `references/report-fields.md` 理解各字段填写口径。
3. 按 `templates/video_script.md` 的结构输出 Markdown 导演脚本。
4. 如平台支持脚本执行，可调用 `scripts/generate_script.py`，用 JSON 输入生成 Markdown。
5. 信息不足时使用“待补充”标记；不要编造预算、演员、拍摄地点或制作资源。
6. 输出应适合创意评审、导演沟通、制片排期和后期制作承接。

## Python 脚本调用

```bash
python scripts/generate_script.py --input input.json --output video_script.md
```

## 输出要求

- 必须包含视频项目基础信息、核心创意阐述、分镜脚本、备注/技术说明四大章节。
- 分镜脚本、特殊技术需求、修改备注必须使用表格。
- 分镜脚本建议至少 10 个镜头；信息不足时保留空位或“待补充”。
- CG 类和实拍类故事框架都应提供对应描述位置。

## 资源说明

- `references/report-fields.md`：字段说明和判断口径。
- `templates/video_script.md`：标准 Markdown 模板。
- `scripts/generate_script.py`：Python 生成脚本，使用标准库，无第三方依赖。

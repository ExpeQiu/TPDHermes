# 技术推广视频导演脚本字段说明

## 一、视频项目基础信息

`project_info` 包含：

- `project_name`：项目名称。
- `video_type`：视频类型，例如广告、宣传片、剧情片、纪录片、MV、其他。
- `duration`：视频时长。
- `resolution`：分辨率。
- `frame_rate`：帧率。
- `bitrate`：码率。
- `core_theme`：核心主题。
- `core_appeal`：核心诉求。

## 二、核心创意阐述

`creative` 包含：

- `main_line`：创意主线。
- `highlight`：创意亮点。
- `tone`：创意调性。
- `cg_story`：CG 类虚拟世界观和叙事逻辑。
- `live_story`：实拍类现实故事线和情感曲线。

## 三、分镜脚本

`storyboards` 使用列表，每个对象包含：

- `shot_no`：镜号。
- `visual`：画面内容描述。
- `duration`：时长。
- `sound`：音效/音乐。
- `line`：台词/字幕。
- `shot_type`：镜头类型。
- `scene_size`：景别。
- `note`：备注。

## 四、备注 / 技术说明

`technical_requirements` 使用列表，每个对象包含 `item`、`requirement`、`owner`。

`collaboration_notes` 包含：

- `preparation`：前期准备。
- `production_coordination`：拍摄/制作协调。
- `post_delivery`：后期交付节点。

`revision_notes` 使用列表，每个对象包含：

- `version`：版本。
- `date`：日期。
- `change`：修改内容。
- `approver`：审批人。

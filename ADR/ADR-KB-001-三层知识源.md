# ADR-KB-001 三层知识源

- 状态：已采纳
- 日期：2026-09-16
- 宿主：TPDHermes（模板 2）+ ingest 管道（模板 1）

## 决策

内部知识只从 GeelyWiki CLI（`pages export` / `pages get`）以 LLMwiki 归档进 Hermes 检索，不再从 myKW 直推 Chroma。外部情报与经验库走同一条向量+图谱总线，权威低于 Wiki `equipped_with`。

## 理由

- GeelyWiki 已按 claims / 搭载关系编译，适合 Agent 答题约束。
- myKW 原文与编译页粒不同；双路检索会导致口径冲突。
- 外部情报需要可搜、可图，但不能写成已确认搭载。

## 后果

- `internal.geelywiki.pages` 为唯一内部真源 collection。
- 知识更新默认 `geelywiki pages export`；`--pages-json` 仅回退。
- `MYKW_PUSH_ENABLED` 默认关闭。
- `KgRelation` 增加 provenance（source / authority / source_collection / evidence_kind）。
- 未编译进 GeelyWiki 的原文不会被 Hermes 检索到。

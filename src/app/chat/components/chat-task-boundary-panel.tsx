"use client";

import {
  ALL_PROJECT_FILES_SELECT_VALUE,
  ChatMode,
  ChatTransportConfig,
  decodeProjectFileSelectValue,
  encodeProjectFileSelectValue,
  getDocOptimizeBindingStatus,
  isAllProjectFilesSelection,
  ProjectFileListItem,
  ProjectRecord,
} from "@/lib/chat-context";
import { chatTransportLabel } from "@/lib/ui-labels";

export type ChatTaskBoundaryModel = {
  activeSession?: { taskEntrySummary?: string };
  useOrchestration: boolean;
  transport: ChatTransportConfig | null;
  tasksExecuteUrl: string;
  chatApiBase: string;
  chatMode: ChatMode;
  onChatModeChange: (v: ChatMode) => void;
  includeProjectContext: boolean;
  setIncludeProjectContext: (v: boolean) => void;
  selectedProjectId: string;
  setSelectedProjectId: (v: string) => void;
  projects: ProjectRecord[];
  includeFileContext: boolean;
  setIncludeFileContext: (v: boolean) => void;
  selectedFileId: string;
  setSelectedFileId: (v: string) => void;
  projectFiles: ProjectFileListItem[];
  projectFilesLoading: boolean;
  rewriteTargetSection: string;
  setRewriteTargetSection: (v: string) => void;
  rewriteSourceExcerpt: string;
  setRewriteSourceExcerpt: (v: string) => void;
  rewriteGoal: string;
  setRewriteGoal: (v: string) => void;
  contextSummary: string[];
  bootstrapWarnings: string[];
  /** 多轮对话进行中时锁定项目绑定，禁止中途切换 */
  projectContextLocked: boolean;
};

export function ChatTaskBoundaryPanel({ model }: { model: ChatTaskBoundaryModel }) {
  const {
    activeSession,
    useOrchestration,
    transport,
    tasksExecuteUrl,
    chatApiBase,
    chatMode,
    onChatModeChange,
    includeProjectContext,
    setIncludeProjectContext,
    selectedProjectId,
    setSelectedProjectId,
    projects,
    includeFileContext,
    setIncludeFileContext,
    selectedFileId,
    setSelectedFileId,
    projectFiles,
    projectFilesLoading,
    rewriteTargetSection,
    setRewriteTargetSection,
    rewriteSourceExcerpt,
    setRewriteSourceExcerpt,
    rewriteGoal,
    setRewriteGoal,
    contextSummary,
    bootstrapWarnings,
    projectContextLocked,
  } = model;

  const fileSelectDisabled =
    !includeProjectContext || !selectedProjectId || chatMode === "doc_optimize";
  const outputFiles = projectFiles.filter((f) => f.kind === "output");
  const attachmentFiles = projectFiles.filter((f) => f.kind === "attachment");
  const docOptimizeSelectedOutput =
    chatMode === "doc_optimize" && selectedFileId
      ? outputFiles.find(
          (f) =>
            encodeProjectFileSelectValue("output", f.id) === selectedFileId ||
            decodeProjectFileSelectValue(selectedFileId)?.id === f.id,
        )
      : null;
  const docOptimizeBinding =
    chatMode === "doc_optimize"
      ? getDocOptimizeBindingStatus({
          selectedProjectId,
          selectedFileValue: selectedFileId,
          projectFiles,
          projectFilesLoading,
        })
      : null;

  return (
    <div className="rounded-3xl border border-slate-300 bg-white/80 p-4 dark:border-slate-700 dark:bg-slate-900/50 md:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-slate-500">创作边界</p>
        </div>
        <details className="rounded-2xl border border-slate-300 bg-slate-100/80 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-950/60">
          <summary className="cursor-pointer list-none text-slate-700 dark:text-slate-300 [&::-webkit-details-marker]:hidden">
            <span className="text-xs text-slate-500">链路 · </span>
            {chatTransportLabel({
              useOrchestration,
              proxyMode: transport?.mode,
            })}
          </summary>
          <p className="mt-2 break-all text-xs text-slate-500">
            {useOrchestration ? tasksExecuteUrl : transport?.target ?? chatApiBase}
          </p>
        </details>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3">
        <div className="rounded-2xl border border-slate-300 bg-slate-100/80 p-3 dark:border-slate-700 dark:bg-slate-950/60">
          <p className="text-[11px] uppercase tracking-[0.16em] text-slate-500">场景选择</p>
          <select
            value={chatMode}
            onChange={(e) => onChatModeChange(e.target.value as ChatMode)}
            className="mt-2 w-full rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
          >
            <option value="co_create">对话共创</option>
            <option value="doc_optimize">文稿优化</option>
          </select>
          <p className="mt-2 text-xs leading-relaxed text-slate-500">
            {chatMode === "co_create"
              ? "不限定参照物，可自由对话与输出。"
              : "须选择项目与指定输出物，基于其完整正文做局部优化；改写要求可在对话中说明。"}
          </p>
        </div>

        <div className="rounded-2xl border border-slate-300 bg-slate-100/80 p-3 dark:border-slate-700 dark:bg-slate-950/60">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">
            {chatMode === "doc_optimize" ? "文稿初稿" : "项目上下文（推荐）"}
          </p>
          {chatMode === "doc_optimize" && docOptimizeBinding && !docOptimizeBinding.ready ? (
            <div
              className="mt-3 rounded-xl border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900 dark:border-amber-600/50 dark:bg-amber-950/40 dark:text-amber-200"
              role="status"
            >
              <p className="font-medium">文稿优化须绑定项目与输出物</p>
              <ul className="mt-1.5 list-inside list-disc space-y-0.5">
                {docOptimizeBinding.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-3">
            {projectContextLocked ? (
              <p className="mb-2 text-xs text-slate-500">
                对话进行中不可修改项目绑定，请新建对话后调整。
              </p>
            ) : null}
            {chatMode !== "doc_optimize" ? (
              <div className="mb-2 flex items-center justify-between">
                <label className="text-xs text-slate-400">携带项目</label>
                <input
                  type="checkbox"
                  checked={includeProjectContext}
                  disabled={projectContextLocked}
                  onChange={(e) => setIncludeProjectContext(e.target.checked)}
                />
              </div>
            ) : (
              <p className="mb-2 text-xs text-slate-400">所属项目（必选）</p>
            )}
            <select
              value={selectedProjectId}
              disabled={projectContextLocked}
              onChange={(e) => setSelectedProjectId(e.target.value)}
              className={`w-full rounded-lg border bg-slate-200 px-3 py-2 text-sm text-slate-900 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-800 dark:text-white ${
                chatMode === "doc_optimize" && !selectedProjectId
                  ? "border-amber-400 dark:border-amber-600"
                  : "border-slate-300 dark:border-slate-700"
              }`}
            >
              <option value="">
                {chatMode === "doc_optimize" ? "请选择项目（必选）" : "不注入项目"}
              </option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-3 border-t border-slate-300/60 pt-3 dark:border-slate-700/60">
            {chatMode === "doc_optimize" ? (
              <>
                <p className="text-xs text-slate-400">待优化输出物（必选）</p>
                <select
                  value={selectedFileId}
                  onChange={(e) => setSelectedFileId(e.target.value)}
                  disabled={!selectedProjectId || projectFilesLoading}
                  className={`mt-2 w-full rounded-lg border bg-slate-200 px-3 py-2 text-sm text-slate-900 disabled:opacity-50 dark:bg-slate-800 dark:text-white ${
                    selectedProjectId && !selectedFileId && !projectFilesLoading
                      ? "border-amber-400 dark:border-amber-600"
                      : "border-slate-300 dark:border-slate-700"
                  }`}
                >
                  <option value="">
                    {!selectedProjectId
                      ? "请先选择项目"
                      : projectFilesLoading
                        ? "加载输出物…"
                        : "请选择待优化输出物"}
                  </option>
                  {outputFiles.length === 0 && selectedProjectId && !projectFilesLoading ? (
                    <option value="" disabled>
                      暂无输出物
                    </option>
                  ) : null}
                  {outputFiles.map((file) => (
                    <option
                      key={encodeProjectFileSelectValue("output", file.id)}
                      value={encodeProjectFileSelectValue("output", file.id)}
                    >
                      {file.title}
                    </option>
                  ))}
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  {docOptimizeSelectedOutput
                    ? `已选「${docOptimizeSelectedOutput.title}」：服务端将注入其完整正文作为优化对象（非上下文检索）。`
                    : selectedProjectId
                      ? "须指定一篇输出物；改写时将基于全文做局部优化，而非项目背景或知识库片段。"
                      : "选择项目后指定待优化文稿。"}
                </p>
              </>
            ) : (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-xs text-slate-400">携带具体文件</label>
                  <input
                    type="checkbox"
                    checked={includeFileContext}
                    disabled={fileSelectDisabled}
                    onChange={(e) => setIncludeFileContext(e.target.checked)}
                  />
                </div>
                <select
                  value={selectedFileId}
                  onChange={(e) => setSelectedFileId(e.target.value)}
                  disabled={!includeFileContext}
                  className="w-full rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-sm text-slate-900 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                >
                  <option value="">
                    {includeProjectContext && selectedProjectId
                      ? "不选文件（基于项目背景）"
                      : "请先选择项目"}
                  </option>
                  {includeProjectContext && selectedProjectId ? (
                    <option value={ALL_PROJECT_FILES_SELECT_VALUE}>全部输出物与附件</option>
                  ) : null}
                  {projectFilesLoading ? (
                    <option value="" disabled>
                      加载文件列表…
                    </option>
                  ) : null}
                  {outputFiles.length > 0 ? (
                    <optgroup label="输出物">
                      {outputFiles.map((file) => (
                        <option
                          key={encodeProjectFileSelectValue("output", file.id)}
                          value={encodeProjectFileSelectValue("output", file.id)}
                        >
                          {file.title}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {attachmentFiles.length > 0 ? (
                    <optgroup label="附件">
                      {attachmentFiles.map((file) => (
                        <option
                          key={encodeProjectFileSelectValue("attachment", file.id)}
                          value={encodeProjectFileSelectValue("attachment", file.id)}
                        >
                          {file.title}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <p className="mt-2 text-xs text-slate-500">
                  {isAllProjectFilesSelection(selectedFileId)
                    ? `已启用全部输出物与附件（${outputFiles.length} 篇输出，${attachmentFiles.length} 个附件）。`
                    : selectedFileId
                      ? "已选文件：对话将优先基于该文件上下文。"
                      : includeProjectContext && selectedProjectId
                        ? "未选文件：默认基于项目背景信息对话。"
                        : "选择项目后可指定输出物或附件。"}
                </p>
              </>
            )}
          </div>

          {(chatMode === "doc_optimize" || (includeFileContext && selectedFileId)) && (
            <details className="mt-3 border-t border-slate-300/60 pt-3 dark:border-slate-700/60">
              <summary className="cursor-pointer text-xs font-medium text-slate-500">
                局部改写约束
                <span className="ml-1 text-slate-400">（可选）</span>
              </summary>
              <div className="mt-3 space-y-2">
                <input
                  value={rewriteTargetSection}
                  onChange={(e) => setRewriteTargetSection(e.target.value)}
                  placeholder="目标章节/段落（可选）"
                  className="w-full rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
                <textarea
                  value={rewriteSourceExcerpt}
                  onChange={(e) => setRewriteSourceExcerpt(e.target.value)}
                  placeholder="原文片段（可选）"
                  rows={2}
                  className="w-full rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
                <input
                  value={rewriteGoal}
                  onChange={(e) => setRewriteGoal(e.target.value)}
                  placeholder={
                    chatMode === "doc_optimize"
                      ? "改写目标（可选，也可在下方对话中说明）"
                      : "改写目标（可选）"
                  }
                  className="w-full rounded-lg border border-slate-300 bg-slate-200 px-3 py-2 text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-white"
                />
              </div>
            </details>
          )}
        </div>
      </div>

      {activeSession?.taskEntrySummary && (
        <details className="mt-4 rounded-2xl border border-blue-700/30 bg-blue-950/20 px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-[0.16em] text-blue-300">
            创建页带入摘要
          </summary>
          <pre className="mt-2 whitespace-pre-wrap font-sans text-sm leading-relaxed text-blue-100">
            {activeSession.taskEntrySummary}
          </pre>
        </details>
      )}

      <div className="mt-4 rounded-2xl border border-slate-300 bg-slate-100/80 p-4 dark:border-slate-700 dark:bg-slate-950/60">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs uppercase tracking-[0.16em] text-slate-500">边界摘要</p>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {contextSummary.length === 0 ? (
            <span className="rounded-full border border-slate-300 bg-slate-200 px-2 py-1 text-slate-500 dark:border-slate-700 dark:bg-slate-800">
              当前未启用额外上下文
            </span>
          ) : (
            contextSummary.map((item) => (
              <span
                key={item}
                className="rounded-full border border-blue-300 bg-blue-50 px-2 py-1 text-blue-800 dark:border-blue-700/40 dark:bg-blue-900/30 dark:text-blue-300"
              >
                {item}
              </span>
            ))
          )}
        </div>
      </div>

      {bootstrapWarnings.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-300">
          {bootstrapWarnings.join("；")}
        </div>
      )}
    </div>
  );
}

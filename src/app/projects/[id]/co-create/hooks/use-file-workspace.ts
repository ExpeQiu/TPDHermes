"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { decodeProjectFileSelectValue } from "@/lib/chat-context";
import {
  fetchProjectFileDetail,
  fetchProjectFileVersions,
  fetchProjectFilesUnified,
  type ProjectFileDetail,
  type ProjectFileItem,
  type ProjectFileVersionItem,
} from "@/lib/co-create-api";

type FileTabCache = {
  detail: ProjectFileDetail | null;
  versions: ProjectFileVersionItem[];
  loading: boolean;
};

const EMPTY_TAB: FileTabCache = { detail: null, versions: [], loading: false };

export function useFileWorkspace(projectId: string) {
  const [files, setFiles] = useState<ProjectFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [openTabKeys, setOpenTabKeys] = useState<string[]>([]);
  const [activeFileKey, setActiveFileKey] = useState<string | null>(null);
  const [tabCache, setTabCache] = useState<Record<string, FileTabCache>>({});
  const refreshFiles = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const items = await fetchProjectFilesUnified(projectId);
      setFiles(items);
      console.info("[co-create] 文件列表已刷新", { projectId, count: items.length });
    } catch (err) {
      console.warn("[co-create] 文件列表加载失败", err);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void refreshFiles();
  }, [refreshFiles]);

  const loadingKeysRef = useRef<Set<string>>(new Set());

  const ensureTabLoaded = useCallback(
    async (fileKey: string) => {
      if (!projectId || loadingKeysRef.current.has(fileKey)) return;

      setTabCache((prev) => {
        const cached = prev[fileKey];
        if (cached?.detail || cached?.loading) return prev;
        return { ...prev, [fileKey]: { ...EMPTY_TAB, loading: true } };
      });

      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) return;

      loadingKeysRef.current.add(fileKey);
      try {
        const [detail, versions] = await Promise.all([
          fetchProjectFileDetail(projectId, decoded.id, decoded.kind),
          decoded.kind === "output"
            ? fetchProjectFileVersions(projectId, decoded.id, decoded.kind)
            : Promise.resolve([]),
        ]);
        setTabCache((prev) => ({
          ...prev,
          [fileKey]: { detail, versions, loading: false },
        }));
      } catch (err) {
        console.warn("[co-create] 文件 Tab 加载失败", { fileKey, err });
        setTabCache((prev) => ({
          ...prev,
          [fileKey]: { detail: null, versions: [], loading: false },
        }));
      } finally {
        loadingKeysRef.current.delete(fileKey);
      }
    },
    [projectId],
  );

  const openFileTab = useCallback(
    (fileKey: string | null) => {
      if (!fileKey) return;
      setOpenTabKeys((prev) => (prev.includes(fileKey) ? prev : [...prev, fileKey]));
      setActiveFileKey(fileKey);
      void ensureTabLoaded(fileKey);
    },
    [ensureTabLoaded],
  );

  const closeFileTab = useCallback((fileKey: string) => {
    setOpenTabKeys((prev) => {
      const index = prev.indexOf(fileKey);
      const next = prev.filter((k) => k !== fileKey);
      setActiveFileKey((current) => {
        if (current !== fileKey) return current;
        if (next.length === 0) return null;
        const nextIndex = Math.min(index, next.length - 1);
        return next[nextIndex] ?? next[next.length - 1];
      });
      return next;
    });
  }, []);

  const selectFileTab = useCallback((fileKey: string) => {
    setActiveFileKey(fileKey);
  }, []);

  const patchTabContent = useCallback((fileKey: string, content: string) => {
    setTabCache((prev) => {
      const cached = prev[fileKey];
      if (!cached?.detail) return prev;
      return {
        ...prev,
        [fileKey]: {
          ...cached,
          detail: { ...cached.detail, content },
        },
      };
    });
  }, []);

  const reloadFileTab = useCallback(
    async (fileKey: string) => {
      if (!projectId) return;
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) return;

      loadingKeysRef.current.delete(fileKey);
      setTabCache((prev) => ({
        ...prev,
        [fileKey]: { ...EMPTY_TAB, loading: true },
      }));

      try {
        const [detail, versions] = await Promise.all([
          fetchProjectFileDetail(projectId, decoded.id, decoded.kind),
          decoded.kind === "output"
            ? fetchProjectFileVersions(projectId, decoded.id, decoded.kind)
            : Promise.resolve([]),
        ]);
        setTabCache((prev) => ({
          ...prev,
          [fileKey]: { detail, versions, loading: false },
        }));
      } catch (err) {
        console.warn("[co-create] 文件 Tab 刷新失败", { fileKey, err });
        setTabCache((prev) => ({
          ...prev,
          [fileKey]: { detail: null, versions: [], loading: false },
        }));
      }
    },
    [projectId],
  );


  const activeCache = activeFileKey ? tabCache[activeFileKey] : null;
  const previewDetail = activeCache?.detail ?? null;
  const previewLoading = activeCache?.loading ?? false;
  const versions = activeCache?.versions ?? [];

  const fileLabel = useCallback(
    (fileKey: string) => {
      const decoded = decodeProjectFileSelectValue(fileKey);
      if (!decoded) return fileKey;
      const file = files.find((f) => f.id === decoded.id && f.kind === decoded.kind);
      return file?.title ?? tabCache[fileKey]?.detail?.title ?? decoded.id.slice(0, 8);
    },
    [files, tabCache],
  );

  const tabLabels = useMemo(
    () => Object.fromEntries(openTabKeys.map((key) => [key, fileLabel(key)])),
    [openTabKeys, fileLabel],
  );

  return {
    files,
    loading,
    openTabKeys,
    activeFileKey,
    previewFileKey: activeFileKey,
    tabLabels,
    openFileTab,
    closeFileTab,
    selectFileTab,
    setPreviewFileKey: openFileTab,
    previewDetail,
    previewLoading,
    versions,
    refreshFiles,
    patchTabContent,
    reloadFileTab,
  };
}

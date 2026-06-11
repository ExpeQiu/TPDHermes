import type { ReactNode } from "react";

export type KnowledgeBrowseMode = "collections" | "harvest" | "experience" | "search";

export function KnowledgeBrowseDomain({
  workspaceMode,
  createEntryPanel,
  entryManageMessage,
  renderCollectionWorkspace,
  renderHarvestWorkspace,
  renderExperienceWorkspace,
  renderSearchView,
}: {
  workspaceMode: KnowledgeBrowseMode;
  createEntryPanel: ReactNode;
  entryManageMessage: ReactNode;
  renderCollectionWorkspace: () => ReactNode;
  renderHarvestWorkspace: () => ReactNode;
  renderExperienceWorkspace: () => ReactNode;
  renderSearchView: () => ReactNode;
}) {
  return (
    <>
      {entryManageMessage}
      {createEntryPanel}
      {workspaceMode === "collections" && renderCollectionWorkspace()}
      {workspaceMode === "harvest" && renderHarvestWorkspace()}
      {workspaceMode === "experience" && renderExperienceWorkspace()}
      {workspaceMode === "search" && renderSearchView()}
    </>
  );
}

export function KnowledgeTreeDomain({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KnowledgeIngestDomain({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KnowledgeKgDomain({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function KnowledgePolicyDomainPanel({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

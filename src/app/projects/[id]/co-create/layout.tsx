import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "项目共创",
  description: "项目成员与角色 Agent 的共创对话，讨论会创建或修订右侧文档。",
};

export default function CoCreateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-1 flex-col overflow-hidden sm:h-[calc(100dvh-4rem)]">
      {children}
    </div>
  );
}

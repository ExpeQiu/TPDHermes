import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "项目共创",
  description: "基于项目文件的 Agent 协同创作工作台。",
};

export default function CoCreateLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] min-h-0 flex-1 flex-col overflow-hidden sm:h-[calc(100dvh-4rem)]">
      {children}
    </div>
  );
}

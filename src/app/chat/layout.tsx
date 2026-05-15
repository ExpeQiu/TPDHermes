import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "对话创作",
  description: "基于项目的开放式多轮协作与任务执行。",
};

export default function ChatLayout({ children }: { children: ReactNode }) {
  return children;
}

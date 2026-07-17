import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "头脑风暴",
  description: "多角色圆桌辩论，收敛 Master Plan。",
};

export default function BrainstormLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
  );
}

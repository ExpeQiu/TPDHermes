import type { Metadata } from "next";

import StudioClient from "./studio-client";

export const metadata: Metadata = {
  title: "场景创作",
  description: "按技能卡进入创作。当前接入技术卡核对。",
};

export default function StudioPage() {
  return (
    <div className="h-full min-h-0 bg-white dark:bg-slate-950">
      <StudioClient />
    </div>
  );
}

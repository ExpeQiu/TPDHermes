import type { Metadata } from "next";

import LearningPageClient from "@/app/learning/LearningPageClient";

export const metadata: Metadata = {
  title: "学习中心",
  description: "查看学习信号、技能变化与周报摘要",
};

export default function OpsLearningPage() {
  return <LearningPageClient />;
}

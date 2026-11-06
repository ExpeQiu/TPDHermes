import type { ReactNode } from "react";

import { OpsFrame } from "@/components/ops/OpsFrame";

export default function OpsLayout({ children }: { children: ReactNode }) {
  return <OpsFrame>{children}</OpsFrame>;
}

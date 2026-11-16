"use client";

import dynamic from "next/dynamic";

import { CoCreateRouteSkeleton } from "@/app/projects/[id]/co-create/co-create-route-skeleton";

const CoCreateRoomApp = dynamic(
  () => {
    const started = typeof performance !== "undefined" ? performance.now() : 0;
    console.info("[co-create] 开始加载房间模块");
    return import("@/app/projects/[id]/co-create/room-app").then((mod) => {
      console.info("[co-create] 房间模块就绪", {
        ms: started ? Math.round(performance.now() - started) : 0,
      });
      return mod.default;
    });
  },
  { loading: () => <CoCreateRouteSkeleton /> },
);

export default function CoCreatePage() {
  return <CoCreateRoomApp />;
}

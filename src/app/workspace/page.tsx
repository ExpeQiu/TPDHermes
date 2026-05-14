import { redirect } from "next/navigation";

/** 兼容旧链接 `/workspace` → 输出工坊 */
export default function WorkspaceRedirectPage() {
  redirect("/workshop");
}

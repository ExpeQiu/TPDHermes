import { redirect } from "next/navigation";

/** 兼容旧链接 `/workspace`。场景输出已下线，回到首页。 */
export default function WorkspaceRedirectPage() {
  redirect("/");
}

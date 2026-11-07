import { redirect } from "next/navigation";

export default async function EmployeeProfileRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/ops/employees/${id}`);
}

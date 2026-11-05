import { notFound } from "next/navigation";
import { requireUserPage } from "@/auth/page-guard";
import { DocumentDetailView } from "@/components/DocumentDetailView";
import { getDocumentDetail } from "@/server/document-detail";

export const dynamic = "force-dynamic";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user } = await requireUserPage();
  const detail = await getDocumentDetail(id);
  if (!detail) notFound();
  return <DocumentDetailView detail={detail} isAdmin={user.role === "admin"} />;
}

import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { paths } from "@/lib/paths";

/** Placeholder for a section that exists in the navigation but is not built yet. */
export function ComingSoon({ orgId, title, description }: { orgId: string; title: string; description: string }) {
  return (
    <>
      <PageHeader title={title} />
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          title="בקרוב"
          description={description}
          action={
            <ButtonLink href={paths.org(orgId)} variant="secondary">
              חזרה לדף הבית
            </ButtonLink>
          }
        />
      </div>
    </>
  );
}

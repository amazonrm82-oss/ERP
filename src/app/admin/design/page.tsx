import type { Metadata } from "next";

import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { Tabs } from "@/components/ui/tabs";
import { DesignGallery } from "@/features/design-gallery/components/gallery";
import { platformReady } from "@/features/platform/queries";
import { paths } from "@/lib/paths";

export const metadata: Metadata = { title: "עיצוב" };

// DSN-08: the shared components in light and dark, the base for screenshot comparison.
// Open it at 360px and at 1280px; the components follow the screen width, not this page.
export default async function AdminDesignPage({ searchParams }: { searchParams: Promise<{ tab?: string; page?: string }> }) {
  const me = await platformReady();
  if (!me) return null;
  const { tab, page } = await searchParams;
  const current = Number(page) > 0 ? Number(page) : 2;
  const tabs = [
    { href: `${paths.adminDesign}?tab=a`, label: "לשונית", current: tab !== "b" },
    { href: `${paths.adminDesign}?tab=b`, label: "עם מספר", current: tab === "b", count: 12 },
  ];

  return (
    <>
      <PageHeader title="עיצוב" description="כל הרכיבים המשותפים בכל המצבים, בבהיר ובכהה." />
      {(["light", "dark"] as const).map((theme) => (
        <section
          key={theme}
          data-theme={theme}
          aria-labelledby={`theme-${theme}`}
          className="-mx-4 mb-6 bg-canvas px-4 py-6 text-ink sm:mx-0 sm:rounded-lg sm:border sm:border-line sm:px-6"
        >
          <h2 id={`theme-${theme}`} className="mb-5 text-xl font-semibold">
            {theme === "light" ? "בהיר" : "כהה"}
          </h2>
          <div className="mb-8 flex flex-col gap-3">
            <h3 className="text-lead font-semibold">לשוניות ודפדוף</h3>
            <Tabs label={`לשוניות לדוגמה (${theme})`} items={tabs} />
            <Pagination page={current} pageCount={5} hrefFor={(n) => `${paths.adminDesign}?page=${n}`} />
            <Pagination page={1} pageCount={1} hrefFor={() => ""} />
          </div>
          <DesignGallery theme={theme} />
        </section>
      ))}
    </>
  );
}

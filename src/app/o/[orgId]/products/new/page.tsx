import type { Metadata } from "next";

import { Card, CardBody } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { PageHeader } from "@/components/ui/page-header";
import { ProductForm } from "@/features/products/components/product-form";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryOptions } from "@/features/products/lists";
import { productsPath } from "@/features/products/paths";
import { isAdminRole } from "@/features/settings/permissions";
import { ReadOnlyNotice } from "@/features/shell/components/read-only-notice";
import { getOrgContext } from "@/features/shell/queries";
import { getPricesIncludeVat } from "@/features/tax/queries";

export const metadata: Metadata = { title: "מוצר חדש" };

type Props = { params: Promise<{ orgId: string }> };

/** PRD-02: a new product. Owners and admins of a writable organization. */
export default async function NewProductPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const back = { href: productsPath(orgId), label: "מוצרים" };

  if (!canWrite) {
    return (
      <>
        <PageHeader title="מוצר חדש" back={back} />
        <ReadOnlyNotice />
      </>
    );
  }
  if (!isAdminRole(role)) {
    return (
      <>
        <PageHeader title="מוצר חדש" back={back} />
        <div className="rounded-lg border border-line bg-surface">
          <EmptyState kind="locked" title="רק בעלים ומנהלי מערכת מוסיפים מוצרים" description="אפשר לראות את כל המוצרים ברשימה." />
        </div>
      </>
    );
  }

  const [categories, units, pricesIncludeVat] = await Promise.all([listProductCategories(orgId), listProductUnits(orgId), getPricesIncludeVat(orgId)]);

  return (
    <div className="max-w-2xl">
      <PageHeader title="מוצר חדש" back={back} />
      <Card>
        <CardBody>
          <ProductForm
            orgId={orgId}
            product={null}
            categories={categoryOptions(categories)}
            units={units.map((u) => ({ id: u.id, label: u.name }))}
            orgPricesIncludeVat={pricesIncludeVat}
          />
        </CardBody>
      </Card>
    </div>
  );
}

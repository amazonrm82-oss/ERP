import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ProductActions } from "@/features/products/components/product-actions";
import { ProductDetails } from "@/features/products/components/product-details";
import { PriceHistory } from "@/features/products/components/price-history";
import { ProductForm } from "@/features/products/components/product-form";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryLabel, categoryOptions } from "@/features/products/lists";
import { productsPath } from "@/features/products/paths";
import { getProduct, listProductPriceHistory } from "@/features/products/queries";
import { canEditCatalog } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getPricesIncludeVat } from "@/features/tax/queries";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "מוצר" };

type Props = { params: Promise<{ orgId: string; productId: string }> };

/**
 * PRD-01, PRD-02: one product. Everyone reads it; owners and admins of a writable organization edit, copy, archive and remove.
 * PRD-07: owners and admins also see its price changes (from the audit log).
 */
export default async function ProductPage({ params }: Props) {
  const { orgId, productId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  if (!isUuid(productId)) notFound();
  // PRM-01: a member with the catalog permission edits too
  const canEdit = canEditCatalog(role, await getMyPermissions(orgId)) && canWrite;
  // PRD-07: the audit log is readable by owners and admins only (RLS), so only they see the price history
  const canSeeHistory = isAdminRole(role);
  const [product, categories, units, pricesIncludeVat] = await Promise.all([
    getProduct(orgId, productId),
    listProductCategories(orgId),
    listProductUnits(orgId),
    canEdit ? getPricesIncludeVat(orgId) : Promise.resolve(false),
  ]);
  if (!product) notFound();
  const priceChanges = canSeeHistory ? await listProductPriceHistory(orgId, product) : [];

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader
        title={product.name}
        back={{ href: productsPath(orgId), label: "מוצרים" }}
        actions={canEdit ? <ProductActions orgId={orgId} productId={product.id} name={product.name} archived={product.archivedAt !== null} /> : null}
      />
      {product.archivedAt ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          המוצר בארכיון: הוא לא מוצע במסמכים חדשים, ומסמכים קיימים לא משתנים.
        </p>
      ) : null}
      <Card>
        <CardBody>
          <ProductDetails
            product={product}
            categoryText={categoryLabel(categories, product.categoryId)}
            unitName={units.find((u) => u.id === product.unitId)?.name ?? null}
          />
        </CardBody>
      </Card>
      {canSeeHistory ? (
        <Card aria-labelledby="product-price-history-title">
          <CardHeader id="product-price-history-title" title="היסטוריית מחיר" />
          <CardBody>
            <PriceHistory changes={priceChanges} />
          </CardBody>
        </Card>
      ) : null}
      {canEdit ? (
        <Card aria-labelledby="product-edit-title">
          <CardHeader id="product-edit-title" title="עריכת המוצר" />
          <CardBody>
            <ProductForm
              orgId={orgId}
              product={product}
              categories={categoryOptions(categories)}
              units={units.map((u) => ({ id: u.id, label: u.name }))}
              orgPricesIncludeVat={pricesIncludeVat}
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}

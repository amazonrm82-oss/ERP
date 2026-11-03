import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { partsReferenceSum, partsSkippedNotice } from "@/features/products/bundle";
import { readBundleParts } from "@/features/products/bundle-server";
import { BundlePartsCard } from "@/features/products/components/bundle-parts-card";
import { PunchSettingsCard } from "@/features/punch-cards/components/punch-settings-card";
import { ProductActions } from "@/features/products/components/product-actions";
import { ProductDetails } from "@/features/products/components/product-details";
import { PriceHistory } from "@/features/products/components/price-history";
import { ProductForm } from "@/features/products/components/product-form";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryLabel, categoryOptions } from "@/features/products/lists";
import { productsPath } from "@/features/products/paths";
import { getProduct, listProductPriceHistory } from "@/features/products/queries";
import { productPriceFor } from "@/features/products/price";
import { ProductCostCard } from "@/features/product-costs/components/product-cost-card";
import { getCostBasis, readProductCosts } from "@/features/product-costs/queries";
import { canEditCatalog, canViewCosts } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";
import { getPricesIncludeVat } from "@/features/tax/queries";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "מוצר" };

type Props = {
  params: Promise<{ orgId: string; productId: string }>;
  // PRD-09: parts_skipped = the parts a copy of a bundle left out
  searchParams: Promise<{ parts_skipped?: string | string[]; parts_why?: string | string[] }>;
};

/**
 * PRD-01, PRD-02: one product. Everyone reads it; owners and admins of a writable organization edit, copy, archive and remove.
 * PRD-07: owners and admins also see its price changes (from the audit log).
 * PRD-06: owners, admins, managers and the view_costs grant see its cost and profit; editing the cost also needs the catalog rule.
 * PRD-09: a bundle shows its parts (catalog editors change them) and their sum for reference.
 */
export default async function ProductPage({ params, searchParams }: Props) {
  const [{ orgId, productId }, { parts_skipped: partsSkipped, parts_why: partsWhy }] = await Promise.all([params, searchParams]);
  const { role, canWrite, org } = await getOrgContext(orgId);
  if (!isUuid(productId)) notFound();
  const granted = await getMyPermissions(orgId);
  // PRM-01: a member with the catalog permission edits too
  const canEdit = canEditCatalog(role, granted) && canWrite;
  // PRD-06: cost and profit for owners, admins, managers and the view_costs grant (the table's RLS applies the same rule)
  const canSeeCost = canViewCosts(role, granted);
  // PRD-07: the audit log is readable by owners and admins only (RLS), so only they see the price history
  const canSeeHistory = isAdminRole(role);
  const [product, categories, units, pricesIncludeVat] = await Promise.all([
    getProduct(orgId, productId),
    listProductCategories(orgId),
    listProductUnits(orgId),
    canEdit ? getPricesIncludeVat(orgId) : Promise.resolve(false),
  ]);
  if (!product) notFound();
  const isBundle = product.kind === "bundle";
  const [priceChanges, costs, costBasis, parts] = await Promise.all([
    canSeeHistory ? listProductPriceHistory(orgId, product) : Promise.resolve([]),
    canSeeCost ? readProductCosts(orgId, [product.id]) : Promise.resolve(null),
    canSeeCost || isBundle ? getCostBasis(orgId, org.timeZone) : Promise.resolve(null),
    isBundle ? createClient().then((supabase) => readBundleParts(supabase, orgId, product.id)) : Promise.resolve([]),
  ]);
  // PRD-09: the parts' sum in the bundle's own mode (a bundle that carries no VAT: the parts' net prices)
  const bundleIncludesVat = product.vatKind === "taxable" && product.priceIncludesVat;
  const referenceAgorot =
    isBundle && parts.length > 0 && costBasis ? partsReferenceSum(parts, bundleIncludesVat, costBasis.rateBp) : null;

  return (
    <div className="max-w-3xl space-y-4">
      <PageHeader
        title={product.name}
        back={{ href: productsPath(orgId), label: "מוצרים" }}
        actions={canEdit ? <ProductActions orgId={orgId} productId={product.id} name={product.name} archived={product.archivedAt !== null} /> : null}
      />
      {product.kind === "bundle" && partsSkippedNotice(partsSkipped, partsWhy) ? (
        <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
          {partsSkippedNotice(partsSkipped, partsWhy)}
        </p>
      ) : null}
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
      {isBundle ? (
        <BundlePartsCard
          orgId={orgId}
          bundleId={product.id}
          parts={parts.map((part) => ({ id: part.id, name: part.name, sku: part.sku, quantity: part.quantity, unitName: part.unitName, offerable: part.offerable }))}
          referenceAgorot={referenceAgorot}
          priceMode={costBasis?.chargesVat === false ? "בלי מע\"מ" : bundleIncludesVat ? "כולל מע\"מ" : "לפני מע\"מ"}
          canEdit={canEdit}
        />
      ) : null}
      {/* PKG-01: entries, validity and the meeting types of a punch card */}
      {product.kind === "punch_card" ? <PunchSettingsCard orgId={orgId} productId={product.id} canEdit={canEdit} /> : null}
      {costs && costBasis ? (
        <ProductCostCard
          orgId={orgId}
          productId={product.id}
          costAgorot={costs.get(product.id) ?? null}
          netPriceAgorot={productPriceFor(product, false, costBasis.rateBp)}
          chargesVat={costBasis.chargesVat}
          canEdit={canEdit}
        />
      ) : null}
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

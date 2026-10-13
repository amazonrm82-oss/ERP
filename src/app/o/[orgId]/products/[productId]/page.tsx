import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Card, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ProductDetails } from "@/features/products/components/product-details";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryLabel } from "@/features/products/lists";
import { productsPath } from "@/features/products/paths";
import { getProduct } from "@/features/products/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid } from "@/lib/paths";

export const metadata: Metadata = { title: "מוצר" };

type Props = { params: Promise<{ orgId: string; productId: string }> };

/** PRD-01: one product of the catalog. */
export default async function ProductPage({ params }: Props) {
  const { orgId, productId } = await params;
  await getOrgContext(orgId);
  if (!isUuid(productId)) notFound();
  const [product, categories, units] = await Promise.all([getProduct(orgId, productId), listProductCategories(orgId), listProductUnits(orgId)]);
  if (!product) notFound();

  return (
    <div className="max-w-3xl">
      <PageHeader title={product.name} back={{ href: productsPath(orgId), label: "מוצרים" }} />
      <Card>
        <CardBody>
          <ProductDetails
            product={product}
            categoryText={categoryLabel(categories, product.categoryId)}
            unitName={units.find((u) => u.id === product.unitId)?.name ?? null}
          />
        </CardBody>
      </Card>
    </div>
  );
}

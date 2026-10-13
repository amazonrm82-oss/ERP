import type { Metadata } from "next";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { AddCategoryForm, CategoryList } from "@/features/products/components/categories-editor";
import { AddUnitForm, UnitList } from "@/features/products/components/units-editor";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { CATEGORIES_PER_ORG, categoryTree, UNITS_PER_ORG } from "@/features/products/lists";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContext } from "@/features/shell/queries";

export const metadata: Metadata = { title: "קטגוריות ויחידות מידה" };

type Props = { params: Promise<{ orgId: string }> };

/** PRD-04: the categories and units products pick from. Owners and admins edit them. */
export default async function ProductListsPage({ params }: Props) {
  const { orgId } = await params;
  const { role, canWrite } = await getOrgContext(orgId);
  const editable = isAdminRole(role) && canWrite;
  const [categories, units] = await Promise.all([listProductCategories(orgId), listProductUnits(orgId)]);
  const tree = categoryTree(categories);

  return (
    <div className="space-y-6">
      <Card aria-labelledby="product-categories-title">
        <CardHeader id="product-categories-title" title="קטגוריות מוצרים" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>כל מוצר יכול להיות בקטגוריה אחת. אפשר לשים קטגוריה בתוך קטגוריה אחרת, עד שתי רמות.</p>
          <p>סינון לפי קטגוריה ראשית מציג גם את המוצרים שבתוכה.</p>
        </CardBody>
        {tree.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <CategoryList orgId={orgId} tree={tree} editable={editable} />
          </div>
        ) : (
          <CardBody className="mt-3 border-t border-line">
            <p className="text-md text-ink-soft">אין קטגוריות. מוצרים יכולים להיות גם בלי קטגוריה.</p>
          </CardBody>
        )}
        {editable && categories.length < CATEGORIES_PER_ORG ? (
          <CardBody className="border-t border-line">
            <AddCategoryForm orgId={orgId} tops={tree.map(({ id, name }) => ({ id, name }))} />
          </CardBody>
        ) : null}
      </Card>

      <Card aria-labelledby="product-units-title">
        <CardHeader id="product-units-title" title="יחידות מידה" />
        <CardBody className="space-y-2 pb-0 text-md text-ink-soft">
          <p>היחידה שבה מוכרים כל מוצר: יחידה, שעה, חודש וכדומה. שינוי שם מתעדכן בכל המוצרים.</p>
        </CardBody>
        {units.length > 0 ? (
          <div className="mt-3 border-t border-line">
            <UnitList orgId={orgId} units={units} editable={editable} />
          </div>
        ) : (
          <CardBody className="mt-3 border-t border-line">
            <p className="text-md text-ink-soft">אין יחידות מידה. מוצרים יכולים להיות גם בלי יחידה.</p>
          </CardBody>
        )}
        {editable && units.length < UNITS_PER_ORG ? (
          <CardBody className="border-t border-line">
            <AddUnitForm orgId={orgId} />
          </CardBody>
        ) : null}
      </Card>
    </div>
  );
}

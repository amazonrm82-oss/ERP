"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addCategoryAction, deleteCategoryAction, moveCategoryAction, updateCategoryAction } from "../list-actions";
import { CATEGORY_NAME_MAX, type CategoryNode, type ProductCategory } from "../lists";

type Top = { id: string; name: string };

/** The product categories as a two-level tree (PRD-04): rename, move under another category, reorder, delete. */
export function CategoryList({ orgId, tree, editable }: { orgId: string; tree: CategoryNode[]; editable: boolean }) {
  const tops: Top[] = tree.map(({ id, name }) => ({ id, name }));
  return (
    <ol className="divide-y divide-line">
      {tree.map((top, index) => (
        <li key={top.id}>
          <CategoryRow
            orgId={orgId}
            category={top}
            tops={tops}
            hasChildren={top.children.length > 0}
            editable={editable}
            isFirst={index === 0}
            isLast={index === tree.length - 1}
          />
          {top.children.length > 0 ? (
            <ol aria-label={`תתי-קטגוריות של ${top.name}`} className="divide-y divide-line border-t border-line ps-6 sm:ps-8">
              {top.children.map((child, childIndex) => (
                <li key={child.id}>
                  <CategoryRow
                    orgId={orgId}
                    category={child}
                    tops={tops}
                    hasChildren={false}
                    editable={editable}
                    isFirst={childIndex === 0}
                    isLast={childIndex === top.children.length - 1}
                  />
                </li>
              ))}
            </ol>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; category: ProductCategory; tops: Top[]; hasChildren: boolean; editable: boolean; isFirst: boolean; isLast: boolean };

function CategoryRow({ orgId, category, tops, hasChildren, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateCategoryAction.bind(null, orgId, category.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return <p className="px-4 py-3 font-medium break-words sm:px-5">{category.name}</p>;
  }

  // a category can go under any other top category; one with subcategories stays on top (two levels)
  const parents = tops.filter((top) => top.id !== category.id);
  const parentValue = failure?.values?.parent_id ?? category.parentId ?? "";

  return (
    <div className="space-y-2 px-4 py-3 sm:px-5">
      <form key={`${category.name}-${category.parentId ?? ""}`} action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
        <TextField
          label={`שם הקטגוריה ${category.name}`}
          hideLabel
          name="name"
          required
          maxLength={CATEGORY_NAME_MAX}
          autoComplete="off"
          controlSize="sm"
          className="min-w-0 flex-[1_1_10rem]"
          defaultValue={failure?.values?.name ?? category.name}
          error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
        />
        {hasChildren ? null : (
          <SelectField
            label={`מיקום הקטגוריה ${category.name}`}
            hideLabel
            name="parent_id"
            controlSize="sm"
            defaultValue={parentValue}
            className="flex-[1_1_9rem] sm:max-w-56"
          >
            <option value="">קטגוריה ראשית</option>
            {parents.map((top) => (
              <option key={top.id} value={top.id}>
                בתוך: {top.name}
              </option>
            ))}
          </SelectField>
        )}
        <SubmitButton size="sm" variant="secondary">
          שמירה
          <span className="sr-only">: {category.name}</span>
        </SubmitButton>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <ActionButton action={moveCategoryAction.bind(null, orgId, category.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={category.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveCategoryAction.bind(null, orgId, category.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={category.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton
          action={deleteCategoryAction.bind(null, orgId, category.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={category.name}
          confirm={
            hasChildren
              ? `למחוק את "${category.name}"? תתי-הקטגוריות שלה יהפכו לקטגוריות ראשיות, ומוצרים בה יישארו בלי קטגוריה.`
              : `למחוק את "${category.name}"? מוצרים בה יישארו בלי קטגוריה.`
          }
        >
          מחיקה
        </ActionButton>
      </div>
    </div>
  );
}

export function AddCategoryForm({ orgId, tops }: { orgId: string; tops: Top[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(addCategoryAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="flex flex-wrap items-start gap-2" noValidate>
      <TextField
        label="קטגוריה חדשה"
        hideLabel
        placeholder="קטגוריה חדשה, למשל: ייעוץ"
        name="name"
        required
        maxLength={CATEGORY_NAME_MAX}
        autoComplete="off"
        controlSize="sm"
        className="min-w-0 flex-[1_1_10rem]"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name ?? (failure && !failure.fieldErrors ? failure.message : undefined)}
      />
      <SelectField label="מיקום הקטגוריה החדשה" hideLabel name="parent_id" controlSize="sm" defaultValue={failure?.values?.parent_id ?? ""} className="flex-[1_1_9rem] sm:max-w-56">
        <option value="">קטגוריה ראשית</option>
        {tops.map((top) => (
          <option key={top.id} value={top.id}>
            בתוך: {top.name}
          </option>
        ))}
      </SelectField>
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת קטגוריה
      </SubmitButton>
    </form>
  );
}

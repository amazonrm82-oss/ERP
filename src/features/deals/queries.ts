import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { Json, StageKind } from "@/lib/database.types";
import { PAGE_SIZE, textSearchFilter } from "@/lib/search";
import { sortColumn, type CustomSortKey, type Sort } from "@/lib/sort";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";
import { readAllPages, readAllPagesByIds } from "@/lib/paged-read";
import { listFieldDefinitions } from "@/features/custom-fields/queries";
import type { FieldDefinition } from "@/features/custom-fields/types";
import type { CatalogColumn } from "@/features/list-columns/columns";

import { BOARD_PREFERENCE, boardCatalog, boardNeeds, daysSince, resolveBoardFields } from "./board-fields";
import { shownRecurringAmount } from "./recurring";

// color: a key of STAGE_COLORS or null (DEAL-01; see stage-colors.ts)
export type StageOption = { id: string; name: string; kind: StageKind; color: string | null };

export type BoardDeal = {
  id: string;
  name: string;
  amountAgorot: number;
  stageId: string;
  contactId: string | null;
  contactName: string | null;
  // DEAL-04: the onboarding task's default owner in the close window
  ownerId: string | null;
  // DEAL-03: kept when the deal is moved to a lost stage from the board
  competitor: string | null;
  // DEAL-03: the picked loss reason (name as stored on the deal), the default when it moves again
  lossReason: { id: string; name: string } | null;
  // DEAL-09: fields a card may show; a lookup nobody shows stays null
  companyId: string | null;
  companyName: string | null;
  expectedCloseDate: string | null;
  // DEAL-07: the recurring line of a card (null kind = one-time)
  billingKind: string | null;
  recurringAmountAgorot: number | null;
  renewalDate: string | null;
  // the value is computed (DEAL-07); amountSource says from what (DLI-03: lines or first year)
  amountAuto: boolean;
  amountSource: string | null;
  daysInStage: number;
  tagIds: string[];
  // only when a custom field is shown (else {})
  customFields: Json;
  nextTask: { title: string; dueAt: string | null } | null;
};

export type StageTotal = { count: number; amountAgorot: number };

export type Board = {
  pipeline: { id: string; name: string };
  stages: StageOption[];
  deals: BoardDeal[];
  // exact count and sum per stage (the board loads only part of the deals)
  totals: Record<string, StageTotal>;
  // a filtered board counted only the first FILTERED_TOTALS_LIMIT deals
  totalsPartial: boolean;
  // stages whose deals were loaded (closed stages only on request)
  loadedStages: string[];
  showClosed: boolean;
};

/** Board filters (DEAL-09). Ids are checked by the page; dates are YYYY-MM-DD. */
export type BoardFilter = { ownerId?: string | null; teamId?: string | null; tagId?: string | null; closeFrom?: string | null; closeTo?: string | null };

export function isBoardFiltered(filter: BoardFilter): boolean {
  return Boolean(filter.ownerId || filter.teamId || filter.tagId || filter.closeFrom || filter.closeTo);
}

// Cards loaded per stage: the most recently moved first. One stage can be opened in full.
export const STAGE_LIMIT = 50;
export const STAGE_FULL_LIMIT = 500;
// a filtered board sums its deals itself, up to this many (and says so past it)
export const FILTERED_TOTALS_LIMIT = 5000;

export type PipelineOption = { id: string; name: string; isDefault: boolean };

/** Live pipelines, default first. */
export async function listPipelines(orgId: string): Promise<PipelineOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pipelines")
    .select("id, name, is_default")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`pipelines query failed: ${error.message}`);
  }
  return data.map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default }));
}

/**
 * A live pipeline with its stages in order: the requested one when it exists,
 * else the default (or first) one. Null when the organization has none.
 */
export async function getPipeline(
  orgId: string,
  pipelineId?: string | null,
): Promise<{ id: string; name: string; stages: StageOption[] } | null> {
  const pipelines = await listPipelines(orgId);
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  if (!pipeline) {
    return null;
  }
  const supabase = await createClient();
  const { data: stages, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind, color")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipeline.id)
    .order("position", { ascending: true });
  if (stagesError) {
    throw new Error(`stages query failed: ${stagesError.message}`);
  }
  return { id: pipeline.id, name: pipeline.name, stages };
}

/** Kanban data for a pipeline (default: the default one), or null when the organization has no pipeline. */
export async function getBoard(
  orgId: string,
  pipelineId?: string | null,
  options: { showClosed?: boolean; fullStage?: string | null; filter?: BoardFilter; cardFields?: string[] } = {},
): Promise<Board | null> {
  const pipeline = await getPipeline(orgId, pipelineId);
  if (!pipeline) {
    return null;
  }
  const supabase = await createClient();
  const showClosed = options.showClosed === true;
  const loadedStages = pipeline.stages.filter((stage) => showClosed || stage.kind === "open").map((stage) => stage.id);
  const filter = options.filter ?? {};
  const filtered = isBoardFiltered(filter);

  // the same conditions on the cards and, when filtered, on the totals
  const narrow = <Q extends { eq: (column: string, value: string) => Q; gte: (column: string, value: string) => Q; lte: (column: string, value: string) => Q; contains: (column: string, value: string[]) => Q }>(query: Q): Q => {
    let q = query;
    if (filter.ownerId) q = q.eq("owner_id", filter.ownerId);
    if (filter.teamId) q = q.eq("team_id", filter.teamId);
    if (filter.tagId) q = q.contains("tag_ids", [filter.tagId]);
    if (filter.closeFrom) q = q.gte("expected_close_date", filter.closeFrom);
    if (filter.closeTo) q = q.lte("expected_close_date", filter.closeTo);
    return q;
  };

  // the totals function has no filters: a filtered board counts its deals itself (amounts only),
  // page by page (a read returns at most 1,000 rows, RVW-2), up to FILTERED_TOTALS_LIMIT
  const filteredTotals = () =>
    readAllPages(
      async (from, to) =>
        must(
          await narrow(
            supabase.from("deals").select("stage_id, amount_agorot").eq("organization_id", orgId).eq("pipeline_id", pipeline.id).is("deleted_at", null),
          )
            .order("id", { ascending: true })
            .range(from, to),
          "deal totals",
        ) ?? [],
      { limit: FILTERED_TOTALS_LIMIT },
    );
  const [totalsResult, ...stageResults] = await Promise.all([
    filtered ? filteredTotals() : supabase.rpc("deal_stage_totals", { p_org: orgId, p_pipeline: pipeline.id }),
    ...loadedStages.map((stageId) =>
      narrow(
        supabase
          .from("deals")
          .select("id, name, amount_agorot, stage_id, contact_id, owner_id, competitor, lost_reason_id, lost_reason, company_id, expected_close_date, stage_entered_at, tag_ids, custom_fields, billing_kind, recurring_amount_agorot, renewal_date, amount_auto, amount_source, recurring_amount_auto")
          .eq("organization_id", orgId)
          .eq("pipeline_id", pipeline.id)
          .eq("stage_id", stageId)
          .is("deleted_at", null),
      )
        .order("stage_entered_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(options.fullStage === stageId ? STAGE_FULL_LIMIT : STAGE_LIMIT),
    ),
  ]);
  if ("error" in totalsResult && totalsResult.error) {
    throw new Error(`deal totals query failed: ${totalsResult.error.message}`);
  }
  for (const result of stageResults) {
    if (result.error) {
      throw new Error(`deals query failed: ${result.error.message}`);
    }
  }
  const rows = stageResults.flatMap((result) => result.data ?? []);

  const totals: Record<string, StageTotal> = {};
  let totalsPartial = false;
  if ("rows" in totalsResult) {
    totalsPartial = !totalsResult.complete;
    for (const row of totalsResult.rows) {
      const t = (totals[row.stage_id] ??= { count: 0, amountAgorot: 0 });
      t.count += 1;
      t.amountAgorot += Number(row.amount_agorot);
    }
  } else {
    for (const t of (Array.isArray(totalsResult.data) ? totalsResult.data : []) as Array<{ stage_id: string; count: number; amount_agorot: number }>) {
      totals[t.stage_id] = { count: Number(t.count), amountAgorot: Number(t.amount_agorot) };
    }
  }

  const contactIds = [...new Set(rows.map((row) => row.contact_id).filter((id): id is string => Boolean(id)))];
  const contactNames = new Map<string, string>();
  if (contactIds.length > 0) {
    const contacts = must(await supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("organization_id", orgId)
      .in("id", contactIds), "contacts");
    for (const contact of contacts ?? []) {
      contactNames.set(contact.id, contact.full_name || contact.email || contact.phone || "איש קשר ללא שם");
    }
  }

  // DEAL-09: company names and next tasks only when a card shows them
  const needs = boardNeeds(options.cardFields ?? []);
  const companyNames = new Map<string, string>();
  const nextTasks = new Map<string, { title: string; dueAt: string | null }>();
  const companyIds = needs.company ? [...new Set(rows.map((row) => row.company_id).filter((id): id is string => Boolean(id)))] : [];
  const dealIds = needs.nextTask ? rows.map((row) => row.id) : [];
  const [companies, tasks] = await Promise.all([
    readAllPagesByIds(companyIds, async (slice, from, to) =>
      must(await supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "companies") ?? [],
    ),
    // open tasks of the cards' deals, soonest first (no date last); the first one per deal is its next step
    readAllPagesByIds(dealIds, async (slice, from, to) =>
      must(
        await supabase
          .from("tasks")
          .select("id, deal_id, title, due_at")
          .eq("organization_id", orgId)
          .in("deal_id", slice)
          .eq("status", "open")
          .is("deleted_at", null)
          .order("due_at", { ascending: true, nullsFirst: false })
          .order("id", { ascending: true })
          .range(from, to),
        "next tasks",
      ) ?? [],
    ),
  ]);
  for (const company of companies) companyNames.set(company.id, company.name);
  // slices are read one after another: order them again (time, no date last), then keep each deal's first
  const byDue = (t: { due_at: string | null }) => (t.due_at ? new Date(t.due_at).getTime() : Number.POSITIVE_INFINITY);
  for (const task of [...tasks].sort((a, b) => byDue(a) - byDue(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (task.deal_id && !nextTasks.has(task.deal_id)) nextTasks.set(task.deal_id, { title: task.title, dueAt: task.due_at });
  }
  const now = new Date();

  return {
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages: pipeline.stages,
    totals,
    totalsPartial,
    loadedStages,
    showClosed,
    deals: rows.map((row) => ({
      id: row.id,
      name: row.name,
      amountAgorot: row.amount_agorot,
      stageId: row.stage_id,
      contactId: row.contact_id,
      contactName: row.contact_id ? (contactNames.get(row.contact_id) ?? null) : null,
      ownerId: row.owner_id,
      competitor: row.competitor,
      lossReason: row.lost_reason_id ? { id: row.lost_reason_id, name: row.lost_reason ?? "" } : null,
      companyId: row.company_id,
      companyName: row.company_id ? (companyNames.get(row.company_id) ?? null) : null,
      expectedCloseDate: row.expected_close_date,
      billingKind: row.billing_kind,
      recurringAmountAgorot: shownRecurringAmount(row.recurring_amount_agorot, row.recurring_amount_auto),
      renewalDate: row.renewal_date,
      amountAuto: row.amount_auto === true,
      amountSource: row.amount_source,
      daysInStage: daysSince(row.stage_entered_at, now),
      tagIds: row.tag_ids ?? [],
      customFields: needs.custom ? row.custom_fields : {},
      nextTask: nextTasks.get(row.id) ?? null,
    })),
  };
}

export type BoardFields = { catalog: CatalogColumn[]; keys: string[]; fields: FieldDefinition[]; saved: boolean };

/** The signed-in user's choice of card fields for the deals board (DEAL-09), with everything a card can show. */
export async function getBoardFields(orgId: string): Promise<BoardFields> {
  const supabase = await createClient();
  const [fields, saved] = await Promise.all([
    listFieldDefinitions(orgId, "deal"),
    supabase.from("list_preferences").select("columns").eq("organization_id", orgId).eq("object_type", BOARD_PREFERENCE).maybeSingle(),
  ]);
  const row = must(saved, "board fields");
  const catalog = boardCatalog(fields);
  return { catalog, keys: resolveBoardFields(row?.columns ?? null, catalog), fields, saved: Boolean(row) };
}

export type RelatedDeal = {
  id: string;
  name: string;
  amountAgorot: number;
  stageName: string | null;
  status: StageKind;
  // CON-03: the record's part in the deal, when the card shows one
  roleLabel?: string | null;
};

/**
 * Live deals whose main contact (or company) is the given record, or the given deals
 * (CON-03: the deals a contact takes part in), newest first (latest 50).
 */
export async function listRelatedDeals(
  orgId: string,
  related: { contactId: string } | { companyId: string } | { dealIds: string[] },
): Promise<RelatedDeal[]> {
  if ("dealIds" in related && related.dealIds.length === 0) {
    return [];
  }
  const supabase = await createClient();
  const base = supabase.from("deals").select("id, name, amount_agorot, stage_id, status").eq("organization_id", orgId);
  const filtered =
    "dealIds" in related
      ? base.in("id", related.dealIds)
      : "contactId" in related
        ? base.eq("contact_id", related.contactId)
        : base.eq("company_id", related.companyId);
  const { data, error } = await filtered
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`related deals query failed: ${error.message}`);
  }
  if (data.length === 0) {
    return [];
  }
  const stages = must(await supabase
    .from("stages")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", [...new Set(data.map((deal) => deal.stage_id))]), "stages");
  const stageNames = new Map((stages ?? []).map((stage) => [stage.id, stage.name]));

  return data.map((deal) => ({
    id: deal.id,
    name: deal.name,
    amountAgorot: deal.amount_agorot,
    stageName: stageNames.get(deal.stage_id) ?? null,
    status: deal.status,
  }));
}

/** A live deal with the names around it and the stages of its pipeline, or null. */
export async function getDeal(orgId: string, dealId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .select(
      "id, name, amount_agorot, pipeline_id, stage_id, status, expected_close_date, closed_at, lost_reason, lost_reason_id, competitor, contact_id, company_id, owner_id, created_at, original_created_on, custom_fields, tag_ids, snoozed_until, previous_deal_id, billing_kind, recurring_amount_agorot, recurring_start_date, renewal_date, amount_auto, amount_source, recurring_amount_auto, amount_quote_id",
    )
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`deal query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const [stages, pipeline, contact, company, owners] = await Promise.all([
    supabase
      .from("stages")
      .select("id, name, kind, color")
      .eq("organization_id", orgId)
      .eq("pipeline_id", data.pipeline_id)
      .order("position", { ascending: true }),
    supabase.from("pipelines").select("name").eq("organization_id", orgId).eq("id", data.pipeline_id).maybeSingle(),
    data.contact_id
      ? supabase.from("contacts").select("full_name, email, phone").eq("organization_id", orgId).eq("id", data.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    data.company_id
      ? supabase.from("companies").select("name").eq("organization_id", orgId).eq("id", data.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    getUserNames([data.owner_id]),
  ]);

  return {
    ...data,
    stages: (stages.data ?? []) as StageOption[],
    pipelineName: pipeline.data?.name ?? null,
    contactName: contact.data ? contact.data.full_name || contact.data.email || contact.data.phone || "איש קשר ללא שם" : null,
    contactPhone: contact.data?.phone ?? null,
    companyName: company.data?.name ?? null,
    ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null,
  };
}

export type DealListItem = {
  id: string;
  name: string;
  amountAgorot: number;
  currency: string;
  stageId: string;
  status: StageKind;
  contactId: string | null;
  contactName: string | null;
  companyName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  expectedCloseDate: string | null;
  // DEAL-07
  billingKind: string | null;
  recurringAmountAgorot: number | null;
  recurringStartDate: string | null;
  renewalDate: string | null;
  createdAt: string;
  // GAP-12: the creation date in the system it was imported from
  originalCreatedOn: string | null;
  customFields: Json;
};

// columns the deals table can be sorted by (LST-09); stage, contact, company and owner are computed fields (migration 0035)
export const DEAL_SORT_COLUMNS = {
  name: "name",
  amount: "amount_agorot",
  stage: "sort_stage",
  status: "status",
  contact: "sort_contact",
  company: "sort_company",
  owner: "sort_owner",
  expected_close: "expected_close_date",
  billing_kind: "billing_kind",
  recurring_amount: "recurring_amount_agorot",
  recurring_start: "recurring_start_date",
  renewal: "renewal_date",
  created: "created_at",
  // GAP-12: written by an import only
  original_created: "original_created_on",
} as const;
export type DealSortKey = keyof typeof DEAL_SORT_COLUMNS;
export const DEAL_DEFAULT_SORT: Sort<DealSortKey> = { key: "created", ascending: false };

/** One page of a pipeline's live deals (the table view), newest first unless sorted otherwise. Fetches one extra row to know if there is a next page. */
export async function listDeals(
  orgId: string,
  options: {
    pipelineId: string;
    search: string;
    tagId?: string | null;
    page: number;
    sort?: Sort<DealSortKey | CustomSortKey>;
    filter?: string | null;
    ids?: string[];
    chunk?: { from: number; size: number };
  },
): Promise<{ deals: DealListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("deals")
    .select("id, name, amount_agorot, currency, stage_id, status, contact_id, company_id, owner_id, expected_close_date, billing_kind, recurring_amount_agorot, recurring_amount_auto, recurring_start_date, renewal_date, created_at, original_created_on, custom_fields")
    .eq("organization_id", orgId)
    .eq("pipeline_id", options.pipelineId)
    .is("deleted_at", null);
  const searchFilter = textSearchFilter(options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }
  if (options.tagId) {
    query = query.contains("tag_ids", [options.tagId]);
  }
  if (options.ids) {
    query = query.in("id", options.ids);
  }
  if (options.filter) {
    query = query.or(options.filter);
  }
  const sort = options.sort ?? DEAL_DEFAULT_SORT;
  const { data, error } = await query
    .order(sortColumn(DEAL_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: sort.ascending })
    .range(from, from + size);
  if (error) {
    throw new Error(`deals query failed: ${error.message}`);
  }
  const rows = data.slice(0, size);

  const contactIds = [...new Set(rows.map((row) => row.contact_id).filter((id): id is string => Boolean(id)))];
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter((id): id is string => Boolean(id)))];
  const [owners, contacts, companies] = await Promise.all([
    getUserNames(rows.map((row) => row.owner_id)),
    contactIds.length > 0 ? supabase.from("contacts").select("id, full_name, email, phone").eq("organization_id", orgId).in("id", contactIds) : Promise.resolve({ data: [] }),
    companyIds.length > 0 ? supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", companyIds) : Promise.resolve({ data: [] }),
  ]);
  const contactName = new Map((contacts.data ?? []).map((c) => [c.id, c.full_name || c.email || c.phone || "איש קשר ללא שם"]));
  const companyName = new Map((companies.data ?? []).map((c) => [c.id, c.name]));

  return {
    hasMore: data.length > size,
    deals: rows.map((row) => ({
      id: row.id,
      name: row.name,
      amountAgorot: row.amount_agorot,
      currency: row.currency,
      stageId: row.stage_id,
      status: row.status,
      contactId: row.contact_id,
      contactName: row.contact_id ? (contactName.get(row.contact_id) ?? null) : null,
      companyName: row.company_id ? (companyName.get(row.company_id) ?? null) : null,
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
      expectedCloseDate: row.expected_close_date,
      billingKind: row.billing_kind,
      recurringAmountAgorot: shownRecurringAmount(row.recurring_amount_agorot, row.recurring_amount_auto),
      recurringStartDate: row.recurring_start_date,
      renewalDate: row.renewal_date,
      createdAt: row.created_at,
      originalCreatedOn: row.original_created_on,
      customFields: row.custom_fields,
    })),
  };
}

export type DealLinks = {
  // the deal this one continues, when the user may read it and it is not in the recycle bin
  previous: { id: string; name: string } | null;
  // follow-up deals of this one the user reads, newest first (latest 50)
  followUps: RelatedDeal[];
};

/** DEAL-11: the deal a follow-up continues, and the follow-ups of a deal. */
export async function getDealLinks(orgId: string, dealId: string, previousDealId: string | null): Promise<DealLinks> {
  const supabase = await createClient();
  const [previous, followUps] = await Promise.all([
    previousDealId
      ? supabase.from("deals").select("id, name").eq("organization_id", orgId).eq("id", previousDealId).is("deleted_at", null).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    supabase
      .from("deals")
      .select("id")
      .eq("organization_id", orgId)
      .eq("previous_deal_id", dealId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);
  const previousRow = must(previous, "previous deal");
  const ids = must(followUps, "follow-up deals").map((row) => row.id);
  return { previous: previousRow, followUps: await listRelatedDeals(orgId, { dealIds: ids }) };
}

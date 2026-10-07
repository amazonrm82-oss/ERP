-- 20261006002200_deal_board: part 1 of 1. Run the parts in order.
-- =============================================================================
-- 0022 Deals board: exact totals per stage, and an index for loading by stage
-- =============================================================================
-- The board loads a limited number of deals per stage, so its counts and sums
-- come from public.deal_stage_totals(): security invoker, so RLS decides what is
-- counted, exactly as on the board.
-- Every statement is safe to run twice.

create index if not exists deals_board_stage_idx on public.deals (organization_id, pipeline_id, stage_id, stage_entered_at desc) where deleted_at is null;

create or replace function public.deal_stage_totals(p_org uuid, p_pipeline uuid) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('stage_id', t.stage_id, 'count', t.n, 'amount_agorot', t.amount)), '[]'::jsonb)
    from (
      select d.stage_id, count(*) as n, coalesce(sum(d.amount_agorot), 0) as amount
        from public.deals d
       where d.organization_id = p_org and d.pipeline_id = p_pipeline and d.deleted_at is null
       group by d.stage_id) t;
$$;

revoke all on function public.deal_stage_totals(uuid, uuid) from public, anon;
grant execute on function public.deal_stage_totals(uuid, uuid) to authenticated;

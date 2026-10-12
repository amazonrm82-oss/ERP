-- 20261006004800_plural_notification_triggers: part 1 of 1. Run the parts in order.
-- =============================================================================
-- 0048 Notifications address the user in the plural, like every screen (FXU-09)
-- =============================================================================
-- Part 1 of 2: the assignment triggers get their new titles (part 2, 004810,
-- re-creates two functions for the texts they write). Notifications already
-- sent keep their text. Every statement is safe to run twice.

drop trigger if exists leads_notify_assignment on public.leads;
create trigger leads_notify_assignment after insert or update of owner_id on public.leads
  for each row execute function app.notify_assignment('lead', 'ליד חדש הוקצה לכם');
drop trigger if exists deals_notify_assignment on public.deals;
create trigger deals_notify_assignment after insert or update of owner_id on public.deals
  for each row execute function app.notify_assignment('deal', 'עסקה הוקצתה לכם');
drop trigger if exists tasks_notify_assignment on public.tasks;
create trigger tasks_notify_assignment after insert or update of owner_id on public.tasks
  for each row execute function app.notify_assignment('task', 'משימה חדשה הוקצתה לכם');

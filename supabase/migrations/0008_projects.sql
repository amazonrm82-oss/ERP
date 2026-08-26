-- Light project management: projects + a flat milestone list with due dates. Deliberately no
-- WBS/dependency graph/interactive Gantt rendering — a dated checklist is what actually gets used
-- day to day; a real Gantt view is a substantial piece of UI on its own and out of scope here.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  customer_id uuid references public.customers(id),
  status text not null default 'פעיל' check (status in ('פעיל', 'הושלם', 'מבוטל')),
  start_date date,
  end_date date,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.project_milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text not null,
  due_date date,
  done boolean not null default false,
  sort_order integer not null default 0
);

alter table public.projects enable row level security;
alter table public.project_milestones enable row level security;

create policy projects_select on public.projects for select using (auth.uid() is not null);
create policy projects_insert on public.projects for insert with check (auth.uid() is not null);
create policy projects_update on public.projects for update using (auth.uid() is not null) with check (auth.uid() is not null);

create policy project_milestones_select on public.project_milestones for select using (auth.uid() is not null);
create policy project_milestones_insert on public.project_milestones for insert with check (auth.uid() is not null);
create policy project_milestones_update on public.project_milestones for update using (auth.uid() is not null) with check (auth.uid() is not null);

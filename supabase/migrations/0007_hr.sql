-- HR: employee records + clock in/out. The "payroll estimate" in the UI is computed live from
-- attendance × hourly_rate — deliberately NOT a persisted payroll run, and deliberately not a
-- real payroll/tax engine (no withholding, no pension, no payslip). It's a number to sanity-check
-- against, not a document to hand an employee.

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id),
  name text not null,
  role_title text,
  phone text,
  email text,
  employment_type text not null default 'שעתי' check (employment_type in ('שעתי', 'חודשי')),
  hourly_rate numeric,
  monthly_salary numeric,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.attendance_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees(id),
  clock_in timestamptz not null default now(),
  clock_out timestamptz,
  created_at timestamptz not null default now()
);

alter table public.employees enable row level security;
alter table public.attendance_entries enable row level security;

create policy employees_select on public.employees for select using (auth.uid() is not null);
create policy employees_write on public.employees for all using (public.is_manager()) with check (public.is_manager());

-- An employee clocks their own attendance in/out; a manager can see and fix everyone's.
create policy attendance_select on public.attendance_entries for select using (auth.uid() is not null);
create policy attendance_insert on public.attendance_entries for insert with check (
  public.is_manager() or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid())
);
create policy attendance_update on public.attendance_entries for update using (
  public.is_manager() or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid())
) with check (
  public.is_manager() or exists (select 1 from public.employees e where e.id = employee_id and e.profile_id = auth.uid())
);

# OPS-09: access rules under load (results)

Measured on 15 November 2026 on a local throwaway PostgreSQL 16 (`npm run db:test:start`, own port), never on a hosted
database. Fixture: `scripts/perf/access-load.sql` with `scale=1` (one business with 300,000 leads, 200,000 contacts,
20,000 companies, 50,000 deals and 200,000 tasks; 60 people, 12 teams in two levels, one member absent with a deputy,
and 20 small businesses of 500 leads), analyzed. Runner: `scripts/perf/access-load-measure.sql` (`-v vis=team|own|org`,
`-v limit_s=15s`): each query is the one the app sends through PostgREST for a list, run as the person (role
`authenticated`, JWT claims with `aal1`), and the cell is EXPLAIN ANALYZE's execution time in ms; `> N` = cancelled by the
statement timeout of N ms.

Queries: `page` = first page of 51 newest (`order by created_at desc, id desc limit 51`), `count` = the exact count of the
list (`count=exact`), `search` = `search_text like '%77%'` with the page order, `sort_owner` = first page ordered by
`sort_owner`. People: owner, admin, a manager of a parent team, a member of two teams, a member who is a deputy (HEB-08),
a viewer.

## Before (migrations up to 021278), visibility `team`, timeout 15 s

| table | query | owner | admin | manager | member | deputy | viewer |
|---|---|---|---|---|---|---|---|
| companies | count | 1242.7 | 1403.7 | 2586.8 | 2513.2 | 2250.0 | 3560.9 |
| companies | page | 3.8 | 4.3 | 28.7 | 32.8 | 71.4 | 78.1 |
| companies | search | 29.4 | 29.3 | 207.9 | 193.5 | 424.0 | 725.1 |
| companies | sort_owner | 12059.8 | 12270.6 | 5198.6 | 5550.8 | 3477.2 | 4645.3 |
| contacts | count | 13511.6 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| contacts | page | 2.9 | 3.3 | 29.3 | 28.7 | 60.9 | 114.0 |
| contacts | search | 19.8 | 29.2 | 292.5 | 218.2 | 400.8 | 627.5 |
| contacts | sort_owner | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| deals | count | 3673.0 | 4147.4 | 6785.1 | 6326.9 | 6054.6 | 8002.9 |
| deals | page | 3.0 | 3.3 | 37.3 | 30.7 | 76.8 | 83.6 |
| deals | search | 28.0 | 31.6 | 238.0 | 188.6 | 571.2 | 643.6 |
| deals | sort_owner | > 15000 | > 15000 | 13113.4 | 13150.1 | 9005.2 | 11119.2 |
| leads | count | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| leads | page | 5.9 | 6.4 | 39.4 | 31.6 | 95.1 | 95.6 |
| leads | search | 32.2 | 35.3 | 302.3 | 167.1 | 326.9 | 616.5 |
| leads | sort_owner | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| tasks | count | 13593.9 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| tasks | page | 13331.0 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| tasks | search | 14321.1 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |
| tasks | sort_owner | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 | > 15000 |

Where the time went: every row a list reads paid `app.can_read_record()`, a plpgsql definer calling
`app.membership_role()`, `app.has_verified_factor()`, `app.session_aal()`, `app.in_team()` and `app.manages_team()`, all SQL
functions that PostgreSQL does not inline (definer or a SET clause) and plans again on every call. An owner's count of
300,000 leads was over 15 s although the answer is "all of them". `sort_owner` was a SQL function with a FROM (never
inlined), so every row ran the profiles rule (`app.shares_org`, planned per call) from scratch: over 15 s for every role.
Indexes were not the problem: every plan used `(organization_id, created_at)` or the FK indexes; the filter was.

## What changed (migration `20261006021280_access_perf.sql`)

1. The select policies of leads, contacts, companies, deals and tasks ask `app.can_read_record()`'s rule as sets judged
   once per statement (`app.my_record_orgs()`, `app.my_read_teams()`, `app.my_teams()`), hashed subplans instead of a
   function call per row; the HEB-08 deputy line unchanged; TASK-07's `app.team_task_visible()` behind its own start
   conditions. profiles asks `app.shares_org()` as a set (`app.my_shared_users()`).
2. The leaf helpers (`session_aal`, `has_verified_factor`, `membership_role`, `platform_role`, `support_session`, `role_in`,
   `is_member`, `in_team`, `manages_team`) are plpgsql with their queries unchanged, so their plans are kept for the
   session. This also matters for every policy that still asks per row (activities read leads/contacts/companies/deals
   through `app.can_read_activity_subject` once per activity): without it the set policies made such per-row reads
   slower (test 296's punch-card report went from about 1.2 s to 4.6 s on the first try); with it, 0.7 s.
3. `sort_owner` reads the owner's name through `app.owner_sort_name()` (plpgsql definer, profiles_select's rule for that
   one profile); the five wrappers inline.
4. Index `team_members (user_id)` for the caller's teams across businesses.

Same answers: test 370 compares, for 19 kinds of person in all three visibility modes, the rows the new policies return
with the old rule evaluated row by row, the helpers with their old SQL bodies, and sort_owner with its old body.

## After, visibility `team`, timeout 60 s

| table | query | owner | admin | manager | member | deputy | viewer |
|---|---|---|---|---|---|---|---|
| companies | count | 5.9 | 3.3 | 13.9 | 8.7 | 24.1 | 10.2 |
| companies | page | 0.3 | 0.3 | 5.1 | 4.8 | 16.8 | 6.4 |
| companies | search | 2.0 | 1.9 | 6.8 | 6.9 | 18.7 | 10.5 |
| companies | sort_owner | 683.7 | 639.0 | 179.3 | 196.1 | 99.4 | 96.8 |
| contacts | count | 49.6 | 44.1 | 52.6 | 53.7 | 60.7 | 51.9 |
| contacts | page | 0.4 | 0.3 | 4.7 | 4.8 | 13.9 | 6.4 |
| contacts | search | 2.3 | 2.2 | 7.0 | 7.0 | 14.3 | 9.8 |
| contacts | sort_owner | 6265.0 | 7452.9 | 1784.1 | 1864.9 | 928.6 | 815.7 |
| deals | count | 9.9 | 9.0 | 13.8 | 13.7 | 32.8 | 14.5 |
| deals | page | 0.2 | 0.3 | 4.3 | 4.5 | 23.6 | 6.0 |
| deals | search | 1.6 | 1.7 | 6.2 | 6.6 | 27.1 | 8.7 |
| deals | sort_owner | 1540.1 | 1930.9 | 415.0 | 560.1 | 212.5 | 246.0 |
| leads | count | 77.9 | 102.7 | 70.7 | 70.1 | 110.4 | 68.8 |
| leads | page | 0.3 | 0.3 | 4.6 | 4.8 | 24.9 | 6.4 |
| leads | search | 2.3 | 2.2 | 7.3 | 7.2 | 27.8 | 10.1 |
| leads | sort_owner | 9618.5 | 11394.7 | 2670.7 | 2997.2 | 1839.0 | 1372.6 |
| tasks | count | 33.8 | 34.1 | 44.4 | 43.1 | 59.8 | 43.3 |
| tasks | page | 47.2 | 46.6 | 48.1 | 46.1 | 62.6 | 44.2 |
| tasks | search | 886.6 | 841.8 | 333.7 | 344.4 | 271.7 | 178.4 |
| tasks | sort_owner | 6386.0 | 7856.8 | 1978.2 | 2218.7 | 1335.6 | 972.9 |

## After, visibility `own`

| table | query | owner | admin | manager | member | deputy | viewer |
|---|---|---|---|---|---|---|---|
| companies | count | 6.9 | 4.1 | 16.6 | 7.7 | 23.0 | 12.2 |
| companies | page | 0.5 | 0.4 | 7.1 | 9.0 | 25.7 | 9.5 |
| companies | search | 1.9 | 1.9 | 6.8 | 7.2 | 21.7 | 8.5 |
| companies | sort_owner | 537.9 | 737.8 | 183.6 | 8.1 | 22.4 | 10.6 |
| contacts | count | 47.3 | 46.7 | 70.8 | 43.4 | 55.6 | 42.2 |
| contacts | page | 0.3 | 0.3 | 4.1 | 53.5 | 10.8 | 42.7 |
| contacts | search | 1.9 | 1.9 | 6.5 | 37.2 | 19.1 | 39.0 |
| contacts | sort_owner | 6107.9 | 7933.4 | 1923.8 | 33.4 | 66.1 | 37.2 |
| deals | count | 15.1 | 9.2 | 27.8 | 14.1 | 43.9 | 11.4 |
| deals | page | 0.2 | 0.3 | 3.9 | 11.4 | 28.0 | 12.1 |
| deals | search | 1.4 | 1.5 | 5.4 | 10.6 | 25.6 | 11.9 |
| deals | sort_owner | 1577.9 | 2009.6 | 475.7 | 12.4 | 38.3 | 13.9 |
| leads | count | 87.8 | 73.5 | 77.8 | 61.6 | 125.4 | 66.3 |
| leads | page | 0.3 | 0.3 | 4.0 | 55.3 | 23.4 | 44.2 |
| leads | search | 2.0 | 1.8 | 6.2 | 41.8 | 25.1 | 44.0 |
| leads | sort_owner | 9498.7 | 11704.0 | 2659.5 | 64.7 | 460.3 | 60.5 |
| tasks | count | 36.0 | 37.4 | 47.3 | 39.2 | 60.6 | 392.4 |
| tasks | page | 39.7 | 39.6 | 41.6 | 29.9 | 47.6 | 450.0 |
| tasks | search | 876.0 | 962.3 | 287.3 | 82.7 | 135.7 | 451.9 |
| tasks | sort_owner | 6112.4 | 8233.7 | 2109.0 | 182.4 | 378.1 | 399.0 |

## After, visibility `org`

| table | query | owner | admin | manager | member | deputy | viewer |
|---|---|---|---|---|---|---|---|
| companies | count | 9.3 | 3.9 | 3.6 | 3.5 | 3.5 | 4.0 |
| companies | page | 0.3 | 0.3 | 0.3 | 0.4 | 0.3 | 0.5 |
| companies | search | 1.8 | 1.8 | 1.7 | 2.0 | 2.1 | 2.2 |
| companies | sort_owner | 713.8 | 808.0 | 755.6 | 913.7 | 790.5 | 811.2 |
| contacts | count | 54.5 | 45.5 | 59.9 | 45.6 | 45.7 | 46.4 |
| contacts | page | 0.4 | 0.3 | 0.3 | 0.4 | 0.3 | 0.7 |
| contacts | search | 2.1 | 2.1 | 2.1 | 2.2 | 2.1 | 2.5 |
| contacts | sort_owner | 6375.4 | 7931.3 | 7706.2 | 7559.1 | 7571.6 | 8205.1 |
| deals | count | 14.9 | 7.9 | 7.9 | 7.9 | 8.0 | 8.0 |
| deals | page | 0.4 | 0.3 | 0.3 | 0.4 | 0.3 | 0.4 |
| deals | search | 1.4 | 1.4 | 1.4 | 1.5 | 1.5 | 1.7 |
| deals | sort_owner | 1557.1 | 1959.8 | 1829.4 | 2023.3 | 2040.2 | 1884.8 |
| leads | count | 58.8 | 51.7 | 51.8 | 50.6 | 51.8 | 50.6 |
| leads | page | 0.3 | 0.3 | 0.3 | 0.5 | 0.4 | 0.6 |
| leads | search | 1.8 | 1.9 | 1.9 | 1.9 | 1.9 | 2.1 |
| leads | sort_owner | 9471.4 | 11788.3 | 11692.5 | 11650.0 | 11662.1 | 11854.5 |
| tasks | count | 63.2 | 41.1 | 36.0 | 35.5 | 35.3 | 37.0 |
| tasks | page | 48.8 | 49.3 | 49.6 | 53.4 | 48.8 | 47.5 |
| tasks | search | 915.4 | 837.7 | 856.5 | 817.1 | 836.9 | 695.4 |
| tasks | sort_owner | 5459.0 | 7487.4 | 7844.1 | 7942.3 | 7846.8 | 8322.0 |

## What is still slow

- `sort_owner` over the whole business: about 30 µs per row (one profile read and the profiles rule per row). On 300,000
  leads an owner or admin waits 9.5-11.8 s, over the hosted 8 s statement timeout; 50,000 deals take 1.5-2 s. A stored,
  server-kept owner name (or sorting by the owner's id and naming only the page) would remove it; not done here because it
  changes what the column holds (a follow-up for the lead).
- `search` on tasks (about 0.9 s for an owner on 200,000 tasks): `search_text(tasks)` has no trigram index (the other four
  tables have one). Not an access-rule cost.
- Not measured: the hosted project (Postgres 17, its own hardware), concurrency, and update/insert paths
  (`can_edit_record` still runs per row in the update policies; a bulk change of thousands of rows pays it).

## Moderate fixture (test 371, every `npm run test:db`)

40,000 leads and 20,000 tasks, analyzed, visibility `team`, locally: count 13-31 ms, page 2-7 ms, search 11-29 ms, owner
sort 0.3-1.0 s, tasks count 8-10 ms (bounds 3 s, owner sort 8 s).

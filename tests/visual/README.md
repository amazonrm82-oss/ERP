# Screenshot comparison (DSN-18)

Every push photographs the main screens and the design gallery (`/admin/design`) at 360px and 1280px
and compares them with the baselines in `tests/visual/baseline/`. An unexpected change in appearance
fails the CI job `e2e`, so `promote` does not move `production`.

בכל דחיפה מצולמים המסכים הראשיים וגלריית העיצוב ברוחב 360 ו-1280, ומושווים לתמונות הבסיס
שב-`tests/visual/baseline/`. שינוי לא צפוי במראה מכשיל את `e2e`, ולכן `production` לא מתקדם.

## Files

| file | what |
| --- | --- |
| `run.mjs` | the run: `compare` or `update` (and `--dry`) |
| `compare.mjs` | the comparison (pure, unit-tested in `tests/unit/visual-compare.test.ts`) |
| `png.mjs` | a small PNG reader/writer, so no package is needed |
| `stabilize.mjs` | what is masked or frozen before a shot |
| `baseline/<screen>-<width>.png` | the baselines, made by CI on the runner |
| `../e2e/sample.mjs` | the sample business (shared with `tests/e2e/screens.mjs`, DSN-14) |

## Running it locally / הרצה מקומית

Needs the local stack and the app, as for `npm run test:e2e` (`npm run stack:start`, the app on port 3000).

```bash
node tests/visual/run.mjs compare          # exit 1 on a change; output in tests/visual/out/
node tests/visual/run.mjs update           # replace tests/visual/baseline/ with new shots
node tests/visual/run.mjs compare --dry    # no browser: the list of shots and the plan
```

`E2E_APP_URL`, `E2E_MAIL_URL`, `E2E_DB_URL` and `E2E_CHROMIUM_PATH` work as for the browser flow;
`VISUAL_OUT` and `VISUAL_BASELINE` move the output and the baseline folder. Like the flow, it refuses any
address that is not on this machine. Each run signs up a new sample business and a staff member.

**Do not commit baselines made on your own machine.** Fonts are the app's own (Heebo), but Chromium on
a laptop or in a container still draws text slightly differently from the GitHub runner. Local `update`
is for looking at the pictures; the committed set always comes from CI.

## Refreshing the baselines in CI / רענון תמונות הבסיס

When a change in appearance is intended (or a screen was added):

1. GitHub, Actions, workflow **CI**, **Run workflow**, on `main` (or the branch that holds the change),
   with **screenshots = update**. A run started by hand never promotes.
2. When job `e2e` ends, download the artifact `screenshots-<run id>-<attempt>`.
3. Copy its `actual/*.png` into `tests/visual/baseline/` (replacing the folder's PNGs) and commit them
   with the change.

Without any baseline (the first time), `compare` compares nothing, writes a warning and still uploads
the fresh shots in the same artifact: steps 2 and 3 of any push run then give the first set.
A shot without a baseline, or a baseline without a shot, is only a warning; refresh to clear it.

On a failure the artifact holds `actual/` (this run), `expected/` (the baseline) and `diff/` (the
baseline faded, changed pixels in red), and the job summary lists every shot with its share of changed pixels.

## Thresholds

A pixel counts as changed when one of its colour channels (blended onto white) moves by more than
24 of 255, which absorbs anti-aliasing. A shot fails when more than 0.1% of its pixels changed, or when
its size changed (a page that grew or shrank changed its appearance). A shot that fails is taken once
more before the verdict, so a late font or request does not fail the push. Change the thresholds in
`compare.mjs` (`DEFAULTS`), never per run.

## What is masked, and why / מה מוסתר ולמה

The sample data is made at the start of every run, so anything that depends on the clock or on the
run itself is replaced, in the page only, before the shot (`stabilize.mjs`):

- **Text**: every date (`1.11.2026`, `2026-11-01`, `1 בנובמבר 2026`, `נובמבר 2026`, week days), time
  (`09:30`), age or countdown (`לפני 3 שעות`, `25 דקות`), id (UUID) and e-mail address (the sample's
  addresses carry the run's time) becomes the fixed `▒▒▒▒`. A fixed string, not a box over the old text,
  so the layout around it does not move when a date is longer or shorter.
- **Inputs** of type date, time, datetime-local and month get a fixed value.
- **Motion**: animations and transitions are off, the caret is transparent, scrollbars hidden, the
  focused element blurred, media paused; `reducedMotion: reduce`, light scheme, Asia/Jerusalem, `he-IL`,
  device scale 1, sRGB, no GPU.
- **The sample** (`tests/e2e/sample.mjs`): tasks are due on the business's own days (yesterday 12:00,
  today 23:59, tomorrow, in three days), so they fall in the same groups at any hour; the calendar opens
  on the fixed week of 12 October 2026, where the sample's meetings are.
- **Per screen**: `HIDE` in `run.mjs` hides a selector on one screen when masking text is not enough.
  It is empty today; add an entry with its reason rather than raising a threshold.

Not masked on purpose: names, amounts, counts, statuses, colours and layout, which are what the
comparison is for.

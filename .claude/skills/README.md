# Claude Code skills in this repo

Third-party skills, copied in and checked by hand. Project rules in `CLAUDE.md` win over anything a
skill says. Licenses are inside each folder.

| Skill | Source | Notes |
|---|---|---|
| ui-ux-pro-max, banner-design, brand, design, design-system, slides, ui-styling | nextlevelbuilder/ui-ux-pro-max-skill (MIT) | AI image generators in `design` need a paid API key; none is set |
| frontend-design, webapp-testing | anthropics/skills | |
| vercel-react-best-practices, vercel-composition-patterns | vercel-labs/agent-skills (MIT) | |
| next-dev-loop, next-bundle-optimizer | vercel/next.js `skills/` (MIT) | global install / upgrade only when the user asks |
| supabase-postgres-best-practices | supabase/agent-skills (MIT) | the `supabase` skill was left out: it advises ad-hoc `execute_sql` DDL, against hard rule 3 |
| systematic-debugging, test-driven-development, verification-before-completion, requesting-code-review, receiving-code-review, dispatching-parallel-agents | obra/superpowers (MIT) | `superpowers:` prefixes removed |
| differential-review, sharp-edges | trailofbits/skills (CC BY-SA 4.0) | `allowed-tools` removed from differential-review |
| saas-adversarial-audit | jlacera/saas-claude-skills (MIT) | Spanish; do not run its scanner against production |
| database-schema-designer, process-mapper, procurement-optimizer, vendor-management | alirezarezvani/claude-skills (MIT) | general guidance for new systems and ERP/purchasing modules |

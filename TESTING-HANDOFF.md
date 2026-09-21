# ATLAS consolidated testing snapshot

This is the combined source for `codex/atlas-testing`, prepared September 21,
2026. It is separate from production `main` and is not authorization to publish
unfinished Delivery Routing to live ATLAS. Read AGENTS.md before making changes.

## Included work

- Current `origin/main` at `0fa2b9e`: existing ATLAS, Receiver icons and sign-in,
  sidebar fixes, account/warehouse consistency, COC isolation and admin-only
  Scanner Intelligence. All other recorded feature branches are already
  ancestors of this main commit.
- `codex/delivery-routing` at `e6eb45c`: the routing interface, load planning,
  photo intake, saved days/history, trip locks, trip sheets, flexible lunch,
  mobile Add Page / Next Order / Done workflow, and private hosting sources.
- Merge reconciliation preserves main's current authorization behavior and
  adds routing to the existing navigation. The cache is v369, worker URL v272,
  and dashboard asset v189. The standalone preview includes the current shared
  login helper. No new database or Edge Function behavior is introduced.

## Working and testing

Use this combined branch as the starting point for future testing changes.
Create focused update branches from it, then integrate reviewed changes back
into it. Do not combine obsolete feature branches again or push to main.

```powershell
node tools/run-regressions.cjs
git diff --check
```

Node.js 24 is used. See tests/README.md for coverage and limitations. Original
branches and working folders were preserved. NEW COC 2.xlsx and the protected
COC generator modules remain unchanged.

## Hosting and data are separate from source

The existing permanent routing preview is:
https://atlas-routing-app-tbcotacnuq-uc.a.run.app/

That host serves the standalone routing preview, not the complete ATLAS site.
Creating this combined branch/ZIP does not update a deployed service. The full
ATLAS entry point includes the routing UI, but its Google/photo/saved-day
connection wiring still lives in the private preview bootstrap. Do not assume
opening index.html alone reproduces all connected preview services.

Cloud Run identities, runtime configuration, Google API restrictions, Supabase
schemas/data, uploaded product catalogs, browser state and saved orders are
external to this source snapshot. Credentials must remain outside Git and
outside files uploaded to ChatGPT Work. Source under supabase/functions is not
an instruction to deploy it; the routing Edge entry point is deliberately
closed because routing uses keyless Cloud Run.

The transfer ZIP has an export manifest identifying its source commit, file
hashes and any browser-configuration placeholders. A `_historical_context`
folder, if included, preserves previously untracked audit and staging sources
for reference only. Those files are not active application code, verified
current deployment state, or an approved production migration sequence.

When returning work from ChatGPT Work, provide the changed files and complete
diff against the snapshot commit. Do not replace the entire live project with
an edited ZIP; review and test the changes on the testing branch first.

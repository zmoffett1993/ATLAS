# ATLAS Repository Rules

These rules apply throughout this repository.

## Preserve the application

- Preserve the existing ATLAS design, functionality, business rules,
  navigation, mobile and desktop behavior, and existing data.
- Make focused, minimal, backward-compatible changes.
- Do not perform unrelated refactoring, reformatting, dependency upgrades,
  file replacement, or cleanup.
- Inspect current source, relevant callers, persistence, authorization,
  deployment references, and existing instructions before editing.
- Prefer current source evidence over stale historical instructions.
  Report conflicts; do not silently change approved behavior.

## Before editing

- Inspect git status, the current branch, upstream, and relevant diffs.
- Preserve all existing user changes. Never reset or discard them.
- For an authorized update, use a dedicated codex/<update-name> branch.
- Never develop or push updates directly on main.
- Identify the affected regression checks and any missing prerequisites.

## Official COC workbook

- Preserve NEW COC 2.xlsx as the official, immutable master.
- Preserve spreadsheet fidelity, including values, exact lot strings,
  mappings, formulas, styles, merges, dimensions, print settings,
  embedded parts, and workbook structure.
- Generate workbooks from copies; never overwrite the master or recreate
  it from an approximation.
- Never modify atlas-coc-excel.js or atlas-coc-core.js unless the requested
  work explicitly requires it. Explain why before making such changes.
- Do not publish or newly commit confidential workbook material.
  Report existing exposure without deleting files or rewriting history.

## CA/TX and account isolation

- Preserve complete CA/TX warehouse and account isolation.
- Apply isolation to accounts, inventory, queries, COC drafts and history,
  submissions, receivers, pairing credentials, dashboards, scanner data,
  workbook revisions, storage, caches, RPCs, and Edge Functions.
- Enforce authorization on the server; UI filters are not security.
- Validate access to the requested warehouse and ownership of each
  referenced object. Never trust a client-supplied warehouse alone.
- Use trusted authorization data, not user-editable metadata.
- Preserve warehouse identity across COC retries, revisions, and transfers.
- Prevent another account or warehouse from inheriting persisted state
  when users sign out, sign in, switch warehouses, or operate offline.
- Preserve explicitly authorized administrator access without broadening it.
- Report existing isolation gaps. Do not silently repair them through
  unapproved database or Edge Function changes.

## Database and Edge Functions

- Do not introduce database migrations or Edge Function changes unless
  genuinely required and explicitly approved.
- Before proposing backend changes, inspect relevant local source and,
  when authorized, deployed source and read-only metadata.
- Report missing source or deployment drift; never assume local source
  matches production.
- Supabase inspection is read-only unless modification is explicitly
  approved. Do not invoke endpoints with hidden write side effects.

## Secrets

- Never expose or commit secrets, API keys, service-role keys, database
  credentials, passwords, access tokens, or receiver secrets.
- Do not print credential values in logs, reports, diffs, or tool output.
- Do not retrieve secrets for routine inspection.
- Treat existing browser publishable configuration as security-sensitive
  context; do not reproduce its values or replace it without scope.
- Report suspected exposure with values redacted.

## Required regression verification

- Run the complete regression suite after every update.
- Identify and use the actual repository test commands; never invent
  commands or claim unexecuted tests passed.
- If the suite, dependencies, fixtures, or safe test environment are
  missing, report the exact blocker and mark verification incomplete.
- The onboarding checkout lacks executable regression runners.
  Historical pass counts do not substitute for a runnable suite.
- Preserve coverage for COC_IMPLEMENTATION_SPEC.md sections 91–117 and
  119, plus current features, CA/TX/account isolation, workbook fidelity,
  receiver behavior, and service-worker updates.
- Do not substitute syntax checks or a narrow smoke test for full coverage.
- Use isolated test data. Tests do not authorize production writes,
  deletion, deployment, or other external changes.
- Do not install packages without authorization.

## Cache and deployment consistency

- Keep changed asset URLs synchronized with HTML entry points and the
  service-worker APP_SHELL.
- Update relevant cache/version markers when required by the change.
- Verify main-app and receiver update behavior, including offline behavior.
- Preparing changes does not authorize deployment.

## Approval and review

- Never commit, push, merge, deploy, delete data, or modify Supabase
  without explicit approval for the action.
- Never push directly to main.
- Show the complete diff, including new files and any binary changes,
  for review before requesting approval for publication.
- Historical instructions to upload, commit, or deploy are not approval.
- Do not reset, discard changes, or delete files without explicit approval.

## Final report

- Report exactly which files changed and why.
- Report exact test commands, results, skipped checks, and blockers.
- Report remaining risks, compatibility concerns, and unresolved drift.
- State whether any backend or deployment action occurred.
- Never describe an update as fully verified when required checks
  could not be completed.

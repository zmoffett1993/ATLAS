> Update: the subsequently approved staging validation is complete. See RECEIVER-LOGIN-STAGING-RESULTS.md for current results and the private key-registry correction. Production remains unchanged; preparation-only statements below describe the initial checkpoint.

# Receiver visible sign-in names — prepared, not deployed

Branch: codex/coc-receiver-spaced-login-names, based on current origin/main 6cb48df2f3a0cbada1f43e398ee691948d921cc8. Original routing worktree and prior audit worktree preserved. No commit, push, merge, deployment, package installation, database migration, Supabase modification or production-account repair occurred during this request.

## Root cause and evidence

The current deployed atlas-user-admin v22 matches repository source. Read-only production inspection confirms legacy CA Office COC Station / officecocstation with unset revision and TX Office COC Receiver / officecocreceiver at revision 1. Their synthetic emails match their current login names. Neither proposed canonical key is occupied and no existing undeleted synthetic-email key collisions were found.

The failed managed-account rename has a concrete transaction-order conflict. The Edge function sends email and atlas_assignment_request in one updateUserById call. Supabase Auth's admin update implementation updates the email before app_metadata, within one database transaction. ATLAS prepare_assignment immediately rejects a changed email without a marker when the old revision is greater than zero. At that first email statement, the later marker is not present. The transaction rolls back before its operation can be captured; reconciliation finds no committed result and the handler returns the generic 503. This explains unchanged TX data and why retrying cannot fix it. Read-only evaluation against the current TX account confirmed all three predicates (managed revision, changed proposed email, absent marker) are true.

Sources: https://github.com/supabase/auth/blob/master/internal/api/admin.go (SetEmail before UpdateAppMetaData); verified deployed function definitions in receiver-login-baseline.json. This is source-level diagnosis plus read-only predicate confirmation. The historical failed-request log and hosted Auth build identifier were not available, and no live failure was deliberately reproduced. Changelog markdown retrieval failed; current official Auth source and documentation were accessible.

The proposal removes only the premature email guard. The existing deferred consistency trigger checks the final email/key at transaction completion; it also verifies the visible-name/key relationship for upgraded accounts. Unauthorized email-only changes to managed accounts still fail at commit. Existing role/home/grant consistency checks, actor authorization locks, revision conflict handling and operation ledger stay in place. The new login_key participates in immutable metadata checks and the committed operation request. No out-of-transaction compensation, identity replacement or password write is added.

## Canonical name/key rule

atlas-login.js is the single browser/Edge rule specification. tools/build-login-proposal.mjs generates database normalization from those same rules; SQL is not independently hand-normalized.

Visible names: Unicode NFKC, explicit Unicode whitespace collapsed to a space, outer whitespace trimmed, capitalization and accents preserved, 2–60 characters, no email address. Internal keys: NFKD, remove combining marks U+0300–U+036F, require ASCII letters/digits/spaces/dot/underscore/hyphen, lowercase, remove spaces, require 2–48 characters without truncation. Thus TX COC Receiver, tx coc receiver and TX   COC   Receiver use txcocreceiver; CA uses cacocreceiver. Removing spaces retains existing employee credential keys. Unsupported input is rejected rather than silently shortened. Non-receiver accounts are not renamed or migrated automatically; existing stored normalized employee names remain valid.

New metadata stores visible login_name and internal login_key in trusted app_metadata. The key constructs the synthetic Auth email. Account snapshots already return app_metadata.login_name, not email, so no list-RPC change is needed. The API never returns login_key in normal responses. Receiver display and sign-in fields both use the exact warehouse standard; fields are synchronized/read-only for this role and both frontend and server reject drift. Current account UUID remains the update target.

Uniqueness is checked against visible names in the administrator snapshot and enforced by a private login-key registry with a primary key and transactional Auth email trigger for undeleted synthetic identities. The rule is slightly stronger than active-only: banned but undeleted accounts still reserve their key. This covers legacy email keys without modifying legacy accounts. Concurrent email claims serialize at the private registry primary key. Supabase disallowed a custom index on auth.users, so no ownership change or index on that managed table is required. The database derives the key itself and rejects a supplied inconsistent key; no warehouse selector participates in password authentication.

## Authorization, diagnostics and compatibility

Auth getUser plus the existing service-only snapshot authorize the administrator from current trusted Auth/profile state. Database assignment checks the actor again and computes home/access from active warehouse records; receiver grants remain home-only. Naming changes do not alter COC/Receiver authorization functions or storage keys. Those bindings use UUID/warehouse/station, not the visible name. Editable user_metadata is never used to authorize.

Edge logs only action, fixed failure category and numeric status. SQL logs only whitelisted failure category and SQLSTATE. No request payload, names, password, token, receiver secret or raw diagnostic is logged. Known conflicts, stale revisions, warehouses, invalid names, missing accounts and administrator failures use safe messages; genuinely opaque Auth failures remain unconfirmed instead of fabricated certainty. The operation ID and expected revision still gate retries and conflicting edits.

Legacy revision behavior was inspected: current snapshot and trigger explicitly coalesce missing/null revision to 0, and the handler uses Number(value || 0). CA repair must therefore send expected_revision:0; TX currently sends 1. Re-read both at execution and stop if either changed. A legacy account is upgraded only by an explicitly approved assignment, not by listing or signing in.

## Exact staged rollout and repair order (requires separate approval)

1. Preserve reviewed source, current function definitions and current account/identity metadata in protected recovery storage. Do not export passwords or tokens. Recheck latest main, deployed Edge v22 equivalence, trigger definitions, collisions and account UUID/home/revision. Stop on drift. Pause administrator account edits during the coordinated change.
2. After approval for staging changes, apply receiver-login-proposal.json SQL in a single hosted migration transaction. The local Supabase CLI is absent, so this is a generated review manifest, not an invented CLI migration filename. Validate the SQL on staging before production. Run real Auth email-first rename, rollback, duplicate/concurrent rename, legacy upgrade, idempotency and old/new password sign-in tests. Do not treat the local mocks as this proof.
3. Stage the updated atlas-user-admin handler with atlas-login.js included at its actual relative path. Deployment bundle must include atlas-login.js, supabase/functions/atlas-user-admin/index.ts and handler.mjs, with entrypoint supabase/functions/atlas-user-admin/index.ts, so the handler's ../../../atlas-login.js import resolves. Preserve gateway verify_jwt:false plus in-handler getUser verification. No Receiver Edge Function deployment is needed.
4. Once staging passes and production publication is approved, apply the same database delta to production, deploy that Edge bundle, then publish the synchronized frontend. Refresh open Manage Account forms. The old handler remains compatible with ordinary normalized employee requests; legacy receiver edits should wait until the coordinated deployment completes.
5. Repair the original CA UUID first, then verify it before repairing the original TX UUID. Exact UUID-specific before-state and request templates are in the local receiver-account-repair-plan.json artifact outside this repository. Generate one operation UUID per approved repair and retain it for retries. CA request: role office_receiver, home CA, display_name/login_name CA COC Receiver, expected_revision 0. TX: role office_receiver, home TX, display_name/login_name TX COC Receiver, expected_revision 1. The server derives the key. Do not send password, create/delete either account, reassign foreign keys or alter warehouse grants outside the assignment protocol.
6. For each result, confirm original UUID, expected revision increment, profile display, visible login, internal email/key correspondence, correct home-only grants and exactly one new operation record. Confirm old name fails password sign-in and new spaced name succeeds using an authorized isolated session; never disclose credentials. Verify existing COC/history/pairing/revision record associations and receiver credentials remain unchanged. Replay the identical operation once and confirm no additional revision/write.
7. A rename does not intentionally revoke all sessions or delete/recreate pairings. Refresh the Receiver's Auth session to pick up its new labels; if necessary, local sign-out/sign-in with the new visible name preserves pairing. No forced global logout or re-pairing is planned. Verify actual Supabase session behavior in staging rather than assuming it. Then check both CA/TX Receiver sessions while Administration changes warehouses, including forged warehouse requests failing server authorization.
8. Verify all changed assets against APP_SHELL, worker URL 270, cache/Receiver marker 357, auth asset 8, dashboard asset 187 and shared login asset 1. Confirm anonymous inventory access is unchanged. Complete the real-device walkthrough before describing this as fully verified.

## Rollback procedure

Before any account uses the new protocol: stop account edits, restore the captured baseline prepare_assignment/check_consistency/capture_request definitions and previous Edge source, and restore frontend assets with a fresh cache marker. New helper functions and the private reservation registry/trigger can remain; no data deletion is needed. Verify there are no newly keyed accounts first; otherwise use the next path.

After a repair or new account with spaced names: preserve keys, UUIDs, passwords, operations and histories; do not restore the old database guard/handler blindly. Prefer a forward correction. If only frontend rollback is needed, the prior authentication algorithm resolves these chosen compact keys, but keep the corrected backend/database and use a fresh cache marker. A backend/account-name reversal requires a separately reviewed compatibility repair, fresh revisions and unique operations; strict receiver-name validation intentionally prevents casually changing back to legacy nonstandard names. Do not reset revisions, delete operations, replay the old provisioning script or delete/recreate accounts. No rollback was executed or claimed rehearsed.

## Tests executed

- node tools/build-login-proposal.mjs — PASS; deterministic review proposal generated; not applied.
- node --test tests/account-admin.test.mjs tests/account-frontend.test.cjs — PASS 35/35 after fixture updates.
- node --test tests/login-names.test.mjs tests/auth-login.test.cjs tests/account-admin.test.mjs — PASS 39/39.
- node --test tests/*.test.cjs tests/*.test.mjs — final PASS 89/89, no skipped runnable tests.
- node ../receiver-startup-check.cjs — PASS 14/14 against this checkout (CA/TX dashboard independence, saved pairing restoration, refresh/failure recovery, auth startup and sign-out races).
- node --check atlas-login.js; node --check atlas-auth.js; node --check atlas-dashboard.js; node --check service-worker.js; node --check supabase/functions/atlas-user-admin/handler.mjs; node --check tools/build-login-proposal.mjs — all PASS.
- Inline-script extraction piped to node --input-type module/commonjs --check — main 12 scripts and Receiver 3 scripts parse.
- git diff --check — PASS, line-ending notices only.
- git diff --quiet -- 'NEW COC 2.xlsx' atlas-coc-core.js atlas-coc-excel.js — PASS, unchanged.
- node ../check-original-work.cjs 'C:\Users\zacha\OneDrive\Documents\ChatGPT\ATLAS-Warehouse Management' — PASS all 70 original files unchanged.
- node ../names-worker-browser.cjs — actual local browser upgraded to v357; CA same-session offline data available, foreign session 503/no CA leak, no raw credential headers in cache, main/Receiver shells cached. After stopping server, Receiver opened/refreshed from cache. Production connections blocked. Server and tab closed afterward.

Initial local run failed because the old test fixture did not record login_key and expected the old lowercased visible name; it also caught an unbound Receiver form variable. Fixtures were updated to the new contract and the actual form variable fixed before the passing runs. No failing test is represented as a pass.

## Coverage and unavailable checks

Required scenarios 1–7 and 19–20: covered by handler, canonicalization, actual shared Auth helper (mock transport) and form tests. Scenarios 8–14: UUID/relationship preservation, old/new email selection, revision/replay/error atomicity covered at the handler fixture boundary; actual PostgreSQL/Auth transaction rollback, real old-name rejection/new-name success and concurrent unique-index claims remain unrun. Scenarios 15–16: existing Receiver source harness passes. Scenarios 17–18: prior deployed authorization remains unchanged; no fresh authenticated CA/TX API regression was run for this preparation-only change. Naming never sends a warehouse to password authentication.

No executable historical full regression suite, local PostgreSQL/Auth environment or Deno runtime is available. No packages were installed. Supabase changes (including staging) were explicitly prohibited, so database proposal execution and real account repair tests are blocked pending separate approval. Physical-device and native Excel tests are not claimed. The generated SQL is not yet certified executable by PostgreSQL. Exact actual-hosted Auth failure logs were unavailable. These gaps prevent calling the correction fully verified or ready for immediate production publication.

## Changed files

- atlas-login.js: single shared visible-name/key rule and standard Receiver names.
- atlas-auth.js: both sign-in surfaces use that rule; upgraded Receiver labels use trusted visible login.
- atlas-dashboard.js: warehouse-specific synchronized Receiver form names, submission guard and shared fallback sign-in canonicalization.
- index.html, coc-receiver/index.html, service-worker.js: load shared rule before Auth and synchronize all cache/version references.
- supabase/functions/atlas-user-admin/handler.mjs: separate visible/key fields, standard Receiver identity validation, safe failure categories and logs, preserve one Auth write/reconciliation.
- release/receiver-login-baseline.json: read-only captured deployed definitions for review/recovery; no account rows or secrets.
- release/receiver-login-proposal.json: unapplied generated database delta.
- tools/build-login-proposal.mjs: reproducible SQL generation from shared rules and verified baseline.
- tests/account-admin.test.mjs: new account/rename/legacy/collision/error coverage and updated request contract.
- tests/account-frontend.test.cjs: shared helper fixture, synchronized form/drift cases and asset checks.
- tests/service-worker.test.cjs: current cache-version assertion.
- tests/auth-login.test.cjs: actual shared sign-in helper with synthetic transport.
- tests/login-names.test.mjs: canonicalization/bounds/compatibility and proposal-source checks.
- release/RECEIVER-LOGIN-REVIEW.md: this review, test evidence, repair and rollout plan.

# Receiver naming — approved staging validation

Status: staging migration and atlas-user-admin v3 deployed and tested. Production unchanged. No production account repair, commit, push, merge or publication performed.

## Findings corrected during staging

1. Supabase rejects adding an index directly to its managed auth.users table (must be owner). That migration rolled back. The final proposal instead creates atlas_account_private.login_keys with a primary key, unique original user ID, deferred FK, revoked browser privileges and RLS. A narrowly scoped Auth email/deletion trigger reserves/releases the key within the same transaction. Legacy keys are populated without altering accounts. No Auth-table ownership change is required.
2. The first registry draft had a dollar-quote generation error. It failed atomically, was corrected and then applied successfully. A local edit helper also hit a constant-variable assignment error after saving the generator; the affected test assertion was corrected separately.
3. Directly inserted synthetic Auth fixtures failed the password-setup step before rename testing. The passing run uses Auth-created identities, with staging-only trusted metadata/grants reproducing legacy CA and managed revision-1 TX states. No production identities were used. The initial unused synthetic fixtures remain; no cleanup deleted users or data.
4. Concurrent equivalent-name creation initially blocked the duplicate safely but returned 503. The handler now rechecks the current authoritative account snapshot, reconciles the operation again, and returns a safe 409 conflict when another committed identity owns the key. A new unit regression and actual concurrent HTTP retest pass.

## Real staging results

- CA legacy revision-0 upgrade and TX managed revision-1 rename succeeded through the deployed account handler and Supabase Auth API.
- Both original synthetic UUIDs and passwords were preserved. Old names failed password sign-in; new keys derived from the spaced names signed into the same users.
- Existing sessions refreshed successfully. Existing synthetic pairing credentials verified after rename; neither account needed re-pairing.
- Exact visible names appear in the account-list response; login_key is not returned. Trusted metadata and profiles match the visible name, key and home; warehouse grants remain home-only.
- Replaying an operation returns the confirmed revision. Altered operation reuse and stale revision requests return 409. Equivalent-name duplicates are denied.
- Foreign CA/TX Receiver credentials and station requests return 403 after rename.
- Concurrent real HTTP updates: one winner, one revision increment, consistent final identity; loser 409.
- Concurrent canonical-equivalent account creates: one winner; loser 409 after correction.
- Actual PostgreSQL rollback-only transaction: email-first/metadata-second rename succeeds; injected post-assignment failure restores complete Auth row, profile, grants, key reservations and operation count. Email-only bypass and stale revisions fail without changing the original row. Outer transaction rolled back all fixtures.
- PostgreSQL normalization matches the shared helper for repeated whitespace, fullwidth Unicode and decomposed accents. Registry count matches undeleted synthetic identities.

## Commands and operations

- Supabase execute_sql: staged synthetic fixture setup only; subsequent normalization/registry read-only assertions; tests/staging/receiver-names-transaction.sql (PASS, rollback-only).
- Supabase apply_migration atlas_receiver_visible_login_names on staging qiaixkmwnfnondiwdmya: first ownership attempt FAIL/rollback, second generated quoting attempt FAIL/rollback, corrected private-registry proposal PASS.
- Supabase deploy_edge_function atlas-user-admin on staging: v2 candidate, v3 duplicate-conflict correction. Deployment bundle includes root atlas-login.js and the index/handler at their repository paths.
- node ../invoke-names-audit.cjs; Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8768/run | ConvertTo-Json -Depth 5: initial fixture setup FAIL; corrected CA/TX Auth run PASS; concurrent run initially found safe rejection with generic 503; corrected concurrent retest PASS with both conflicts 409. Passwords/tokens/receiver secrets stayed in memory and were not printed.
- Temporary atlas-staging-auth-audit versions 21–24 were nonce-gated test runners; v25 replaces them with an HTTP 410 retired handler and JWT verification enabled. Bridge servers were stopped; intentional Ctrl+C exits are not test failures.
- node tools/build-login-proposal.mjs — PASS after corrections.
- node --test tests/*.test.cjs tests/*.test.mjs — final PASS 90/90, no skipped runnable tests.
- node --check tests/staging/receiver-names-runner.ts; node --check tests/staging/receiver-names-concurrency.ts; node --check supabase/functions/atlas-user-admin/handler.mjs — PASS.
- git diff --check — PASS, line-ending notices only.
- Earlier prepared checkout checks remain recorded in RECEIVER-LOGIN-REVIEW.md: 14 Receiver source checks, browser cache/refresh, shared authentication, syntax and original-worktree preservation.

## Updated files in this pass

- tools/build-login-proposal.mjs and release/receiver-login-proposal.json: tested private registry replaces the unsupported Auth-table index.
- supabase/functions/atlas-user-admin/handler.mjs: confirm concurrent key conflict before returning a specific safe error.
- tests/login-names.test.mjs: assert the registry uniqueness structure.
- tests/account-admin.test.mjs: concurrent unique-rejection regression.
- tests/staging/receiver-names-runner.ts, receiver-names-concurrency.ts and receiver-names-transaction.sql: reproducible staging checks; never production deployment inputs.
- release/RECEIVER-LOGIN-REVIEW.md and this report: updated review/rollout evidence.

## Remaining scope

The naming correction is verified against staging Auth/PostgreSQL, not against real production accounts or physical demo equipment. The historical full regression suite remains unavailable. Production publication and the two UUID-preserving repairs are not performed by this staging pass. Keep the scoped production repair plan and recheck revisions/identity state before any subsequent repair. Do not ship temporary audit runners or staging fixtures in the production function bundle.

# POD Gmail pilot

## Current state

The user confirmed the synthetic test email arrived in their spam folder. The connection test is complete; routine sending remains disabled. The approved v375 driver-access SQL and private preview are now activated; see [POD-DRIVER-ACCESS.md](POD-DRIVER-ACCESS.md). The Gmail Edge Function and routine-email setting were not changed by that update.

Prepared on `codex/delivery-pod`, based on commit `39167d2`. With explicit approval, the private POD schema and Gmail extension were applied to shared project `dwrrbpiprcmajfyronlf` as migrations `20260922053431` and `20260922053443`. Only `delivery-pod` was deployed (version 1). Private photo/PDF buckets were created through Storage; the schema checks their configuration without writing Storage metadata.

The Gmail send-only grant and credentials are in protected Edge secrets. POD backend access is enabled for `https://atlas-routing-app-tbcotacnuq-uc.a.run.app` only. Existing CA-authorized administrators/supervisors have office membership, and Bubba/Ahmad have driver membership. A labeled synthetic test shipment `SO-999999999921` is isolated on planning day `2000-01-05`; the originally proposed future date was rejected by the existing dispatch validator, so no future-dispatch bypass was added. No customer orders were changed. No commit, push, merge or main-site deployment occurred.

Private Cloud Run revision `atlas-routing-app-00007-56r` serves the approved frontend with POD enabled. Build `fe6dd794-9cf5-490c-a3d5-f081ee193c6b` succeeded; deployed image digest is `sha256:e103e6982b3c5ea43fdfffa43934dceff2c777f1bd41f9107c2351b7ed5b41e2`. The approved `atlas-routing-build` service account has object-reader access only to this project's Cloud Build source bucket, writer access only to the `atlas-routing-preview` container repository, and project build-log writing. No downloaded service-account key or Owner/Editor grant was added.

The signed-in office workflow uploaded the synthetic JPEG and saved `POD-SO-999999999921.pdf` privately. Gmail accepted exactly one approved test email to the user's requested personal inbox at `2026-09-22T06:03:39Z`; submission `4b10ecd4-df9e-4edd-b514-8355ad471c1c` records Sent, one attempt, and provider receipt `1a0c7b677da824a2`. The user confirmed receipt in spam. The logistics recipient was restored afterward and `ATLAS_POD_EMAIL_ENABLED=false` was verified through a fresh POD list. Routine sending remains off. The browser download-event observation timed out, so a saved local download was not verified; the send workflow successfully fetched and hash-verified the private PDF.

During credential transfer, the initial refresh token and client secret inadvertently appeared in tool output. The original grant was revoked, the old client secret disabled, and replacement credentials saved. OAuth Playground was closed and the clipboard cleared. No credential file was created.

The server now supports `send-email` with only `podId`, `mode` and a UUID `requestId`. It validates the current user/session and shipment through database authorization, claims an attempt atomically, downloads the immutable private PDF, verifies its hash, derives its filename/subject, and calls Gmail. Browser-supplied sender, recipient, filename or storage path is rejected. Email failures never undo the saved POD.

Pilot configuration: ATLAS POD Delivery `<chubbygorilla.pod@gmail.com>` sends to and uses Reply-To `calogistics@chubbygorilla.com`. Body: `POD attached.` Standard subject/attachment: `POD-SO-68032` / `POD-SO-68032.pdf`; splits include `-SHIPMENT-1-OF-2`. Addresses are validated server configuration, never editable by drivers. A future approved sender requires an OAuth grant for that account and updated server secrets.

## Behavior and limits

- Drivers retain the scan/review/submit workflow. Saved documents are emailed in a separate request; failed/interrupted emails show “POD saved — email pending. Management can retry.” Successful sends show “POD SUBMITTED ✓”.
- Office members who also have a current trusted supervisor/admin role see Sent time, Pending/Failed, Retry Email, Resend Email and private Download PDF. No recipient editor is exposed.
- Database row locking protects concurrent claims. Attempt UUIDs protect repeated requests, including a repeated manager resend request. Sent records are not resent by normal submission. Retries/resends are explicitly initiated and audited; a 30-second cooldown also limits repeated manager actions.
- Gmail acceptance is recorded as Sent; it does not prove inbox receipt. The Gmail send endpoint has no documented idempotency key. Network loss, a 5xx response or lost database finalization therefore cannot guarantee exactly-once delivery. Such sends are held for manager inbox review, never automatically retried. An active `sending` claim cannot be replaced for five minutes. An explicit warned Resend can create a duplicate if the original actually arrived.
- No polling, email SDK, new package, automatic email scheduler or provider read-mail permission was added. Normal tests intercept Google and never send email.
- Email attachments are bounded at 18,000,000 PDF bytes before MIME encoding. Larger PODs remain privately saved and need management handling.
- New emails are not guaranteed to continue after closing the app; a saved Pending POD remains available for management retry. Existing account-scoped offline photo recovery is preserved.

## Database preparation

The approved SQL sources are `tools/delivery-pod/schema-draft.sql` and `tools/delivery-pod/email-schema-draft.sql`, in that order. They were applied through the connected Supabase migration tool, which recorded the versions above; do not reapply them to this project. They are not CLI-generated migration files. The additive email source adds status/receipt fields and an RLS-protected attempt table, private authorization/claim/finalization helpers, restricted RPC wrappers and email fields on the existing authorized list. The receipt event is named `pod_received` because email is handled separately.

Both SQL sources execute in the existing local PGlite/PostgreSQL test engine with isolated synthetic accounts, sessions and shipments. Tests check grants, cross-account/CA-TX denial, claim exclusivity, repeated-request behavior, receipt preservation and office-only retry/resend. PGlite is a single connection, not a hosted Supabase concurrency test. Supabase CLI and Deno are unavailable locally; CLI migration generation and local Deno type checks remain unperformed. Hosted Storage policies and database advisors were inspected during activation. All five POD tables have RLS, no direct authenticated table grants, and no anonymous POD RPC grants. Existing non-POD security-definer and disabled leaked-password-protection advisories remain outside this change.

## Google authorization and server configuration

These are reproducible setup instructions. Google setup and protected-secret storage are complete; two-step verification/company recovery are not verified. Use the secure account/dashboard UI for credentials; never paste tokens into chat, command history, source, screenshots or test logs.

1. Secure the pilot Gmail account with two-step verification and company-controlled recovery. In its dedicated Google Cloud project enable Gmail API, configure the external OAuth consent screen and add the pilot sender as a test user.
2. Create a Web application OAuth client with the exact authorized redirect URI `https://developers.google.com/oauthplayground`.
3. Open [Google OAuth Playground](https://developers.google.com/oauthplayground/). In settings use **your own OAuth credentials**, Google endpoints, server-side flow, Offline access, and Consent Screen prompt. Enter the client ID/secret there. Using Playground's default client causes its refresh token to be revoked after 24 hours.
4. Authorize only `https://www.googleapis.com/auth/gmail.send`, signing in as the pilot sender. Exchange the authorization code. Do not use Playground to send a real message during setup.
5. Copy the refresh token directly into the approved Supabase project's protected Edge Function secrets. Keep these six names server-only:
   `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GMAIL_SENDER_EMAIL`, `POD_RECIPIENT_EMAIL`, `POD_REPLY_TO_EMAIL`.
6. Close/reset the Playground page after securely saving the values; never create/share a Playground link containing credentials. No local credential file is required. Do not revoke the OAuth grant while the pilot is using it.
7. Keep `ATLAS_POD_EMAIL_ENABLED=false` until private POD storage, exact allowed origins, real account permissions, bindings and the Gmail sender have been verified. The existing `ATLAS_POD_ENABLED` and `ATLAS_POD_ORIGINS` remain required; platform-provided Supabase variables stay server-only.

**Reauthorization:** external OAuth apps in Testing with this scope have refresh tokens that expire after seven days. Before a demonstration, repeat steps 3–5 with the same owned OAuth client and sender, replacing only the protected refresh token. If consent does not return a new token, revoke the pilot app's access from that Gmail account and authorize again; this intentionally invalidates the previous grant. Reauthorization is also needed after revocation or an invalid grant. Never treat a short-lived access token as the refresh token. See [Google token expiration](https://developers.google.com/identity/protocols/oauth2#expiration), [OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Activation and rollback

The approved activation above used the connected migration/deployment tools; do not apply the SQL sources again to this project. For future CLI-managed changes, inspect installed CLI help and generate migration files through that CLI. Verify the linked project before any deployment. Deploy only the explicitly approved function. Custom JWT/current-session checks remain in the handler/database; preserve existing `config.toml` settings. See [Supabase deployment](https://supabase.com/docs/guides/functions/deploy) and [server secrets](https://supabase.com/docs/guides/functions/secrets).

The single approved synthetic test was accepted by Gmail at the user's alternate recipient, with the standard subject and attachment filename. Deployed office authorization, receipt, Storage retrieval and Sent recording passed. Driver-account end-to-end entry, split-email appearance, partial-dispatch binding, physical phone behavior remain unverified. The dedicated driver entry and office binding UI still require completion; the synthetic binding used the authorized RPC. This is not a claim that the complete live driver pilot is ready.

Rollback: turn off `ATLAS_POD_EMAIL_ENABLED` to stop new sends, and optionally turn off POD capture. Let an already accepted/in-flight send reconcile; disabling does not recall email. Restore the previous frontend/function revision if needed, while preserving private PDFs, receipt fields and attempt history. Do not drop tables/buckets or delete delivery data. If credentials are suspected compromised, revoke the specific Gmail grant and rotate its protected configuration through approved account controls.

## Verification commands

```powershell
node --test tests/delivery-pod-email.test.mjs tests/delivery-pod-sql.test.mjs
node tools/run-regressions.cjs
node --check atlas-routing-pod.js
git diff --check

# Existing local browser/runtime; no install or real email:
$env:ATLAS_PLAYWRIGHT_PATH='C:/Users/zacha/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'
$env:ATLAS_BROWSER_PATH='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node tools/delivery-pod/check-recovery.cjs
```

Nine focused email/database cases were added to the existing suite, plus email retry assertions in the existing mobile recovery check. Activation verification: `node tools/run-regressions.cjs` passed all 359 runnable tests; `git diff --check` passed. Hosted probes accepted the exact private origin (204), rejected an unrelated origin (403), and rejected missing authentication (401). The authenticated synthetic upload and Gmail send passed as recorded above. Historical COC sections 91–117/119 still lack their original executable runners/fixtures; current tests do not replace that missing coverage. Physical phone and installed-PWA upgrade verification remain incomplete.

Gmail uses RFC 2822 MIME and base64url `raw` messages as described in [Google's sending guide](https://developers.google.com/workspace/gmail/api/guides/sending) and [messages.send reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

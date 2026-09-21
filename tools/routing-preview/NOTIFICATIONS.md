# ATLAS delivery review notifications — implementation plan

Status: local controls, device connection, permanent host, private job and SQL
proposal prepared; NOT connected, scheduled, deployed or activated.
Both iPhone and Android are in scope. History search and delivery status storage
are already active in the private preview. Do not deploy unfinished routing into
live ATLAS. Existing Cloud Shell pages do not have this local update yet.

## Approved recipient and schedule

Zach is the ONLY recipient. Do not enroll Bubba, Achmad, administrators, other
preview members, or any other account automatically. Support for Android does
not grant permission to send to additional people. Multiple devices may belong
to Zach; any additional recipient needs explicit approval.

Send at **5:00 PM Monday through Friday, America/Los_Angeles**. The scheduler must
use this named timezone so daylight-saving changes are handled automatically.
Proposed scheduler expression: `0 17 * * 1-5`. No weekend reminders or next-day
catch-up messages. A late scheduler start may run until 5:14 PM; a queued phone
message has a 15-minute TTL and is discarded by the worker after 5:29 PM.

## Daily workflow

- Only shipments explicitly marked sent out can become assumed delivered.
- At 5 PM America/Los_Angeles, sent-out shipments without an exception display
  Assumed delivered. This is a planning assumption, never proof of delivery.
- One weekday reminder opens a review with All Delivered and individual exceptions.
  Opening/dismissing a notification never changes delivery data.
- All Delivered records confirmation; retain an editable actual delivery date.
- An exception takes priority over assumed/confirmed status until resolved.
- Split orders must not be marked sent out until all their shipments have gone out.
- No daily reminder for dates with no dispatched shipments or fully reviewed days.
- Missed/delayed notifications do not erase exceptions or confirm deliveries.

## Cross-platform delivery

Use standard Web Push, service workers and VAPID, not an iPhone-only integration.
iPhone/iPad requires a supported OS (16.4+) and an installed Home Screen web app.
Android uses a browser supporting Web Push. Feature detection and a user-tapped
Enable Notifications control must precede the native permission prompt. Denial
must leave an in-app review available and must not repeatedly prompt.

Push subscriptions belong to their HTTPS origin. Do not enroll devices on
the temporary Cloud Shell origin or a file URL; moving origins requires enrolling
again. A separate permanent routing app and private Cloud Run job are prepared
locally; neither is deployed. GitHub Pages alone cannot schedule or
send background pushes. The operator-authenticated preview bridge is not a
production notification sender.

## Access, privacy and persistence requirements

- Start with Zach's explicitly authorized preview account only. Multiple device
  subscriptions per user are allowed; additional people require named access.
- Validate trusted role, active warehouse access and preview membership on
  subscription registration and again before sending. Preserve CA/TX isolation.
- Persist endpoint and encryption material in a private, RLS-protected store;
  app users must not list another user's subscriptions or choose arbitrary users.
- Generic lock-screen text only: "ATLAS: Review today's deliveries." No customer,
  address, document number or delivery contents in the notification payload.
- Notification taps navigate only to an allowlisted same-origin review route;
  require current ATLAS sign-in and server authorization before loading any data.
- Sign-out, account changes, opt-out and revoked access must stop future sends;
  discard stale in-flight results. Invalid subscriptions must be retired safely.
- Keep the VAPID private key on the server, outside source control and logs.
- Validate subscription endpoints against supported push providers to prevent
  arbitrary server fetches. Bound payloads, requests, recipients and retry counts.
- Deduplicate by account, warehouse and review day; respect user opt-in and
  5 PM Pacific scheduling with DST. No per-order notification flood.

## Activation prerequisites

Prepare and review the exact private subscription schema/RPCs, sender, scheduled
job, deployment origin and service-worker changes before seeking approval.
New database/Edge Function changes and access grants need explicit approval under
AGENTS.md. Do not reuse routing activation approval as push deployment approval.
Use a maintained Web Push library after package installation is authorized.
Verify actual locked-screen delivery on one iPhone and one Android device, plus
denied permission, account/warehouse switching, expired subscription, duplicate
job execution, offline devices and notification navigation. Unit tests or a
simulated subscription do not establish successful phone delivery.

Sources: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
and https://developer.mozilla.org/en-US/docs/Web/API/Push_API

## Local implementation and remaining connection work

- `atlas-routing-notifications.js`: shared weekday/Pacific policy, order-review
  eligibility, exact provider endpoint validation, generic payload projection,
  capability messages and opt-in/opt-out controller with account-change guards.
- `atlas-routing.js`: Delivery Reminders dialog. It stays explicitly disconnected
  unless a host supplies `window.atlasRoutingReminderController`. It does not request
  browser permission itself or subscribe automatically.
- `notification-dispatcher.mjs`: dependency-injected sender logic, disabled by
  default. Requires one explicit approved recipient UUID (not an array or role).
  Limits enumeration to five devices belonging to that account. Rechecks access
  before sending and reserves each device/day once; an uncertain provider response
  is not retried automatically. This favors avoiding duplicate phone reminders.
- `notification-worker.mjs`: handler adapter only, not registered/imported into
  the existing service worker. It rebuilds same-origin review destinations,
  suppresses stale bindings/messages, and messages an open tab instead of
  navigating away from an unsaved draft. The new binding/client/worker entry modules
  wire these paths on the permanent host, only when explicitly enabled there.

The subscription API SQL is a proposal artifact; it has not been applied. No VAPID
key, Web Push package, scheduled job or production sender is installed by this update.
The existing service-worker change is limited to cache consistency for the new
frontend module; it does not activate push handlers. Synthetic tests do not
replace actual iPhone/Android enrollment and locked-screen tests.

### Backend contract to implement and review before activation

Use separate private subscription and send-attempt tables with RLS and no direct
anon/authenticated table grants. Public invoker RPCs must delegate to narrowly
scoped private functions with empty search paths and explicit grants. No role-wide
enrollment. Resolve Zach's existing approved account ID from trusted membership;
store one explicit recipient setting, never infer it from a display name/email
or from the first authenticated user. The browser must not choose a recipient.

The host adapter needs these operations (not currently deployed):

1. `prepare`: verify current trusted role, live auth session, CA warehouse access,
   approved preview membership AND the single approved recipient; return current
   user ID, CA, a random one-time binding, and the VAPID public key only.
2. `register`: bind a validated browser subscription to that user/session/warehouse
   and device; reject another owner's endpoint, stale binding, or a sixth device.
   Endpoints/keys are private; never log them or include them in client listings.
3. `revoke`/status: affect only the authenticated owner's current device/binding.
   Do not accept an arbitrary account or warehouse. A revoke capability for an old
   binding may be needed for safe cleanup after an account change; it must not
   grant subscription read or send access.
4. `authorizedDevices`: server-only; read current trusted account/warehouse/member
   and session state for the one recipient. Empty/revoked means no sends.
5. `claim`: atomically reserve `(owner, CA, device, review_day)`. Recheck eligibility
   and confirm at least one saved order, across ALL planning days, was dispatched
   on the review date with neither confirmation nor reported exception. Enforce
   Pacific weekday/time boundaries server-side. No sent-out orders means no claim.
6. `stillAuthorized`: repeat current opt-in, binding, role, live session, membership,
   warehouse and recipient checks immediately before a provider call.
7. `finish`/`retire`: server-only bounded status changes; 404/410 retire that exact
   binding. Do not expose provider exception bodies. A claimed attempt never
   becomes eligible for automatic retry after a timeout.

The sender's pinned `web-push@3.6.7` dependency and lockfile were installed on
2026-09-20 with scripts disabled. npm audit reported zero known vulnerabilities;
real encryption/VAPID request construction passed without a network send.
Private VAPID material belongs only in server secret storage.
The source uses direct HTTPS requests and rejects non-2xx responses; verify the
installed version before deployment. Schedule one authenticated Cloud Run JOB
at `0 17 * * 1-5`, timezone `America/Los_Angeles`, with no public send endpoint.
Do not use a Codex reminder automation for ATLAS phone delivery.

The complete activation scope and test gates are in
`cloud-run/atlas-routing-reminders/ACTIVATION.md`. This includes a stable private
routing PWA separate from live ATLAS, server-only secret storage, exact new service
accounts/grants, disabled-first deployment and Zach-only enrollment. The temporary
Cloud Shell origin remains unchanged. If moving to live ATLAS's origin later,
phones must opt in again; the new private PWA does not replace the existing app.

The current Supabase can_access function was inspected read-only on 2026-09-20:
it checks profile role, trusted auth app_metadata, active CA warehouse access,
enabled preview membership and a live auth.sessions record. Preserve all of those
checks; a notification recipient allowlist adds a restriction rather than replacing
any existing one. On 2026-09-20 the approved new private notification schema/RPCs
were applied with sending disabled. Transactional access/enrollment tests passed
after correcting a device-query alias ambiguity; all synthetic changes rolled back.
Existing routing/day tables and Edge Functions remain unchanged by this activation.
See ACTIVATION.md for current gates; this is not yet an active phone reminder service.

# Secure handoff

Secure handoff is a process-local, one-time channel for a human to deliver a
short-lived sensitive value to an agent integration. It is deliberately not a
credential store or a component-installation workflow.

## Lifecycle

1. The trusted local integration calls `handoffStore.create({ ttlMs, label })`.
   TTL is restricted to 1–15 minutes (5 minutes by default). The returned
   management token stays in the caller's memory. Give the human only the
   public `/handoff/<id>` URL.
2. The human opens the mobile-friendly form. The value is accepted only by a
   same-origin, CSRF-token-bearing `POST`. Submission is rate- and size-limited.
3. The integration calls `awaitAndConsume(id, manageToken)` or checks `status`
   and calls `consume`. Exactly one submit and one consume can succeed. Consume
   returns the value once and immediately clears it from the store.
4. Call `revoke` when the value is no longer needed. Expiry is automatic. The
   service runs `cleanup()` each minute; cleanup is safe to repeat and removes
   terminal sessions, making their public paths return 404.

## Security boundary

- Values live only in the Pages process between submission and consumption.
  They are never written to SQLite, Pages state, files, generated HTML, URLs,
  command arguments, environment variables, routine logs, or error messages.
- Restart loses every in-flight handoff and therefore fails closed. Nothing is
  restored from disk, including submitted values or consumed/expired sessions.
- The public ID is a short-lived form capability. The independent management
  token authorizes local status, consume, await, and revoke operations and must
  not be sent to the browser or placed in a URL.
- GET only renders an empty form. Submission is POST-only and requires both a
  same-origin Origin/Referer check and a per-session CSRF token. Responses are
  `no-store` with a `no-referrer` policy.
- The default ceiling is 4 KiB per value and 8 POST attempts per IP/session per
  minute. Global Pages rate limiting remains an additional layer.
- The API accepts only TTL and display-label data. There is no command,
  executable path, script, callback URL, or post-consumption hook parameter.
- Zero retention is the default and only mode. A caller needing durable secret
  custody must move the consumed value directly into a purpose-built secret
  manager; Pages must not be extended into that role.

Treat the returned value as tainted secret material: never interpolate it into
shell commands, logs, Issues, PR descriptions, generated pages, or exception
messages. Pass it directly to the business-specific consumer through a
non-logging in-memory API, then release the reference.

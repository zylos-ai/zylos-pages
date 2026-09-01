# Secure handoff

Secure handoff is a process-local, one-time channel for a human to deliver a
short-lived sensitive value to an agent integration. It is deliberately not a
credential store or a component-installation workflow.

## Lifecycle

1. The trusted local integration sends a JSON create request on stdin to
   `src/cli/secure-handoff.js`. The client crosses into the running Pages
   process over `handoff-control.sock`, a `0600` Unix-domain socket that is not
   reachable through Caddy. TTL is restricted to 1–15 minutes (5 minutes by
   default). The returned management token stays in caller memory. Give the
   human only the returned `submitUrl`.
2. The human opens the mobile-friendly form. The value is accepted only by a
   same-origin, CSRF-token-bearing `POST`. Submission is rate- and size-limited.
3. The integration sends an `await` request (or `status` then `consume`) to the
   same stdin-only client. Exactly one submit and one consume can succeed.
   Consume returns the value once and immediately clears it from the store.
4. Send `revoke` when the value is no longer needed. Expiry is automatic. The
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
- Management requests are JSON received only from client stdin. Never put the
  management token or submitted value in CLI arguments or environment
  variables, and do not allow the client's one-time stdout response to enter a
  routine log. The client emits only fixed error codes on stderr.
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

## Local client protocol

The client accepts exactly one JSON object on stdin. Supported operations are:

- `{"operation":"create","ttlMs":300000,"label":"API token"}`
- `{"operation":"status","id":"…","manageToken":"…"}`
- `{"operation":"await","id":"…","manageToken":"…"}`
- `{"operation":"consume","id":"…","manageToken":"…"}`
- `{"operation":"revoke","id":"…","manageToken":"…"}`

Do not paste those management requests into a shell command: that would put
the token in shell history or arguments. A caller should spawn
`node src/cli/secure-handoff.js` with fixed argv and write the serialized
request directly to the child's stdin, retaining the parsed response only in
memory. The `await` response contains the submitted value and is the intended
one-time delivery channel.

Modern browsers supply `Sec-Fetch-Site`, which Pages requires to be
`same-origin`; this browser-controlled signal survives Host/protocol rewriting
at a stripped proxy. Pages also requires an Origin/Referer and the unguessable
per-session CSRF token. For clients without Fetch Metadata, configure an
absolute `publicBaseUrl` such as `https://agent.example/pages`; Pages uses that
local, operator-controlled origin as the fallback. It deliberately ignores
forwarded host/protocol headers. Relative or absent configuration has a legacy
fallback only for direct same-origin access to the local listener.

# Secure handoff

Secure handoff is a process-local, one-time channel for a human to deliver a
short-lived sensitive value to an agent integration. It is deliberately not a
credential store or a component-installation workflow.

It also supports the reverse, one-time reveal flow: a trusted local integration
deposits a value, or 1–10 files, through the same local socket, and a human
must explicitly click a same-origin POST form before the value is returned (or
the files are downloaded) once in that HTTP response. A preview GET never loads
or consumes the value or file content.

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

`create` may include a `fields` array with 1–4 entries. Each entry has a unique
safe `name`, a display `label` of at most 100 characters, and a `type` of `text`
or `password`. The form requires every configured field and `await` / `consume`
returns their values together as one object. The combined UTF-8 size of all
values remains capped at 4 KiB. Omitting `fields` preserves the original scalar
`value` request and response contract.

`create` may instead set `"accept":"file"` to collect files, such as a
service-account key, a certificate and its key, or a handoff document, rather
than typed text. The form then posts `multipart/form-data` with the CSRF token
and one or more file parts named `file`. The optional `maxFiles` integer sets
how many files one submission may carry: 5 by default, 1–10 allowed (with `1`
the picker selects a single file). The optional `maxBytes` integer caps the
**total** size of all files: 5 MiB by default and at most 5 MiB. `maxBytes` and
`maxFiles` are rejected for text handoffs, and `accept:"file"` cannot be
combined with `fields`. Any other part, a repeated `csrf`, an empty file, more
than `maxFiles` files, or files totalling more than `maxBytes` are rejected and
the handoff stays waiting. `await` / `consume` returns all files once, in the
order submitted:

```json
{"ok":true,"value":{"files":[{"filename":"key.json","contentType":"application/json","size":2345,"data":"<base64>"}]}}
```

`data` is the exact file content in base64. `filename` is only a hint reduced
to a base name without path separators or control characters (`upload` when
none is usable); when two files share a name (case-insensitively), later ones
become `name (2).ext`, `name (3).ext`, … so writing them out never overwrites.
`contentType` is the browser-reported type, or `application/octet-stream` when
it is missing or malformed. The integration chooses the destination paths
itself and should write the decoded bytes there with `0600` permissions. The file is buffered only in the Pages process memory
and follows the same one-time, zero-retention rules as text values. Omitting
`accept` (or sending `"text"`) keeps text handoffs unchanged.

For a reverse reveal, send `create_reveal` with `value`, `ttlMs`, and `label` on
stdin. Give the human only `revealUrl`.

To hand the human files instead of text, send `create_reveal` with `files`
(and no `value`; sending both is rejected): 1–10 entries of
`{"filename":"…","contentType":"…","data":"<base64>"}`, at most 5 MiB decoded
in total. `data` must be standard padded base64; names are reduced and
de-duplicated exactly as for uploads. The preview page lists only file names
and sizes. Its download button POSTs once: a single file is returned as itself,
several files as one uncompressed ZIP named after the label. The response is
always a download (`Content-Disposition: attachment` with a UTF-8 filename,
`application/octet-stream` or `application/zip`, `nosniff`, and a sandbox CSP),
so the browser never renders the content. The files are cleared from the store
before the response is sent and the response buffer is zeroed afterwards; a
second click, an expired link, or a revoked link all get the unavailable page.
If the download was interrupted, the human needs a new link. The integration may wait with
`await_viewed`; its response is a secret-free event containing only the handoff
ID, `viewed` state, and timestamp. The reveal POST clears the value before that
event is delivered, so a disconnected waiter cannot make the value readable
again.

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
- GET only renders an empty form. Submission is POST-only and requires a
  same-origin Origin/Referer check, the Host bound by the preview GET, and a
  per-session CSRF token. Responses are `no-store` with a `no-referrer` policy.
- The default ceiling is 4 KiB per value (5 MiB in total for files, lowerable
  with `maxBytes`, and 5 files, adjustable 1–10 with `maxFiles`) and 8 POST
  attempts per IP/session per minute. A reverse proxy in front of Pages must
  accept request bodies of that size (nginx defaults to 1 MiB:
  `client_max_body_size`). Global
  Pages rate limiting remains an additional layer.
- The API accepts only TTL, display-label, field, and file-limit data. There is
  no command, executable path, script, callback URL, or post-consumption hook
  parameter.
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
- `{"operation":"create","ttlMs":300000,"label":"Service account","fields":[{"name":"email","label":"Email","type":"text"},{"name":"password","label":"Password","type":"password"}]}`
- `{"operation":"create","ttlMs":300000,"label":"Service account key","accept":"file","maxFiles":2,"maxBytes":1048576}`
- `{"operation":"status","id":"…","manageToken":"…"}`
- `{"operation":"await","id":"…","manageToken":"…"}`
- `{"operation":"consume","id":"…","manageToken":"…"}`
- `{"operation":"revoke","id":"…","manageToken":"…"}`
- `{"operation":"create_reveal","value":"…","ttlMs":300000,"label":"API token"}`
- `{"operation":"create_reveal","files":[{"filename":"cert.pem","contentType":"application/x-pem-file","data":"<base64>"}],"ttlMs":300000,"label":"TLS certificate"}`
- `{"operation":"await_viewed","id":"…","manageToken":"…"}`

Do not paste those management requests into a shell command: that would put
the token in shell history or arguments. A caller should spawn
`node src/cli/secure-handoff.js` with fixed argv and write the serialized
request directly to the child's stdin, retaining the parsed response only in
memory. The `await` response contains the submitted value and is the intended
one-time delivery channel.

Modern browsers supply `Sec-Fetch-Site`, which Pages requires to be
`same-origin`; this browser-controlled signal survives Host/protocol rewriting
at a stripped proxy. Pages also requires an Origin/Referer and the unguessable
per-session CSRF token.

**Reverse-proxy deployment requires an absolute `publicBaseUrl`**, such as
`https://agent.example/pages`, set in
`~/zylos/components/pages/config.json`. Pages uses that local,
operator-controlled origin when validating browser handoff requests. Install
and upgrade hooks warn when the key is missing, and an enabled service repeats
the warning at startup. An Agent must ask the owner for the externally
reachable URL when it is unknown; it must not infer the value from forwarded
host/protocol headers. Relative or absent configuration retains only the legacy
fallback for direct same-origin access to the local listener and can make
reverse-proxied handoff POSTs fail closed with `403`.

# Security audit

[Português do Brasil](SECURITY-AUDIT.md) · [English (US)](SECURITY-AUDIT.en-US.md)

## Scope

The review covered the full creation, join, message, Markdown, presence, upload, temporary storage, download, reconnection, closure, and restart flows. Server and browser code, tests, dependencies, and Azure Web App requirements were inspected. A second independent review ran before the fixes.

## Results

| ID | Initial severity | Finding | Treatment | Status |
|---|---:|---|---|---|
| F-01 | High | The short code allowed unlimited enumeration and errors revealed existing rooms. | One attempt per WebSocket, indistinguishable responses, and per-address/global limits. | Mitigated; the short code remains unsuitable for highly sensitive content. |
| F-02 | High | Rooms, disk, connections, and events had no global budget. | Global and per-room caps for rooms, bytes, uploads, transfers, WebSockets, and events. | Fixed. |
| F-03 | Conditionally high | HTTPS and TLS depended only on future Azure configuration. | HSTS plus required documentation for HTTPS Only, TLS 1.2+, and `PUBLIC_ORIGIN`. | Pending post-deployment verification. |
| F-04 | Medium | A disconnected guest could use `resume` above the room limit. | Capacity is checked again on resume, with a retained-session limit. | Fixed. |
| F-05 | Medium | WebSockets accepted any `Origin`, and anonymous sockets stayed open. | Exact origin required, with a ten-second authentication timeout. | Fixed. |
| F-06 | Medium | An upload or download could continue after room closure. | Streams are tracked and aborted when the owner disconnects or the room is destroyed. | Fixed. |
| F-07 | Medium | The room code appeared in HTTP routes and could reach access logs. | Fixed endpoints; code and ID travel in authorized headers. | Fixed in the app; platform log retention still needs configuration. |
| F-08 | Low | CSP allowed a connection to any `ws:` or `wss:` destination. | `connect-src` is limited to the exact WebSocket for the public origin, with additional policies. | Fixed. |
| F-09 | High | Temporary files were stored in plaintext, and `rm` cannot guarantee physical overwrite. | Per-file AES-256-GCM, memory-only keys, `0700/0600` permissions, retrying cleanup, and startup cleanup. | Fixed for disk-remnant confidentiality. |

## Confirmed controls

- Participant tokens use 192 random bits and do not appear in URLs.
- File operations require a connected participant token.
- Only the owner can close a room.
- Markdown HTML and images are disabled; unsafe active protocols are rejected.
- Untrusted names and metadata enter the DOM as text.
- A file name never determines a physical path.
- Downloads use `attachment`, binary type, `nosniff`, and `no-store`.
- File keys are cleared and room references removed at closure.
- Transfers are blocked as soon as the room enters `owner-away`.
- Restart clears the temporary root before accepting traffic.
- The app contains no static secrets and does not log payloads or functional identifiers.
- Dependency integrity is locked in `package-lock.json`.

## Executable evidence

The local gate covers:

- state machine and owner resume;
- participant, room, byte, and concurrent-upload limits;
- unsafe Markdown (`script`, `javascript:`, `data:`, `vbscript:`, and remote images);
- WebSocket requests from the wrong origin;
- unauthenticated socket timeout;
- indistinguishable response for a missing room;
- an 8,000-character message over the real transport;
- a disk file that differs from plaintext, with restricted permissions;
- decrypted download only with an active session;
- transfer interruption and directory removal;
- unavailability after closure;
- CSP and primary security headers.

Gate commands:

```bash
npm test
npm audit --omit=dev
```

## Residual risks

Accepted risks and operating conditions are detailed in [`SECURITY.en-US.md`](SECURITY.en-US.md). The main ones are:

1. the short code remains a low-entropy shared secret;
2. encryption is not end to end, so the server sees content during the session;
3. authorized participants can keep external copies;
4. there is no antivirus, strong identity, or phishing protection;
5. in-memory rate limiting cannot stop a distributed attack;
6. managed-memory strings cannot be guaranteed to be overwritten;
7. Azure logs and settings must be checked in the real environment.

## Decision

**Local code: ready after fixes and the automated gate.**

**Public operation: ready only after the Azure checklist in `SECURITY.en-US.md` is validated.** Add edge WAF/distributed rate limiting for untrusted traffic at scale. Replace the short-code model with strong identity or a high-entropy invitation and end-to-end encryption for high-impact or regulated data.

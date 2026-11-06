# Security and data lifecycle

[Português do Brasil](SECURITY.md) · [English (US)](SECURITY.en-US.md)

QSND is built for casual, temporary sharing. This document defines what the app guarantees, what depends on deployment, and what it does not promise.

## Access model

- The five-letter code allows someone to request entry to a room.
- After entry, the server issues a random 192-bit token for that participant.
- Messages, presence, uploads, and downloads require an active, authenticated connection.
- The token stays only in server memory and that tab's `sessionStorage`. It does not appear in URLs.
- Language and theme may stay in `localStorage`; these preferences contain no room code, token, or content.
- The server does not list rooms and returns the same response for a missing room, paused room, or invalid token.
- Connection, creation, join, resume, event, and transfer attempts are rate-limited by source address.
- WebSockets accept only the configured public origin and close connections that do not authenticate within ten seconds.

The short code is still a low-entropy secret. The limits make casual scanning impractical during a room's 30-minute lifetime, but they do not replace a password or corporate identity against a distributed attacker.

## Data during a session

### Messages

- Messages stay only in process memory.
- The server keeps the original Markdown and generates HTML with `markdown-it`.
- User-provided HTML and images are disabled.
- Dangerous links are rejected; valid links receive `noopener noreferrer`.
- Names, titles, and file names enter the interface through `textContent`, not HTML.

### Files

- Uploads stream without loading a complete file into memory.
- Each file gets its own random key and is stored with AES-256-GCM.
- The key, initialization vector, and authentication tag exist only in room memory.
- Temporary disk contains ciphertext only. A residual file after failure is unusable without the lost key.
- Directories use `0700`; files use `0600`.
- Downloads require the connected token and use `application/octet-stream`, `attachment`, and `nosniff`.
- The original name is never used as a physical path.

Encryption happens on the server, not end to end. The server and every authorized participant can see plaintext during use.

## Room closure

A room closes when the owner requests it, the owner is absent for five minutes, no action occurs for 30 minutes, or the process stops. As soon as the owner disconnects, the server blocks new messages and transfers and aborts active transfers. A valid reconnection reopens the room during the five-minute grace period.

When closing a room, the server does the following in order:

1. clears file keys, IVs, and tags from application memory;
2. removes the room from the authorization map, invalidating codes and tokens in the same process turn;
3. aborts active uploads and downloads;
4. notifies clients and closes WebSockets;
5. removes the room directory, retrying after failure.

At startup, the process deletes and recreates the entire temporary root before accepting traffic. During a normal shutdown, it waits for aborted transfers and pending removals.

Access invalidation is immediate. Physical removal by the operating system is asynchronous and does not overwrite SSD blocks. Per-file encryption means disk remnants cannot be decrypted after the in-memory key is destroyed.

Message strings are removed from application structures, but JavaScript cannot securely erase managed memory. Physical memory collection is left to the runtime and operating system.

## Abuse limits

- 50 concurrent rooms.
- 10 connected participants and 20 retained sessions per room.
- 500 timeline items per room.
- 8,000 characters per message.
- 20 files, 100 MB, and three concurrent uploads per room.
- 400 MB total files per process.
- 200 WebSockets and 100 simultaneous HTTP transfers per process.
- Five room creations and 12 join attempts per minute per address.
- 120 events or file requests per minute per session/address.

These controls protect a small instance from simple abuse. A distributed attack requires edge protection such as Azure Front Door/WAF and distributed rate limiting.

## Logs and cache

The app does not log codes, tokens, names, messages, file names, or content. File endpoints use fixed URLs; codes and IDs travel in headers that the app does not log.

All functional responses use `Cache-Control: no-store`. The page also sends a restrictive CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, a referrer policy, and `Permissions-Policy`.

Azure, a proxy, a WAF, or observability tools may still produce operational metadata such as IP address, time, fixed route, status, and transferred volume. Do not enable body or authorization-header capture. Keep infrastructure log retention short and access restricted.

## Required Azure Container Apps configuration

- At most one replica (`--max-replicas 1`). Scale to zero is accepted: the replica stops only with no requests and no open WebSockets.
- External ingress with insecure HTTP disabled. The environment accepts only TLS 1.2 or newer.
- `PUBLIC_ORIGIN=https://<exact-public-host>` configured.
- `TRUST_PROXY=1`, already set in the `Dockerfile`, to use the client IP and protocol forwarded by ingress.
- No persistent volume for the temporary directory.
- Public image at `ghcr.io/andremorata/qsnd`, with no registry credential in the app.
- Console logs without bodies, headers, and personal data.
- Optional Application Insights telemetry (`src/telemetry.js`): sends a known route or `/{other}`, status, duration, room events with counts and bytes, and the IP for geolocation. Ingestion stores the IP masked as `0.0.0.0`. It never sends room codes, tokens, names, file names, query strings, or content.

A restart, new revision, scale to zero, or replica change ends every room. This is a security behavior, not disaster recovery.

Platform references:

- [Ingress in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/ingress-overview)
- [Storage in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/storage-mounts)
- [Scaling in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/scale-app)

## Residual risks

- Anyone who knows the code can join and copy everything while the room is active.
- An authorized participant can save, photograph, or forward content; closing the room cannot erase external copies.
- There is no end-to-end encryption, room password, identity authentication, antivirus, or phishing prevention.
- A compromised process can read messages, tokens, and keys while a room is active.
- In-memory rate limiting resets with the process and cannot stop a distributed attack.
- Silent network loss may take about 30 seconds to be detected by heartbeats; the five-minute grace period starts after detection.
- Downloaded files remain subject to the recipient device's storage and security policies.

Do not use this MVP for high-impact secrets, regulated data, or content whose disclosure would cause material harm. That use needs strong identity, high-entropy invitations, end-to-end encryption, edge protection, and a formal retention policy.

## Pre-publication check

```bash
npm test
npm audit --omit=dev
```

After deployment, manually confirm:

1. HTTP redirects to HTTPS and old TLS is rejected.
2. A different origin cannot open `/ws`.
3. Upload and download work only for a connected participant.
4. Closing the room interrupts transfers and makes old URLs unavailable.
5. The temporary directory contains no plaintext and disappears after closure.
6. Azure logs contain no payloads, codes, tokens, or file names.

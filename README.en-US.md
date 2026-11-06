# QSND

[Português do Brasil](README.md) · [English (US)](README.en-US.md)

A temporary interface for sharing text and files inside a room. Nothing survives after the room closes.

[Live app](https://qsnd.pmr.dev)

## MVP goal

One person creates a room, enters a name, and receives a short code. Other people join with that code and their names. While the room exists, everyone can see its participants, messages, and available files.

The product has no accounts, database, history, search, moderation, or permanent storage.

## Initial decisions

- Primary hosting: **Azure Container Apps**, consumption plan, at most one replica, scale to zero.
- Entry: **room code + name**.
- Code: five uppercase letters, excluding visually ambiguous characters.
- Room name: optional; the server always generates the code.
- Files: up to **100 MB total per room** and up to 20 files.
- Owner disconnected: the room waits **5 minutes** for reconnection.
- Inactivity: the room expires after **30 minutes without an action**.
- No persistence: messages and presence stay in memory; files are encrypted and stored only in the process temporary directory.

## Experience

### Create a room

1. Enter a display name and, optionally, a room name.
2. Create the room.
3. Receive its code and a button to copy it.
4. Join as the owner with a temporary emoji avatar.

### Join a room

1. Enter the code and a display name.
2. Receive a temporary emoji avatar.
3. See the room's current content and connected participants.

The code is the access secret. Rooms are neither discoverable nor publicly listed.

### Inside the room

- One chronological feed containing Markdown text blocks and file cards.
- A limited Markdown set: paragraphs, emphasis, bold, links, lists, blockquotes, and inline or fenced code.
- Each text block offers `Copy formatted` and `Copy Markdown`. Formatted copy includes HTML and a plain-text version for apps without rich clipboard support.
- Multiple files can be selected at once; each file is downloaded separately.
- A participant list with avatar, name, and `viewing` or `in the background` state.
- Room code, room name, remaining time, and copy action in the header.
- An owner-only action to close the room immediately.
- A visible warning during the final five minutes before idle expiration.
- A countdown for everyone while the owner is disconnected.
- Brazilian Portuguese and American English, initially selected from the browser language and switchable from the header.
- Light and dark themes, initially selected from the system preference and switchable from the header.
- Header and composer always visible; only the chat feed scrolls vertically.

### Visual direction

A compact "handoff desk": high-contrast surfaces, editorial type, light and dark themes, and a strong signal color for actions and state. It should not look like an admin dashboard.

On desktop, the feed takes the center and presence sits in a narrow column. On mobile, presence becomes a horizontal strip and the composer stays available at the bottom. The document does not scroll; scrolling stays inside the feed. Motion communicates entry, upload, and expiration without decorative excess.

## Lifecycle

A room has three states:

- `active`: accepts participants, text, uploads, and downloads.
- `owner-away`: blocks messages and transfers, aborts active transfers, and waits up to 5 minutes for the owner.
- `destroyed`: rejects all access and removes all content.

The room is destroyed when the first of these happens:

1. the owner closes it;
2. the owner does not reconnect within 5 minutes;
3. nobody performs an action for 30 minutes;
4. the process restarts or stops.

Joining, sending text, completing an upload, and starting a download renew the inactivity deadline. Connection heartbeats and an idle open tab do not.

The browser keeps the owner's resume token only in `sessionStorage`. Refreshing the page can therefore resume the room without creating an account or permanent session. Language and theme stay in `localStorage`; those preferences contain no room data.

When destroying a room, the server:

1. notifies connected clients;
2. invalidates temporary tokens;
3. removes in-memory state;
4. recursively deletes the room's file directory.

At startup, the server also clears the QSND temporary root to remove leftovers from an abrupt stop.

## Minimal architecture

```text
Browser
  ├─ HTTP: page, create/join, upload, and download
  └─ WebSocket: messages, presence, progress, and closure
                      │
                      ▼
   Azure Container Apps — 1 Node.js process
           ├─ In-memory Map: rooms and participants
           └─ temporary directory: files
```

### Implementation

- Node.js with one HTTP server.
- Browser HTML, CSS, and JavaScript, with no framework or build step.
- A local dictionary in `public/i18n.js` for Brazilian Portuguese and American English.
- Two runtime dependencies: `ws` for server WebSockets and `markdown-it` for safe, consistent server-side Markdown rendering.
- Standard-library `crypto`, `fs`, `http`, `path`, and `node:test`.
- Uploads stream directly to temporary disk instead of loading the whole file into memory.
- Each file is stored with AES-256-GCM and a random key held only in room memory.
- Files use random internal IDs; the original name is display metadata only.
- At most one Azure Container Apps replica. Horizontal scale is outside the MVP because state is local to the process.

Vercel is not the first target. Ephemeral functions would require separate real-time and file services, which conflicts with the small, non-persistent design.

## Data held during a room

```text
Room
- code
- optional label
- owner resume token
- status
- createdAt / lastActivityAt / ownerDisconnectedAt
- participants
- timeline entries
- totalFileBytes

Participant
- temporary token
- display name
- emoji
- role: owner | guest
- visibility: viewing | background

Timeline entry
- text: id, author, markdown, createdAt
- file: id, author, original name, byte size, createdAt
```

The application does not write payloads, participant names, codes, or file names to its logs.

## Limits and safeguards

- 50 concurrent rooms per process.
- 10 connected participants and 20 retained temporary sessions per room.
- Display name: 1–24 characters.
- Text: up to 8,000 characters per send; blocks taller than 280 px stay collapsed until expanded.
- Individual file: up to 100 MB.
- Room: up to 20 files, three concurrent uploads, and 100 MB total.
- Server: up to 400 MB total temporary files.
- The server keeps only the original Markdown during the room lifetime.
- User HTML is disabled; only HTML produced by the Markdown renderer reaches the page.
- Links use safe protocols and open without access to the originating page.
- `Copy formatted` uses the Clipboard API with `text/html` and `text/plain`; without support, it copies rendered plain text.
- `Copy Markdown` copies the exact original source as plain text.
- Downloads always use `Content-Disposition: attachment`.
- A file name is never used as a server path.
- Upload and download require a currently connected participant token.
- Active transfers are aborted when the room closes.
- Codes and IDs do not appear in file URLs.
- Join attempts, connections, and events have in-memory rate limits.
- Responses do not distinguish a missing room, paused room, or invalid token.

The short code is suitable for casual, temporary sharing, not highly sensitive material. Passwords, corporate authentication, and an audit trail are outside the MVP. See [`SECURITY.en-US.md`](SECURITY.en-US.md) for guarantees, deployment requirements, and residual risks.

## Run locally

Requires Node.js 22 or newer.

```bash
npm install
npm start
```

The app runs at `http://localhost:3000`; `GET /health` checks availability. Use `npm run dev` for automatic restart during development.

On Azure Container Apps:

- publish the `Dockerfile` image (Node.js 24, port 8080, `TRUST_PROXY=1`), for example with `az acr build -r <registry> -t qsnd:<tag> --platform linux/amd64 .`;
- use external ingress on port 8080 with insecure HTTP disabled;
- set `PUBLIC_ORIGIN=https://<exact-public-host>`;
- use `--min-replicas 0 --max-replicas 1`; the first visit after an idle period has a cold start of a few seconds;
- use 0.5 vCPU and 1 GiB, which give 2 GiB of temporary disk;
- to measure usage, store the Application Insights connection string in a secret and expose it as `APPLICATIONINSIGHTS_CONNECTION_STRING`; without it, nothing is sent;
- do not enable persistent storage for temporary files;
- do not capture request bodies or sensitive headers in logs or telemetry.

Restarts and instance changes end every room by design.

## Delivery plan

### 1. Room and real time

- Create and join a room.
- Generate codes and avatars.
- Show presence and tab state.
- Send Markdown, render the defined subset, and synchronize the feed.
- Copy each block as formatted content or Markdown source.
- Implement close, owner reconnection, and expiration.
- Cover the state machine and unsafe Markdown cases with `node:test`.

### 2. Files

- Stream uploads with the defined limits.
- Publish metadata in the feed.
- Authorize and stream downloads.
- Delete files through every close path.
- Test aggregate limits, hostile names, and access after expiration.

### 3. Interface and deployment

- Apply the responsive layout and error/progress states.
- Validate keyboard, focus, contrast, and screen readers.
- Deploy one Azure Container Apps replica.
- Test with two browsers and confirm cleanup after each close path.

## MVP acceptance criteria

- Two people in separate browsers exchange rendered Markdown text in real time.
- Each block can be copied as formatted content or original Markdown source.
- Unsafe HTML and links sent by a participant do not execute.
- Both people see correct entry, exit, name, emoji, and viewing state.
- A file selection appears for everyone and remains downloadable while the room is active.
- A new participant receives the room's still-active content.
- The owner can refresh and resume the room within 5 minutes.
- Owner action, owner absence, inactivity, or restart deletes the room.
- After deletion, old codes, tokens, and URLs cannot access messages or files.
- No functional room data is persisted or included in application logs.
- Initial language follows the browser, initial theme follows the system, and both can be changed in the header.
- Header and composer remain visible without document scrolling on desktop and mobile.

## Outside the MVP

Accounts, history, a database, Blob storage, end-to-end encryption, thumbnails, antivirus, a "download all" ZIP, message editing, notifications, horizontal scale, and Vercel-specific support.

## License

[MIT](LICENSE).

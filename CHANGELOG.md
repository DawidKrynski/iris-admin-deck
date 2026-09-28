# Changelog

## 1.0.4 — 2026-09-28

- README: links to the video (https://youtu.be/gUsxZi-uAD4) and to the Developer Community article.

## 1.0.3 — 2026-09-28

- README: no in-page links. Open Exchange renders headings without anchors, so links such as "A morning on
  call" went nowhere there.

## 1.0.2 — 2026-09-28

- The extension API decodes request bodies as UTF-8. The change log stored text with typographic quotes
  (for example a started task's name) as garbled characters.
- The prebuilt image is published for amd64 only: IRIS starts inside the build, and two platforms built side
  by side both claimed the same port.

## 1.0.1 — 2026-09-28

New screens:
- Journal: browse the records of a journal file, see what one change did, and find which records touched
  a global ("who changed ^X") across the newest files. The API's own bookkeeping is hidden by default.
- Audit maintenance: IRISAUDIT size and date range, copy records to a namespace, purge records older than
  N days (never the newest ones, and you type the number of records first).
- Language servers: state, start and stop, settings, create and delete.
- Backups: definitions, tasks and history. The dashboard says when no backup has run.
- Interoperability: productions per namespace, items with errors, queues, recent errors; start, stop,
  update and recover through `Ens.Director`, checked against `%Ens_ProductionRun` on the server.
- REST APIs on this instance, in the API explorer: every web application with a dispatch class, its routes
  from the OpenAPI spec or the UrlMap, a Try it form and Copy curl.
- Status checks: eleven checks, each with the object and number it is based on, one sentence of advice and
  a fix, or why it was not checked.

Changes:
- Changes made here (Audit trail): every change made through Admin Deck with who made it, the calls and the
  read-back outcome; CSV and JSON export. Request bodies are never stored.
- Before a role is deleted, loses a permission or is taken from a user, the confirmation lists who loses
  what. A change that would leave no enabled `%All` holder is refused, and checked again right before it
  is sent.
- A read-back that fails, or covers only some fields, is reported as such instead of "accepted".
- Background operations (202) are listed in the top bar while they run and after they finish.
- An open tab stays signed in; the session ends after 8 hours without activity.

Details and fixes:
- IRIS details in plain words: version, platform, mirror, license units, system processes; Max size, Free
  and Journal columns for databases.
- Accessibility: landmarks and a skip link, labelled fields, dialogs that keep focus and close on Escape,
  toasts announced to screen readers, keyboard navigation for tabs, table rows and the command palette,
  text contrast of at least 4.5:1 in both themes.
- The metrics sampler keeps its buffer in IRISTEMP (not journaled) and starts with the container.

Running it:
- A prebuilt image on ghcr.io for each release tag (amd64):
  `docker run -d -p 127.0.0.1:52785:52773 ghcr.io/dawidkrynski/iris-admin-deck`.
- `ADMINDECK_PORT` picks the local port for Docker Compose.
- The demo data contains a small incident to follow (README, "A morning on call"): database REPORTS
  dismounted after every start and an export task failing on it.

Tests: ObjectScript tests for the extension API's status codes, end-to-end tests with the page's
Content-Security-Policy enforced and a keyboard pass, and integration tests for the new endpoints.

## 1.0.0 — 2026-09-27

First release for the InterSystems Programming Contest "Build Your Own Management Portal".

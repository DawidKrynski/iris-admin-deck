# IRIS Admin Deck

[![CI](https://github.com/DawidKrynski/iris-admin-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/DawidKrynski/iris-admin-deck/actions/workflows/ci.yml)

A modern, task-oriented management portal for **InterSystems IRIS 2026.2+**, built on the new
**SysAdmin REST API** (`/api/admin/v2`). Everything you click is a documented API call — and the UI
shows you that call, ready to copy as `curl`.

**Online demo (read-only):** <https://niutics.pl/interSystems> — sign in as `demo` / `demo`. Every screen can be
browsed; changes are blocked in the public demo, so run it locally (below) to try the actions.

![A change verified by reading it back, and a stale edit refused](docs/img/verified-change.gif)

## 90 seconds for judges

1. Open the [online demo](https://niutics.pl/interSystems) (login pre-filled: `demo` / `demo`) or run it locally (below).
2. **Ctrl+K** — jump to any screen, user, role, web app or task by name.
3. **Logs & insights → Timeline** — seven sources in one view: `messages.log`, `alerts.log`, System Monitor,
   journal log, **application errors**, security audit and Task Manager runs, each with its own status.
4. **Similar incidents** — paste an error; IRIS Vector Search (HNSW) finds past entries describing the same problem.
5. **Roles & permissions → Access matrix** — which role or public permission grants each resource to a user.
6. **{ } API console** — every call the page made, copyable as `curl`.
7. Locally, edit a web app, user, role or task: the edit is refused if someone changed those fields since you
   opened the form, and read back afterwards (*verified* / *not reflected*). Deleting asks you to type the name.

## Why another portal?

The classic Management Portal grew screen by screen over decades. Admin Deck groups the same power
around the jobs people actually do:

| Persona | Screens |
| --- | --- |
| **Build & integrate** (developers) | Web apps & REST APIs, API explorer for all 190 SysAdmin endpoints |
| **Secure** (security admins) | Users, roles & resources with an access matrix, wallet secrets, X.509 credentials with expiry warnings, SSL/TLS configs, OAuth2 |
| **Operate** (operators / SRE) | Tasks (run, suspend, history, schedule), processes & locks, databases, namespaces, journals, devices, license |
| **Observe** | Live dashboard, status page with latency history, cross-subsystem timeline, log viewer (including rotated logs), recurring problems, similar-incident search, audit trail |

## Features

- **Live dashboard** — health checks, global references/s and CPU charts (hover for the exact sample),
  CPU/memory/disk and license units, upcoming tasks and a "needs attention" list: errors first, then expiring
  certificates and dismounted databases, then recurring warnings from the log. The charts are filled on
  arrival: a small server-side sampler (`AdminDeck.Metrics`) keeps the last hour in 5-second samples.
- **Status** — one row per component (IRIS state, web gateway latency, database read latency, SQL runtime,
  CPU) with a bar per minute for the last hour, charts of web requests, latency and SQL rate, and warnings/errors
  per hour for the last day. Values come from the metrics IRIS publishes for monitoring (`/api/monitor/metrics`);
  the sampler reads them in-process through `SYS.Monitor.SAM.Sensors.PrometheusMetrics()`, the call behind that
  endpoint, so it does not depend on the web server port.
- **Web apps & REST** — list, create (REST / static presets), edit, enable/disable, delete; built-in
  system applications are protected from deletion.
- **Permissions** — users, roles, resources, services (`%Service_*` enable/disable), an *access matrix*
  showing which role — or public permission — grants each resource permission to a user, and SQL privileges:
  grant and revoke object, column and admin privileges, with each role's SQL rights in its details.
- **Secrets & certificates** — wallet collections and secrets (values are write-only), X.509 credentials
  with expiry badges, SSL/TLS configurations with a *Test* action, OAuth2: create server definitions
  (with optional discovery) and client configurations, edit clients, resource servers, and this instance's
  authorization-server status.
- **Tasks** — run now, suspend/resume, edit, history with failure highlighting, upcoming schedule,
  Task Manager suspend/resume, and a jump from a task to its related log entries.
- **Operating system** — processes (suspend/resume/terminate with guard rails, broadcast), locks,
  web sessions, databases (create, edit, delete, mount/dismount, expand/compact/truncate, integrity check,
  with "used by" namespaces), namespaces with global/routine/package mappings, journals, devices and device
  I/O settings (editable), license usage, CPU/memory/disks.
- **Act from the incident** — where a problem is shown, its next step is right there: a dismounted database
  gets *Mount*, a failed task run *Run again*, an expiring certificate opens its credential, an application
  error opens similar incidents, a burst of failed logins opens the user.
- **Timeline** — one chronological view across seven subsystems: `messages.log`, `alerts.log`, System Monitor,
  journal log, application errors (`^%ETN`, all namespaces), security audit and Task Manager runs, with
  subsystem toggles, severity and text filters, and a live / no permission / unavailable status per source.
- **Logs & insights** — `messages.log`, `alerts.log`, `SystemMonitor.log`, `journal.log` and
  **rotated `messages.old_*` files**; severity/source/text filters; *recurring problems* (messages
  normalised and grouped, ranked by severity and frequency); **similar-incident search** powered by
  IRIS Vector Search.
- **Audit trail** — enable/disable auditing, search audit records, toggle audit events.
- **Verified changes** — a `200 OK` only says the request was accepted. Edits in the screens' forms are
  re-read before writing (refused if the fields you are changing were modified by someone else since
  you opened the form); edits, toggles, creates and deletes are read back afterwards and reported as
  *verified* or *not reflected*. Values the API never returns (passwords, secrets) and background
  operations are reported as accepted, not verified; the API explorer sends raw calls. Deleting a named
  object asks you to type its name; terminating a process re-checks that the PID still belongs to the
  same job.
- **Command palette** — <kbd>Ctrl</kbd>+<kbd>K</kbd> finds screens, users, roles, web applications and tasks.
- **API transparency** — every mutating action shows the exact method, path and body before it runs;
  the **API console** lists every call the page made, each one copyable as `curl`. Great for learning
  the SysAdmin API and scripting what you just did in the UI.
- **Safe by design** — JWT sign-in (no password stored in the browser), single-flight token refresh,
  confirmation for destructive actions, no self-lockout (the portal's own web apps, the web gateway service
  and the signed-in account cannot be disabled or deleted from the UI), privilege-aware navigation (screens hidden when the user lacks
  `%Admin_*` privileges), server text rendered as text only (no HTML injection), log access restricted
  to an allow-list of files in the manager directory.
- Light and dark theme, works on narrow screens, no build step and no third-party runtime dependencies.

## What Admin Deck deliberately does not do

- **No back door.** Every management action goes through the official `/api/admin/v2` over HTTP; the
  extension only adds what the API does not expose (log files, application errors, OS metrics, similarity search).
- **No LLM.** Similar-incident search runs entirely inside IRIS — logs are never sent anywhere.
- **No fleet management.** One instance, done thoroughly.
- **No framework or bundler.** Vanilla ES modules, no runtime dependencies, installed as plain files by IPM.
- **No locking.** The SysAdmin API has no object versions, so a verified change re-reads the object just before
  writing and refuses if it moved — a change made in the few milliseconds between that read and the write is not caught.
- **No production hardening in the container.** The Docker image is a local development instance with the well-known
  `SuperUser`/`SYS` login bound to localhost; the public demo is a separately hardened, read-only deployment.

## How it works

```
browser ── same origin ──► IRIS web server
                             ├── /admindeck/       static single-page app (vanilla ES modules)
                             ├── /api/admin/v2/*   built-in SysAdmin API (all management actions)
                             └── /admindeck/api/*  extension REST API (JWT)
                                   ├── logs     Embedded Python log parser (current + rotated files)
                                   ├── apperrors application errors of all namespaces (SYS.ApplicationError)
                                   ├── os       Embedded Python CPU / memory / disk metrics
                                   └── search   IRIS Vector Search over log entries
```

- `/api/admin` intentionally rejects cross-origin requests, so the UI is served by IRIS itself.
- The extension adds what the SysAdmin API does not expose: structured log files, OS metrics and
  similarity search. Its endpoints require `%Admin_Operate:USE`, mirroring the SysAdmin API.
- **Embedded Python** (`python/admindeck`) parses log files, groups messages into patterns, reads
  `/proc` and `statvfs`, and computes 256-dimension text embeddings (deterministic feature hashing —
  no model download, works offline on Community Edition).
- **Vector Search** — embeddings are stored in a `%Vector(DATATYPE="DOUBLE", LEN=256)` column
  (`AdminDeck.Data.LogLine`) with an **HNSW index** (`%SQL.Index.HNSW`, cosine) and queried with
  `ORDER BY VECTOR_COSINE(...) DESC`.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Installation

### Docker (recommended)

Requires Docker with Compose.

```bash
git clone https://github.com/DawidKrynski/iris-admin-deck.git
cd iris-admin-deck
docker compose up -d --build
```

Open <http://localhost:52785/admindeck/index.html> and sign in with `SuperUser` / `SYS`
(demo container only — change passwords for anything else).

The Docker build seeds demo data **through the SysAdmin API itself** ([scripts/demo_seed.py](scripts/demo_seed.py)):
two X.509 credentials (one expiring in 12 days, to show expiry warnings), a wallet collection with dummy
secrets, a rotated `messages.old_*` log and a limited user `demo_operator` / `operator` (role `%Operator`)
to see privilege-aware navigation. Build with `--build-arg DEMO=0` to skip it.

Check the instance with the smoke test:

```bash
scripts/smoke.sh http://localhost:52785
```

### IPM (existing IRIS 2026.2+ instance)

From a clone of this repository:

```objectscript
USER> zpm "load /path/to/iris-admin-deck"
```

or, once published to the Open Exchange package registry:

```objectscript
USER> zpm "install iris-admin-deck"
```

Then open `http://<host>:<port>/admindeck/index.html`. The package creates two web applications:
`/admindeck` (static UI) and `/admindeck/api` (extension REST API, JWT enabled).

### Requirements

- InterSystems IRIS or IRIS for Health **Community Edition 2026.2 or newer**. The SysAdmin API v2 does
  not exist in older versions — `intersystemsdc/iris-community:latest` is still 2026.1, which is why the
  Docker build uses `intersystemsdc/iris-community:2026.2-zpm`. Tested on both
  `intersystemsdc/iris-community:2026.2-zpm` and `intersystemsdc/irishealth-community:2026.2-zpm`
  (`docker compose build --build-arg IMAGE=intersystemsdc/irishealth-community:2026.2-zpm`), amd64;
  both images are also published for arm64.
- Embedded Python (included in the images). OS metrics read `/proc`, i.e. Linux / containers.
- Public deployments: `set ^AdminDeck("Settings","HideHostDetails")=1` (in the package namespace) hides the
  kernel version, host name and uptime from the OS metrics.
- A user holding the `%Admin_*` resources for the screens they need (e.g. `%All`).

## Screenshots

| | |
| --- | --- |
| ![Timeline](docs/img/timeline.png) Timeline: seven sources with per-source status | ![Command palette](docs/img/palette.png) Ctrl+K command palette |
| ![Verified change](docs/img/verified-change.png) A change verified by reading it back | ![Status](docs/img/status.png) Status: component health and latency over the last hour |
| ![Similar incidents](docs/img/logs-similar.png) Similar-incident search (IRIS Vector Search) | ![Recurring problems](docs/img/logs-insights.png) Recurring problems in `messages.log` |
| ![Tasks](docs/img/tasks.png) Tasks | ![API console](docs/img/api-console.png) API console — every call, copyable as curl |
| ![Access matrix](docs/img/access-matrix.png) Access matrix | ![X.509](docs/img/secrets-x509.png) X.509 credentials with expiry |
| ![Web apps](docs/img/webapps.png) Web apps & REST | ![API explorer](docs/img/explorer.png) API explorer |

## Usage tips

- Open **{ } API console** in the top bar to see every call the UI makes; copy any of them as `curl`.
- In **Logs & insights → Log viewer**, hover an entry and choose *Find similar incidents*.
- `messages.log` is indexed on installation; index other or rotated files with *Similar incidents →
  Build / refresh index*.
- **Tasks → a task → Show in timeline** opens the cross-subsystem timeline filtered by the task name.
- The package installs a Task Manager task, **Admin Deck: reindex logs** (daily 03:15), that keeps the
  similarity index fresh.

## Development

```bash
# UI served live from ./web (edit and reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Unit tests: JavaScript (verified changes, palette ranking) and Python (log parsing, embeddings)
node --test tests/js
cd python && python -m pytest -q tests && cd ..

# Integration tests: the SysAdmin endpoints the UI reads, the main write flows (web app, user/role/resource,
# wallet, task, TLS) on throw-away objects, background tasks, extension API, security
python3 -m unittest discover -s tests/integration -v

# End-to-end UI tests (headless Chromium)
uvx --with playwright python tests/e2e/test_ui.py

# ObjectScript unit tests (6 test methods, 25 assertions)
docker compose exec iris iris session IRIS -U USER '##class(%ZPM.PackageManager).Shell("iris-admin-deck test -only -v",1,1)'

# Look up any SysAdmin API endpoint in the OpenAPI spec
python3 scripts/endpoint.py /v2/task/run --schemas
```

Project layout:

```
src/AdminDeck/        ObjectScript: REST dispatch, installer, log/OS/vector classes
python/admindeck/     Embedded Python helpers (log parsing, OS metrics, embeddings)
web/                  Single-page app (index.html, js/, css/, openapi.json)
tests/                %UnitTest classes
module.xml            IPM package definition
```

## Notes on the SysAdmin API (2026.2)

Findings from building on the API, shared as feedback for its road to GA:

- **Long-running operations** (`database-dir/info`, `integrity-check`, `security/audit/records`, …) answer
  `202 Accepted` with an empty body; the task id is only in the `Location` header — which points to
  `/api/admin/v1/async-result?id=…` although the API is v2. Admin Deck reads the id from the header and polls
  `GET /v2/async-result`.
- **Creating a web application** with `PUT /v2/web-app`: `ServeFiles` / `UseCookies` are validated against the
  numeric codes (`0–3`) on create, while the spec and `GET` use strings (`"Always"`, …) and edits accept strings.
  The spec's enum value `"Never"` does not exist: IRIS reports and accepts `"No"` and rejects `"Never"`
  with a datatype error.
- **`/v2/monitor/dashboard/main`**: `Licensing.LicenseUse` and `LicenseUseHigh` are percentages, while
  `LicenseLimit` right next to them is in license units — easy to misread as "13 of 8 units" (we did).
- **`POST /v2/task`** requires every `Task` field (notification lists, expiration, output, …), even for a simple
  daily task; sensible defaults on the server would make the endpoint much easier to use.
- **OAuth2 client configuration**: the spec names the server field `OAuth2ServerDefinition`, but
  `PUT /v2/security/oauth2/client/client-configuration` rejects it ("not expected") and requires `ServerDefinition`.
  Creating a server definition also requires `SSLConfiguration`, although the spec only marks it optional on updates.
- **Databases and namespaces**: `DELETE /v2/database-dir` deletes `IRIS.DAT` even when a namespace uses the
  database — only `DELETE /v2/database` checks that (409), so Admin Deck deletes the definition first.
  `POST /v2/database-dir` without `GlobalJournalState` creates a database with journaling off.
  Creating a namespace requires `Routines` although the spec marks no field as required, and routine mappings
  are listed with a `Type` field that `PUT` rejects (the type goes into the name, `MyRtn_MAC`).
  Validation errors (unknown database, a global name with `^`) come back as `500` rather than `400`.
- **SQL privileges**: `GET /v2/security/sql-privileges` returns `Object`/`Action`, not the `Name`/`Privilege`
  of the spec; a schema grant shows up only on each table as `GrantedVia: "Schema Privilege"`; a column grant
  for a column that does not exist answers `200` and records nothing; admin grants take one privilege per call.
- **Resources**: an empty `PublicPermission` is rejected with a bare `400` (no error message) on both
  create and edit, so a resource without public access cannot be created or set through the API, although
  `GET` reports `""` for existing ones.
- **SSL/TLS configurations**: `VerifyPeer` is required on create.
- **Wallet secret names** are qualified with the collection (`<collection>.<secret>`); a `/` separator yields
  "Object to Load not found, class '%Wallet.Collection'". Worth documenting in the spec.
- `/api/admin` has no CORS support by design — a UI must be served by IRIS itself or through a same-origin proxy.

## Ideas portal

Implements [DPI-I-966 — Option to show older messages.log in IRIS SMP](https://ideas.intersystems.com/ideas/DPI-I-966):
rotated `messages.old_*` and `alerts.old_*` files can be browsed, filtered and searched from the portal,
without shell access to the server.

## Contest

Submitted to the [InterSystems Programming Contest: Build Your Own Management Portal](https://community.intersystems.com/post/intersystems-programming-contest-build-your-own-management-portal) (2026).

## License

MIT — see [LICENSE](LICENSE).

## Author

Dawid Kryński — [InterSystems Developer Community profile](https://community.intersystems.com/user/dawid-kry%C5%84ski) · [GitHub](https://github.com/DawidKrynski)

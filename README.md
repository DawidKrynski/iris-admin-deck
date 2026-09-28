# IRIS Admin Deck

[![CI](https://github.com/DawidKrynski/iris-admin-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/DawidKrynski/iris-admin-deck/actions/workflows/ci.yml)

A web UI for administering one InterSystems IRIS 2026.2+ instance through the SysAdmin REST API
(`/api/admin/v2`). It covers web applications, users, roles and resources, wallet and certificates, tasks,
processes, databases and namespaces. On top of that it adds a log timeline, a viewer for rotated
`messages.old_*` files and a similar-incident search, which the API doesn't have. Every request the page
sends is listed in the API console and can be copied as `curl`.

Online demo (read-only): <https://niutics.pl/interSystems>, sign in as `demo` / `demo`. Every screen can be
browsed, but changes are blocked there. Run it locally (below) to try the actions.

![Dashboard](docs/img/dashboard.png)

## Run it

### Docker

Requires Docker with Compose.

```bash
git clone https://github.com/DawidKrynski/iris-admin-deck.git
cd iris-admin-deck
docker compose up -d --build
```

Open <http://localhost:52785/admindeck/index.html> and sign in with `SuperUser` / `SYS`. That login is for the
local demo container only; change the passwords for anything else.

The build seeds demo data through the SysAdmin API itself ([scripts/demo_seed.py](scripts/demo_seed.py)):
two X.509 credentials (one expires in 12 days, so the expiry warning has something to show), a wallet
collection with dummy secrets, a rotated `messages.old_*` log and a limited user `demo_operator` / `operator`
(role `%Operator`) to see how the navigation hides screens you have no privilege for.
Build with `--build-arg DEMO=0` to skip the seed.

Smoke test against a running instance:

```bash
scripts/smoke.sh http://localhost:52785
```

### IPM (existing IRIS 2026.2+ instance)

From a clone of this repository:

```objectscript
USER> zpm "load /path/to/iris-admin-deck"
```

or, once it is published to the Open Exchange registry:

```objectscript
USER> zpm "install iris-admin-deck"
```

Then open `http://<host>:<port>/admindeck/index.html`. The package creates two web applications:
`/admindeck` (the static UI) and `/admindeck/api` (a small extension REST API, JWT enabled).

### Requirements

- InterSystems IRIS or IRIS for Health Community Edition 2026.2 or newer. The SysAdmin API v2 does not
  exist before 2026.2, and `intersystemsdc/iris-community:latest` is still 2026.1, so the Dockerfile uses
  `intersystemsdc/iris-community:2026.2-zpm`. I tested it on that image and on
  `intersystemsdc/irishealth-community:2026.2-zpm`
  (`docker compose build --build-arg IMAGE=intersystemsdc/irishealth-community:2026.2-zpm`), amd64 only;
  both images are also published for arm64.
- Embedded Python (included in those images). OS metrics read `/proc`, so they work on Linux and in
  containers only.
- A user with the `%Admin_*` resources for the screens they need (e.g. `%All`).
- One instance per browser tab. There is no multi-instance view.
- For a public deployment, `set ^AdminDeck("Settings","HideHostDetails")=1` (in the package namespace)
  hides the kernel version, host name and uptime from the OS metrics.

## What's in it

| Screen | What you can do there |
| --- | --- |
| Dashboard | Health checks, global refs/s and CPU charts, CPU/memory/disk, license use, upcoming tasks, and a "needs attention" list (errors, certificates expiring soon, dismounted databases, recurring log warnings) |
| Status | One row per component (instance state, Web Gateway latency, database read latency, SQL runtime, CPU) with a bar per minute for the last hour, plus warnings/errors per hour for the last day |
| Web apps & REST | List, create from a REST or static preset, edit, enable/disable, delete. System applications can't be deleted |
| Users, Roles & permissions | Users, roles, resources, `%Service_*` services, an access matrix (which role or public permission gives a user each resource), SQL object/column/admin privileges |
| Secrets & certificates | Wallet collections and secrets (write-only values), X.509 credentials with expiry, SSL/TLS configurations with a test, OAuth2 server definitions and client configurations |
| Tasks | Run now, suspend/resume, edit, history, upcoming runs, suspend/resume the Task Manager itself |
| Processes & locks | Processes (suspend, resume, terminate, broadcast), locks, CSP/web sessions |
| Databases & system | Databases (create, edit, delete, mount/dismount, expand/compact/truncate, integrity check, which namespaces use each one), namespaces with global/routine/package mappings, journal files and a record browser (filter by global, PID or time; old and new value of each change; who last changed a global), backups (last good backup per type, history, the tasks that run them), devices, license, background jobs |
| Interoperability | Productions per namespace: state, items with errors and queue counts, recent errors; start, update, recover, and stop after typing the production name. Enables Interoperability on a namespace that doesn't have it |
| Language servers | External language servers (Python, Java, .NET gateways): state, start/stop, settings, create, delete, recent activity |
| Logs & insights | Timeline, log viewer (current and rotated files), recurring problems, similar incidents |
| Audit trail | Search audit records, turn individual audit events on or off, turn auditing on if it's off. Maintenance: IRISAUDIT size and date range, copy records to a namespace, purge records older than N days (never the newest ones; you type the number of records first) |
| API explorer | All 190 paths (273 operations) from the 2026.2 OpenAPI spec, with an example body and a preview before sending |

Ctrl+K opens a palette that finds screens, users, roles, web applications and tasks by name.

The Timeline merges seven sources: `messages.log`, `alerts.log`, `SystemMonitor.log`, `journal.log`,
application errors (`^ERRORS` from every namespace via `SYS.ApplicationError`), the security audit and Task
Manager history. Each source shows whether it loaded, is not permitted for your user, or is unavailable.

Where a problem is shown, the matching action sits next to it: a dismounted database gets Mount, a failed task
run gets Run again, an expiring certificate links to its credential, and a burst of failed logins links to
the user.

The audit screen can turn auditing on, but it has no switch to turn it off. To disable auditing, use SMP or
the API console.

Quick tour, if you only have a couple of minutes:

1. Open the [demo](https://niutics.pl/interSystems) (the login is pre-filled) or run it locally.
2. Press Ctrl+K and type a user or task name.
3. Go to Logs & insights, then Timeline.
4. In the Log viewer, hover an entry and choose Find similar incidents.
5. Open Roles & permissions, then Access matrix.
6. Open the `{ }` API console in the top bar and copy one of the calls as `curl`.
7. Locally: open a web app in two tabs, change the description in one, then save the other (see below).

## Notes on the SysAdmin API (2026.2)

Things I ran into while building on the API. Most of them are pinned down in `tests/integration/`
or in a comment next to the workaround in `web/js/`.

- Long-running operations (`database-dir/info`, `integrity-check`, `security/audit/records`, ...) answer
  `202 Accepted` with an empty body. The task id is only in the `Location` header, so I read it from there
  and poll `GET /v2/async-result?id=...`.
- `PUT /v2/web-app`: when it creates an application, `ServeFiles` and `UseCookies` are validated as the
  numeric codes (`0`-`3`), while `GET` returns strings (`"Always"`, ...) and edits accept strings. The spec's
  enum has `"Never"` for `ServeFiles`; IRIS reports `"No"` and rejects `"Never"`.
- `/v2/monitor/dashboard/main`: `Licensing.LicenseUse` and `LicenseUseHigh` are percentages, but
  `LicenseLimit` right next to them is in license units. Easy to misread as "13 of 8 units" (I did).
- `POST /v2/task` wants every `Task` field (notification lists, expiration, output file, ...), even for a
  plain daily task. The UI fills in neutral defaults.
- OAuth2 client configurations take `ServerDefinition`; the spec calls the field `OAuth2ServerDefinition`.
- Databases: a database is a file (`/v2/database-dir`) plus a definition (`/v2/database`).
  `DELETE /v2/database` refuses (409) while a namespace still uses the database, so the UI deletes the
  definition first and the file second. `POST /v2/database-dir` without `GlobalJournalState` creates a
  database with journaling off.
- Namespaces: `PUT /v2/namespace` needs `Routines` on create, although the spec marks no field as required.
- SQL privileges: `GET /v2/security/sql-privileges` returns `Object`/`Action`, not the `Name`/`Privilege`
  from the spec. A schema grant only shows up on each table, as `GrantedVia: "Schema Privilege"`. A column
  grant for a column that doesn't exist answers `200` and records nothing. Admin privileges are granted one
  per call.
- Resources: an empty `PublicPermission` is rejected with a bare `400` and no message, so a resource without
  public access can't be created or set to that through the API, even though `GET` reports `""` for existing
  ones.
- Audit copy and purge answer `202` and say nothing about how many records they processed. A bad date or an
  unknown namespace only shows up as a failed background task. There is no count call, and every audit query
  writes an `AuditReport` record of its own.
- External language servers: `PUT /v2/ext-lang-server` refuses an update without `Type` (`#40301`), although
  the spec needs it only on create. The list has no running state, so it takes one `activity` call per server,
  and `start` blocks until the process is up (about 10 s for Python) and returns its log as HTML.
- Journal records: `maxRows` returns half of what you ask for (10 gives 5, 200 gives 100), `initialOffset` is
  inclusive, and an unknown `matchOperator` or a column name in the wrong case returns an empty list instead
  of an error. Every background call of the API writes its own bookkeeping (`^Api.Admin.Util.AsyncTaskD` in
  IRISLOCALDATA) to the journal, so on a quiet instance most recent records are the API talking to itself;
  the record browser hides them by default. `OldValue` exists only for changes made inside a transaction.
- Wallet secret names are qualified with the collection: `<collection>.<secret>`.
- `/api/admin` sends no CORS headers, so a UI has to be served by IRIS itself or through a same-origin proxy.
  That's why this one lives under `/admindeck` on the same web server.

## How edits are checked

![A saved edit read back, and a stale edit refused](docs/img/verified-change.gif)

The API has no ETags or object versions. So before a PUT, the form reads the object again and refuses to
save if a field you changed was also changed by someone else since you opened the form. After the write it
reads the object once more and tells you whether the fields match what you sent or which ones differ.
Passwords and wallet values can't be read back, so for those you only get "accepted". Background operations
are also reported as accepted, not read back, and the API explorer sends raw calls without any of this.

This is not a lock. A change made in the few milliseconds between the re-read and the write is not caught.

Deleting a named object asks you to type its name. Terminating a process first checks that the PID still
belongs to the same job. The UI won't disable or delete its own web applications, `%Service_WebGateway`
or the account you are signed in with.

## Similar incidents and recurring problems

The API has no log endpoints, so the package adds `/admindeck/api` (JWT, requires `%Admin_Operate:USE`).
Embedded Python parses the log files and groups messages into patterns: numbers, paths and quoted values are
masked, identical messages are counted once, sorted by severity and then count.

Similar incidents is lexical, not semantic. Each log line is hashed into a 256-dimension vector (word
unigrams and bigrams, character trigrams), stored in a `%Vector` column with an HNSW index and queried with
`VECTOR_COSINE`. It finds the same message with different numbers or paths well. It will not match
"disk full" with "no space left on device". Nothing is sent outside IRIS and there is no model to download.

`messages.log` is indexed on install and a Task Manager task, Admin Deck: reindex logs, refreshes the index
daily at 03:15. Other or rotated files can be indexed from Similar incidents with Build / refresh index.

## Known weak spots

- The stale-write check has the race window described above.
- Similar incidents matches wording, not meaning.
- Very large logs: only the last 8 MB of a file is parsed.
- OS metrics are Linux-only (`/proc`, `statvfs`).
- Some detail views (a web application, the license) still show raw API field names and codes, e.g.
  `AutheEnabled 32` instead of "Password".
- The Docker image is a local development instance with the well-known `SuperUser`/`SYS` login bound to
  localhost. The public demo is a separate, read-only deployment.

## How it works

```
browser ── same origin ──► IRIS web server
                             ├── /admindeck/       static single-page app (plain ES modules)
                             ├── /api/admin/v2/*   built-in SysAdmin API (all management actions)
                             └── /admindeck/api/*  extension REST API (JWT)
                                   ├── logs      Embedded Python log parser (current + rotated files)
                                   ├── apperrors application errors of all namespaces (SYS.ApplicationError)
                                   ├── os        Embedded Python CPU / memory / disk metrics
                                   ├── search    IRIS Vector Search over log entries
                                   ├── backups   backup definitions, tasks and history (read-only)
                                   └── interop   production status, items, queues, errors; start/stop/update/recover
```

Changes go through `/api/admin/v2`, with one exception: Interoperability productions, which the SysAdmin API
doesn't cover. Start, stop, update and recover call `Ens.Director`, and the server checks the caller's
`%Admin_Operate` and `%Ens_ProductionRun` on every request. Everything else in the extension API only reads:
log files from an allow-list in the manager directory, `SYS.ApplicationError`, `/proc`, backup history
(`Backup.Task`) and the vector index. The front end is plain ES modules
with no build step and no third-party runtime dependencies; IPM installs it as files. A small sampler
(`AdminDeck.Metrics`) records a sample every 5 seconds and keeps 720 of them, so the charts show the last
hour as soon as you open them.

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Screenshots

| | |
| --- | --- |
| ![Timeline](docs/img/timeline.png) Timeline with per-source status | ![Command palette](docs/img/palette.png) Ctrl+K palette |
| ![Edit read back](docs/img/verified-change.png) An edit read back after saving | ![Status](docs/img/status.png) Status: the last hour per component |
| ![Similar incidents](docs/img/logs-similar.png) Similar incidents | ![Recurring problems](docs/img/logs-insights.png) Recurring problems in `messages.log` |
| ![Tasks](docs/img/tasks.png) Tasks | ![API console](docs/img/api-console.png) API console |
| ![Access matrix](docs/img/access-matrix.png) Access matrix | ![X.509](docs/img/secrets-x509.png) X.509 credentials with expiry |
| ![Web apps](docs/img/webapps.png) Web apps & REST | ![API explorer](docs/img/explorer.png) API explorer |
| ![Databases](docs/img/databases.png) Databases | |

## Development

```bash
# UI served live from ./web (edit and reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d

# Unit tests: JavaScript (edit checks, incident actions, palette ranking) and Python (log parsing, embeddings)
node --test tests/js
cd python && python -m pytest -q tests && cd ..

# Integration tests against the running container (26 tests): the endpoints the UI reads, the write flows
# on throw-away objects, async tasks, the extension API, auth and CORS
python3 -m unittest discover -s tests/integration -v

# End-to-end UI tests (headless Chromium)
uvx --with playwright python tests/e2e/test_ui.py

# ObjectScript unit tests (8 test methods)
docker compose exec iris iris session IRIS -U USER '##class(%ZPM.PackageManager).Shell("iris-admin-deck test -only -v",1,1)'

# Look up any SysAdmin API endpoint in the OpenAPI spec
python3 scripts/endpoint.py /v2/task/run --schemas
```

CI (GitHub Actions) runs these tests on every push, against IRIS built from the Dockerfile.

Project layout:

```
src/AdminDeck/        ObjectScript: REST dispatch, installer, log/OS/vector/metrics classes
python/admindeck/     Embedded Python helpers (log parsing, OS metrics, embeddings)
web/                  Single-page app (index.html, js/, css/, openapi.json)
tests/                %UnitTest classes, JS/Python unit tests, integration and e2e tests
module.xml            IPM package definition
```

## Ideas portal

This implements [DPI-I-966, Option to show older messages.log in IRIS SMP](https://ideas.intersystems.com/ideas/DPI-I-966):
rotated `messages.old_*` and `alerts.old_*` files can be browsed, filtered and searched without shell access
to the server.

## Contest

Submitted to the [InterSystems Programming Contest: Build Your Own Management Portal](https://community.intersystems.com/post/intersystems-programming-contest-build-your-own-management-portal) (2026).

## License

MIT, see [LICENSE](LICENSE).

## Author

Dawid Kryński: [InterSystems Developer Community profile](https://community.intersystems.com/user/dawid-kry%C5%84ski) · [GitHub](https://github.com/DawidKrynski)

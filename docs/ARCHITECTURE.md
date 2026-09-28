# IRIS Admin Deck: architecture

A single-page management portal for InterSystems IRIS built on the SysAdmin REST API
(`/api/admin/v2`, IRIS 2026.2+), plus a small extension API for the things the SysAdmin API does not expose.

## Constraints

- `/api/admin` sends no CORS headers, so the UI is a static web application served by IRIS itself
  (`/admindeck`): same origin, no proxy.
- The SysAdmin API v2 exists from IRIS 2026.2, so the container image is
  `intersystemsdc/iris-community:2026.2-zpm` (`intersystemsdc/irishealth-community:2026.2-zpm` also works).
- Authentication is JWT. `/api/admin` issues 60 s access and 900 s refresh tokens; the extension
  (`/admindeck/api`) is configured with 300 s / 1800 s. The browser keeps only the tokens (sessionStorage),
  never the password.
- The API has no object versions or ETags, which is why edits are re-read before writing (see `verify.js`).

## Components

```
browser ──same origin──►  IRIS web server (:52773, published as :52785)
                            ├── /admindeck/        static SPA (index.html, js/, css/, openapi.json)
                            ├── /api/admin/v2/*    built-in SysAdmin API: every management action
                            └── /admindeck/api/*   extension REST (AdminDeck.REST.Dispatch, JWT)
                                  ├── /logs         log files (current + rotated), recurring patterns
                                  ├── /apperrors    application errors of all namespaces
                                  ├── /os           CPU, memory, disks
                                  ├── /metrics      last hour of 5 s samples (AdminDeck.Metrics)
                                  ├── /search       similar-incident search (IRIS Vector Search)
                                  ├── /changes      log of changes made through Admin Deck (AdminDeck.Changes)
                                  └── /restapps     REST applications of the instance and their routes
```

### Frontend (`web/js`)

- Plain ES modules, no build step, no runtime dependencies.
- `api.js`: two JWT clients (`admin`, `ext`) with single-flight refresh, and a session generation counter that
  drops late refresh results after sign-out. Both clients refresh 10 seconds before JWT expiry while the tab
  is open, recheck on visibility changes, and expire the session after eight hours without pointer or keyboard
  activity. The activity timestamp survives page reloads; passwords are never retained. It unwraps the `{status, console, result}` envelope, turns
  `202 Accepted` + `Location` into `{GUID, State: 'Queued'}`, and `waitAsync()` polls `/v2/async-result`.
  `jobs.js` records polling progress in memory; `jobs-ui.js` shows active operations and the latest 20 finished
  outcomes in the top bar. History clears on sign-out or page reload; response bodies are not retained.
  Password, secret and token fields are redacted before anything reaches the API console, previews or `curl`.
- `ui.js`: the DOM helper `h()` (text only, never `innerHTML`), table, tabs, modal, `confirmAction()` with an
  API-call preview and optional typed confirmation, `objectForm()` + `diff()` for PUT payloads, toasts.
- `verify.js` (about 90 lines): re-reads the object before writing and refuses when a field being changed has
  moved since the form was opened, then reads it back afterwards and reports which fields match. Every screen
  uses it through `confirmAction({verify})` and `applyVerified()`. `findInList()` in `api.js` reads objects that
  have no get-by-name endpoint.
- `access.js`: pure model of who holds what (users, roles including granted roles, public permissions). Before a
  role delete, a role losing grants, a user losing roles, or a user being disabled or deleted, `impact.js` applies
  the change to a fresh snapshot, lists the enabled users who lose access and refuses the change when no enabled
  user would hold %All.
- `actions.js`: the action offered next to a problem in Needs attention and the Timeline (mount a dismounted
  database, run a failed task again, open a credential, task or user, similar incidents). The recognisers are
  pure functions, tested in `tests/js`.
- `restapps.js`: pure helpers of the explorer tab "REST APIs on this instance": the merged application list,
  routes from an OpenAPI 2.0/3.x spec or a UrlMap, path filling, the response as text. `rawCall()` in `api.js`
  sends Try it requests with the portal's JWT (accepted by every application with JWT authentication, refused by
  password-only ones such as `/api/mgmnt`) and never signs out on the tried application's 401.
- `palette.js`: the Ctrl+K palette over screens, shell actions and objects (users, roles, web apps, tasks).
- `app.js`: login, grouped navigation filtered by the privileges from `/api/admin/info`, the hash router (each
  route renders into its own node; open dialogs close on navigation), the API console.
- `screens/*.js`: one module per screen: dashboard, status, webapps, explorer, users, roles (roles,
  resources, access matrix, services, SQL privileges), secrets (wallet, X.509, SSL/TLS, OAuth2), tasks,
  processes (processes, locks, web sessions), system (databases, namespaces, journal, devices, license,
  background jobs), logs (timeline, viewer, recurring problems, similar incidents), audit.

### Extension (`src/AdminDeck`, `python/admindeck`)

- `AdminDeck.REST.Dispatch`: routes. Every endpoint requires `%Admin_Operate:USE`, except `POST /changes` (any
  signed-in user records their own change) and `GET /changes` (`%Admin_Secure:USE` or `%Admin_Operate:USE`).
- `AdminDeck.Changes`: the change log in `^AdminDeck("Changes")`, journaled, newest 5000 entries. The UI records
  each confirmed change after it ran (`applyVerified()` / `confirmAction()` in `ui.js`, fire-and-forget): what,
  method and path of each call (no bodies), and the read-back outcome, including refused and failed ones.
- `AdminDeck.REST.Dispatch`: routes. Every endpoint requires `%Admin_Operate:USE`, except `/restapps`, which
  also accepts `%Development:USE` (the audience of `/api/mgmnt`).
- `AdminDeck.RestApps`: the list of `/api/mgmnt` (`%REST.API`, in-process, because `/api/mgmnt` takes only
  basic auth), and for one listed application the OpenAPI spec (spec-first, `%REST.disp`) and the UrlMap routes
  of its dispatch class, following `<Map Forward>`. Only dispatch classes of listed applications are read.
- `AdminDeck.Util`: allow-list of log files in the manager directory plus rotated `messages.old_*` /
  `alerts.old_*` files, checked by pattern and existence. Nothing else can be opened.
- `AdminDeck.AppErrors`: application errors of every namespace via `SYS.ApplicationError`, limited to the newest
  N. A failed query is reported as an error, not as an empty log.
- `AdminDeck.Metrics`: a background job that samples global references, CPU and the monitoring metrics every
  5 s and keeps 720 samples (one hour). It reads the metrics in-process through
  `SYS.Monitor.SAM.Sensors.PrometheusMetrics()`, the call behind `/api/monitor/metrics`, so it does not depend
  on the web server port.
- `AdminDeck.Logs`, `AdminDeck.OS`: thin ObjectScript wrappers over Embedded Python (`python/admindeck`,
  copied to `<mgr>/python/admindeck` by IPM):
  - `logparse.py` parses IRIS log lines (including continuation lines), filters them, and groups messages into
    patterns with numbers, paths and quoted values masked;
  - `osinfo.py` reads `/proc/stat`, `/proc/meminfo`, the cgroup memory limit and `os.statvfs`;
  - `embed.py` computes deterministic 256-dimension vectors by feature hashing (word unigrams and bigrams,
    character trigrams), L2-normalised. No model download.
- `AdminDeck.Data.LogLine`: a `%Vector(DATATYPE="DOUBLE", LEN=256)` column with an HNSW index
  (`%SQL.Index.HNSW`, cosine). `AdminDeck.VectorSearch` rebuilds a file's index in one transaction and
  queries it with `ORDER BY VECTOR_COSINE(...) DESC`.
- `AdminDeck.Task.ReindexLogs`: Task Manager task (daily 03:15) created by `AdminDeck.Installer`.
- `AdminDeck.Installer`: enables JWT and password authentication on `/admindeck/api`, sets a short
  static-file expiry on `/admindeck`, schedules the task and builds the initial index.

## Known limits

- The pre-write check is not a lock. A change made between the re-read and the write (a few milliseconds)
  is not detected.
- Similar incidents is lexical. It matches the same message with different numbers or paths, not a
  paraphrase ("disk full" vs "no space left on device").
- `logparse.py` parses only the last 8 MB of a file (`MAX_BYTES`).
- OS metrics need `/proc`, i.e. Linux or a Linux container.
- One instance per browser tab; there is no multi-instance view.

## Packaging

- IPM: `module.xml` lists the ObjectScript sources, a `FileCopy` of the UI and the Python package, two
  `WebApplication`s, the unit tests, and an `Invoke` of the installer.
- Docker: the `Dockerfile` loads the module, seeds demo data through the SysAdmin API
  (`scripts/demo_seed.py`, `--build-arg DEMO=0` to skip) and marks the image initialised.

## Tests

- `tests/js`: `node --test` for the edit-check logic, access impact, incident actions, palette ranking and the REST
  route helpers.
- `python/tests`: pytest for parsing, grouping and embeddings.
- `tests/AdminDeck/Tests`: `%UnitTest` for the allow-list, log queries, embeddings, vector search, OS metrics,
  application errors, hidden host details and the metrics sampler.
- `tests/integration`: `unittest` against a running instance: the SysAdmin endpoints the UI reads, async
  tasks (202 + async-result), the write flows on throw-away objects, the extension API, auth and CORS.
- `tests/e2e`: Playwright over every screen and tab, the palette, create/edit with read-back, the stale-edit
  refusal, typed-confirm delete, the timeline source statuses and the users listed before a role delete.
- `scripts/smoke.sh`: quick end-to-end checks against a running instance.

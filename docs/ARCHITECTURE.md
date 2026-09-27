# IRIS Admin Deck — architecture

A single-page management portal for InterSystems IRIS built on the SysAdmin REST API
(`/api/admin/v2`, IRIS 2026.2+), plus a small extension API for what the SysAdmin API does not expose.

## Constraints that shaped the design

- `/api/admin` intentionally rejects cross-origin requests, so the UI is a static web application
  served **by IRIS itself** (`/admindeck`) — same origin, no proxy.
- The SysAdmin API v2 exists from IRIS 2026.2, so the container image is
  `intersystemsdc/iris-community:2026.2-zpm` (`intersystemsdc/irishealth-community:2026.2-zpm` also works).
- Authentication is JWT. `/api/admin` issues 60 s access / 900 s refresh tokens; the extension
  (`/admindeck/api`) is configured with 300 s / 1800 s. The browser keeps only tokens (sessionStorage),
  never the password.

## Components

```
browser ──same origin──►  IRIS web server (:52773, published as :52785)
                            ├── /admindeck/        static SPA (index.html, js/, css/, openapi.json)
                            ├── /api/admin/v2/*    built-in SysAdmin API — every management action
                            └── /admindeck/api/*   extension REST (AdminDeck.REST.Dispatch, JWT)
                                  ├── /logs         log files (current + rotated), recurring patterns
                                  ├── /os           CPU, memory, disks
                                  └── /search       similar-incident search (IRIS Vector Search)
```

### Frontend (`web/js`)

- Vanilla ES modules, no build step, no runtime dependencies.
- `api.js` — two JWT clients (`admin`, `ext`) with single-flight refresh and a session generation that
  discards late refresh results after sign-out; unwraps the `{status, console, result}` envelope;
  turns `202 Accepted` + `Location` into `{GUID, State: 'Queued'}` and `waitAsync()` polls
  `/v2/async-result`; redacts password/secret/token fields before anything reaches the API console,
  previews or `curl`.
- `ui.js` — DOM helper `h()` (text only, never `innerHTML`), table, tabs, modal, `confirmAction()` with
  API-call preview and optional typed confirmation, `objectForm()` + `diff()` for PUT payloads, toasts.
- `verify.js` — verified changes: re-read before writing (refuse when the fields being changed moved since
  the form was opened) and read back afterwards (*verified* / *not reflected*); used by every screen through
  `confirmAction({verify})` and `applyVerified()`. `findInList()` (api.js) reads objects that have no
  get-by-name endpoint.
- `actions.js` — the next step offered on an incident in Needs attention and the Timeline (mount a dismounted
  database, run a failed task again, open a credential / task / user, similar incidents); recognisers are pure.
- `palette.js` — Ctrl+K command palette over screens, shell actions and objects (users, roles, web apps, tasks).
- `app.js` — login, persona-grouped navigation filtered by `/api/admin/info` privileges, hash router
  (each route renders into its own node, open dialogs are closed on navigation), API console.
- `screens/*.js` — one module per screen: dashboard, webapps, explorer, users, roles (roles, resources,
  access matrix, services, SQL privileges), secrets (wallet, X.509, SSL/TLS, OAuth2), tasks,
  processes (processes, locks, web sessions), system (databases, namespaces, journal, devices,
  license, background jobs), logs (timeline, viewer, recurring problems, similar incidents), audit.

### Extension (`src/AdminDeck`, `python/admindeck`)

- `AdminDeck.REST.Dispatch` — routes; every endpoint requires `%Admin_Operate:USE`.
- `AdminDeck.Util` — allow-list of log files in the manager directory plus rotated
  `messages.old_*` / `alerts.old_*` files (validated by pattern and existence); nothing else can be opened.
- `AdminDeck.AppErrors` — application errors of every namespace via `SYS.ApplicationError`
  (bounded to the newest N, query failures surface as errors, not as an empty log).
- `AdminDeck.Logs`, `AdminDeck.OS` — thin ObjectScript wrappers over Embedded Python
  (`python/admindeck`, copied to `<mgr>/python/admindeck` by IPM):
  - `logparse.py` — parses IRIS log lines (with continuation lines), filters, and groups messages into
    patterns (numbers, paths, quoted values normalised);
  - `osinfo.py` — `/proc/stat`, `/proc/meminfo`, cgroup memory limit, `os.statvfs` (Linux / containers);
  - `embed.py` — deterministic 256-dimension embeddings by feature hashing (word unigrams, bigrams,
    character trigrams), L2-normalised; no model download.
- `AdminDeck.Data.LogLine` — `%Vector(DATATYPE="DOUBLE", LEN=256)` column with an HNSW index
  (`%SQL.Index.HNSW`, cosine); `AdminDeck.VectorSearch` rebuilds a file's index in one transaction and
  queries `ORDER BY VECTOR_COSINE(...) DESC`.
- `AdminDeck.Task.ReindexLogs` — Task Manager task (daily 03:15) created by `AdminDeck.Installer`.
- `AdminDeck.Installer` — enables JWT and password authentication on `/admindeck/api`, short static-file
  expiry on `/admindeck`, schedules the task and builds the initial index.

## Packaging

- IPM: `module.xml` — ObjectScript sources, `FileCopy` of the UI and the Python package, two
  `WebApplication`s, unit tests, `Invoke` of the installer.
- Docker: `Dockerfile` loads the module, seeds demo data through the SysAdmin API
  (`scripts/demo_seed.py`, `--build-arg DEMO=0` to skip) and marks the image initialised.

## Tests

- `tests/js` — `node --test`: verified-change logic and palette ranking.
- `python/tests` — pytest for parsing, grouping and embeddings.
- `tests/AdminDeck/Tests` — `%UnitTest` for the allow-list, log queries, embeddings, vector search, OS,
  application errors.
- `tests/integration` — `unittest` against a running instance: every SysAdmin endpoint the UI reads,
  background tasks (202 + async-result), all write flows on throw-away objects, extension API, security.
- `tests/e2e` — Playwright: every screen and tab, palette, verified create/edit, stale-edit refusal,
  typed-confirm delete, timeline statuses.
- `scripts/smoke.sh` — quick end-to-end checks against a running instance.

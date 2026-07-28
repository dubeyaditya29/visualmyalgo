# VisualMyAlgo — Project Context

> **Purpose of this file:** Give humans and AI assistants a fast, accurate map of the repo before making changes. Update this when architecture or conventions change.

**Version:** 3.0.0  
**License:** See [LICENSE](LICENSE)

---

## What This Project Is

**VisualMyAlgo** is a desktop-first **code tracing workspace**. Users paste JavaScript, Python, C++, or Java into a Monaco editor, run code in an isolated Docker container, and step through an execution timeline with source highlighting, variables, call stacks, console output, and breakpoints.

It evolved from [algorithm-visualizer](https://github.com/algorithm-visualizer/algorithm-visualizer). The repo currently contains **two codebases**:

| Generation | Location | Status | Description |
|------------|----------|--------|-------------|
| **v3 (active)** | `apps/web`, `apps/api`, `packages/protocol` | Used by `npm run dev` | TypeScript tracing debugger |
| **v2 (legacy)** | `src/` | Not wired to root scripts | Original React + Redux algorithm visualizer |

**When in doubt, work in `apps/` unless the task explicitly targets the legacy visualizer.**

---

## Quick Start

```bash
npm install
npm run dev
```

| Service | URL | Notes |
|---------|-----|-------|
| Web app | http://localhost:3000 | Vite dev server |
| API | http://localhost:8080 | Requires **Docker daemon** for code execution |

```bash
npm test          # Vitest in web + api workspaces
npm run typecheck # tsc --noEmit in both workspaces
npm run build     # Production build
```

---

## Repository Layout

```
visualmyalgo/
├── apps/
│   ├── web/                 # React + Vite frontend (Monaco, Zustand)
│   │   └── src/
│   │       ├── main.tsx     # Entire v3 UI (~300 lines, single-file app)
│   │       ├── trace.ts     # Step-over / step-out navigation helpers
│   │       └── *.css
│   └── api/                 # Express API + Docker execution
│       └── src/
│           ├── index.ts     # HTTP routes, rate limiting, SSE
│           └── runs.ts      # RunManager, Docker sandbox
├── packages/
│   └── protocol/            # Shared TypeScript types (no build step)
│       └── src/index.ts
├── src/                     # LEGACY algorithm-visualizer (JS, Redux, SCSS)
│   ├── index.js             # Legacy entry
│   ├── components/          # App, Player, Navigator, CodeEditor, etc.
│   ├── core/
│   │   ├── tracers/         # Array, Graph, Chart, Log, Markdown tracers
│   │   ├── renderers/       # Canvas/DOM renderers paired with tracers
│   │   └── layouts/         # Horizontal/Vertical layout containers
│   ├── reducers/            # Redux state (player, directory, toast, etc.)
│   └── apis/                # AlgorithmApi, GitHubApi, TracerApi
├── public/                  # Legacy static assets
├── package.json             # npm workspaces root
└── README.md                # User-facing overview
```

---

## Architecture (v3 — Active Stack)

### Data flow

```
User (Monaco editor)
    │
    ▼ POST /api/runs  { language, code, stdin, breakpoints }
apps/web (main.tsx)
    │
    ▼
apps/api (index.ts → RunManager in runs.ts)
    │
    ▼ docker run (isolated container)
Language image executes code
    │
    ▼ SSE GET /api/runs/:id/events
apps/web consumes trace events → timeline UI
```

### Shared protocol (`packages/protocol`)

Single source of truth for web ↔ api contracts:

- **Languages:** `javascript` | `python` | `cpp` | `java`
- **`TraceEvent`:** step, breakpoint, stdout, stderr, error, complete — with line, stack frames, locals, elapsed time
- **`RunRequest`:** language, code, optional stdin, breakpoints array
- **`RunCreated`:** runId + eventsUrl

Import as `@visualmyalgo/protocol` in both workspaces.

### API (`apps/api`)

**Routes:**

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/runs` | Queue a run (202 + runId) |
| GET | `/api/runs/:id/events` | SSE stream of trace + complete events |
| DELETE | `/api/runs/:id` | Cancel a run |

**Limits & security:**

| Limit | Value |
|-------|-------|
| Source size | 100 KB |
| Output size | 64 KB |
| Timeout | 20 seconds |
| Queue size | 20 concurrent |
| Rate limit | 12 runs/min/IP |

Docker flags: `--network none`, `--read-only`, `--cap-drop ALL`, memory 128m, CPU 0.5, pids 64.

**Important:** Tracing is **line-based**, not a real debugger. `executableLines()` emits synthetic `step`/`breakpoint` events for each non-empty, non-comment line *before* the container runs. True runtime state (locals, call stack depth) is partially enriched on the **client** in `main.tsx`.

**Docker images** (see `runs.ts`):

- JS: `node:20-alpine`
- Python: `python:3.12-alpine`
- C++: `gcc:14`
- Java: `eclipse-temurin:21-jdk`

### Web app (`apps/web`)

**Stack:** React 18, TypeScript, Vite 6, Zustand, Monaco Editor.

**Key behaviors in `main.tsx`:**

- Language starters (binary search examples per language)
- Breakpoints via Monaco line gutter clicks
- Playback: play/pause, restart, prev/next, step into/over/out, timeline seek, speed 0.5×–4×
- Optional debounced auto-run (850ms)
- Function signature detection + auto-wrap with default test inputs
- Array literal detection + active-index highlighting during trace
- Light/dark theme persisted in `localStorage`
- Keyboard: ⌘/Ctrl+Enter run, Space play/pause

**Trace navigation** (`trace.ts`):

- `eventAt(events, cursor)` — safe index lookup
- `nextByDepth(events, cursor, 'over' | 'out')` — step-over / step-out by stack depth

**Vite proxy:** `/api` → `http://localhost:8080` (see `vite.config.ts`, port 3000).

---

## Architecture (v2 — Legacy Stack)

Command-driven algorithm visualization, **not** connected to the v3 dev pipeline.

```
User code → TracerApi → tracer commands [{ key, method, args }]
    → Redux player reducer
    → VisualizationViewer replays commands
    → Tracer/Renderer React components
```

**Tracer types** (`src/core/tracers/`):

- `Array1DTracer`, `Array2DTracer` — arrays/grids
- `GraphTracer` — directed/weighted graphs
- `ChartTracer`, `ScatterTracer` — charts
- `LogTracer`, `MarkdownTracer` — console and markdown

**Patterns:**

- Class components + Redux `connect()`
- `BaseComponent` for shared error → toast handling
- Each tracer implements `getRendererClass()`; renderer reads tracer `data`
- SCSS modules (`*.module.scss`) co-located with components
- Path aliases via `jsconfig.json` (`baseUrl: "src"`) — imports like `components/App`

**External dependencies (not in this repo):**

- Algorithm catalog: https://github.com/algorithm-visualizer/algorithms
- Tracer libraries: https://github.com/search?q=topic%3Avisualization-library+org%3Aalgorithm-visualizer
- Legacy server: https://github.com/algorithm-visualizer/server

---

## Testing

| Workspace | Framework | Test files |
|-----------|-----------|------------|
| `apps/api` | Vitest 3 | `src/runs.test.ts` — `executableLines()` |
| `apps/web` | Vitest 3 | `src/trace.test.ts` — `nextByDepth()` |
| `src/` (legacy) | None | — |

No Vitest config files — defaults are used. No CI workflows (only `.github/FUNDING.yml`).

---

## Configuration Reference

| File | Purpose |
|------|---------|
| `.env` | `SKIP_PREFLIGHT_CHECK=true` (legacy CRA remnant) |
| `apps/web/vite.config.ts` | Port 3000, API proxy |
| `apps/api/src/index.ts` | `PORT` env (default 8080) |
| `jsconfig.json` | Legacy path alias `baseUrl: "src"` |
| `.gitignore` | `node_modules`, `dist`, `.env.local*`, `coverage`, `/build` |
| `.gitpod.yml` | Legacy Gitpod setup (old stack + external server repo) |

---

## Conventions for Contributors

### v3 (preferred for new work)

1. **Shared types go in `packages/protocol`** — never duplicate web/api types.
2. **Keep API logic in `runs.ts`**, routes in `index.ts` — don't mix concerns.
3. **`main.tsx` is intentionally monolithic** for now; extract components only when it reduces complexity meaningfully.
4. **Security:** never weaken Docker sandbox flags without reading `apps/api/docker/README.md`.
5. **Tracing limitations:** line-based events ≠ real debugger; document any change that affects trace semantics.

### Legacy (`src/`)

1. Match existing Redux + class component patterns.
2. Tracer/Renderer pairs must stay in sync.
3. Use SCSS modules, not global CSS, for component styles.

---

## Common Tasks

| Task | Where to look |
|------|---------------|
| Add a language | `packages/protocol` (type), `runs.ts` (Docker image + command), `main.tsx` (starter template) |
| Change run limits | `runs.ts` → `LIMITS` constant |
| Add API endpoint | `apps/api/src/index.ts` |
| Fix step navigation | `apps/web/src/trace.ts` |
| Change UI/debugger | `apps/web/src/main.tsx` |
| Legacy visualization | `src/core/tracers/`, `src/core/renderers/` |

---

## Known Gaps / Tech Debt

- Two coexisting codebases; legacy `src/` is not in npm workspaces build.
- Line-based tracing does not capture real runtime locals or call stacks from the container.
- `.gitpod.yml` and `CONTRIBUTING.md` still describe the old algorithm-visualizer architecture.
- No GitHub Actions CI/CD.
- README has minor HTML artifact (`</li></ul>`) in the algorithms section.

---

## Related Repositories

| Repo | Role |
|------|------|
| [algorithm-visualizer/algorithms](https://github.com/algorithm-visualizer/algorithms) | Algorithm catalog content |
| [algorithm-visualizer/server](https://github.com/algorithm-visualizer/server) | Legacy backend (Gist, compile APIs) |
| algorithm-visualizer/tracers.* | Per-language visualization libraries |

---

*Last updated: July 2026 — reflects v3 monorepo as the active development path.*

# QuantaXscan — Replit agent pointer

This file exists so the Replit agent has an entry point. It deliberately holds **no** project
facts of its own: it used to duplicate the stack, architecture tree, feature list, API routes,
database schema and command list, and every copy drifted out of date. Each of those facts has one
owner elsewhere in the repo — read the owner, and add new knowledge there, not here.

| Looking for | Read |
|---|---|
| What the product is, how to use it, how to run it locally, endpoint list, environment variables, repository layout, database tables, known limitations | [README.md](README.md) |
| Build/test/migration mechanics and sharp edges worth knowing before you touch the code | [AGENTS.md](AGENTS.md) |
| Strategy, roadmap, architecture, compliance mapping, editions, gap register | [docs/Claude/](docs/Claude/) — start at [its index](docs/Claude/README.md) |
| Docker build and deployment | [DOCKER.md](DOCKER.md) |
| Design tokens (colours, fonts, glow/border scales) | `artifacts/quantaxscan/src/index.css` — the `QuantaXscan Design Tokens` block is authoritative; the prose copy that used to live here had drifted to a superseded palette |

Replit-specific configuration lives in `.replit` and `.replitignore`, not in this file.

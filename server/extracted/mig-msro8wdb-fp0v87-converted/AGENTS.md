# Agent instructions

Navigation index for this repo. Rules in `.cursor/rules/` apply automatically; use skills and prompts for workflows.

## Stack

| Layer     | Technology                                          |
| --------- | --------------------------------------------------- |
| Framework | Angular 20, standalone, zone CD                     |
| State     | Signals (primary); NGXS in `store/` (legacy shared) |
| HTTP      | `HttpService` + interceptors                        |
| UI        | Material, Tailwind, SCSS                            |
| Auth      | `AuthenticationService`, cookies                    |
| API       | `environment.host`                                  |

## Documentation layers

| Layer                        | Location                                      | Unique content                                   |
| ---------------------------- | --------------------------------------------- | ------------------------------------------------ |
| Angular (standards + plugin) | `.cursor/rules/angular.mdc`                   | Architecture, lifecycle, state, UI, quality gate |
| Project context              | `.cursor/rules/project-context.mdc`           | Layers, aliases, guards, routing                 |
| TypeScript                   | `.cursor/rules/angular-typescript.mdc`        | Scaffold, lifecycle delegates, types, barrels    |
| Templates                    | `.cursor/rules/angular-templates.mdc`         | Forms F1–F7, `hasFormControlError`               |
| SCSS                         | `.cursor/rules/angular-scss.mdc`              | Paths, Tailwind preference                       |
| HTTP / NGXS                  | `.cursor/rules/ngxs-and-http.mdc`             | HttpService, NGXS CRUD, store cache              |
| Feature workflow             | `.cursor/skills/angular-feature-development/` | Step-by-step new feature                         |
| CLI MCP                      | `.cursor/skills/angular-cli-mcp/`             | MCP tool usage                                   |
| Manual QA                    | `.cursor/skills/manual-qa/`                   | List L1–L12, form F1–F7, routing R1–R5           |
| Prompts                      | `.cursor/prompts/*.md`                        | Task shells only                                 |

Plugin: [cursor.directory/plugins/angular](https://cursor.directory/plugins/angular) → `.cursor/rules/angular.mdc` (combined)

## Workflow

1. MCP: `list_projects` → `get_best_practices` (`angular.json`).
2. Rules apply automatically; read an existing file in the same feature before editing.
3. Minimal diff; no unrelated refactors.
4. `npm run lint` → `npm run build` → fix errors.
5. Auth/HTTP changes: run **manual-qa** skill for affected routes.

## Repository layout

```
src/app/
  app.ts, app.config.ts, app.routes.ts
  config/          → appSettings
  core/            → auth, guards, http, interceptors, layouts, services
  pages/           → auth | web | common (lazy *.routes.ts)
  shared/          → components, directives, pipes, validators, models
  store/           → NGXS
src/environments/  → host, encryption
public/scss/       → global partials
```

## Path aliases

`@app/*` `@core/*` `@pages/*` `@store/*` `@env/*` `@shared/*`

## Routing

- Lazy layout shells at root; feature children in `*.routes.ts`.
- `adminGuard` / `authGuard` — see `project-context.mdc`.
- Auth routes: set `title`.
- Resolvers, preloading, invalid query params → see `project-context.mdc` and **manual-qa** R1–R5.

## HTTP contract

- Features call `HttpService` only.
- Body: `result.response.data`, errors: `result.response.status.msg`.

## CLI

```bash
ng generate component pages/web/<area>/<name> --inline-style=false
ng generate service core/services/<name>
```

Project `carambola-kids` · prefix empty · SCSS · tests skipped by schematic.

## Commands

| Task  | Command         |
| ----- | --------------- |
| Dev   | `npm start`     |
| Build | `npm run build` |
| Lint  | `npm run lint`  |
| Test  | `npm test`      |

## Security

- No real secrets in repo; demo keys in `environment.ts` only.
- `EncryptionService` + cookies per existing auth flow.
- Sanitize dynamic HTML (`safeSanitize` pipe).

/**
 * Default / master prompts appended after the user's migration prompt.
 *
 * Priority order the AI must obey:
 *   1. USER PROMPT (titles, colors, scope, branding, copy)
 *   2. EXTRACTED BRANDING from uploaded project source (when the user did not override)
 *   3. Direction-specific rules below (anti-hallucination + structure)
 *   4. Source code — convert it; never invent missing APIs
 */

/** Shared preamble for every migration direction. */
export const NO_HALLUCINATION_PREAMBLE = `
## USER PROMPT FIRST, THEN SOURCE BRANDING

1. Follow the USER's migration prompt exactly. Their titles, colors, themes,
   branding, copy, and scope overrides win.
2. If the user did not override branding, EXTRACT name, colors, and fonts from
   the uploaded source (package.json name, index.html title, CSS/Tailwind tokens)
   and apply them in the converted app. Do not invent a generic "Angular Project" name
   or default blue unless the source actually uses them.
3. Do NOT invent npm packages, exports, modules, components, props, hooks,
   decorators, or APIs that do not exist in the real target framework / npm.
4. Do NOT invent files, routes, or features the user did not ask for and that
   are not present in (or required to convert) the source project.
5. If something in the source has no clean equivalent, rewrite it with plain
   target-framework primitives — never fake a package or module name.
6. Output must compile and run after npm install → ng serve / npm start.
   No dangling imports, placeholders like "// TODO implement", or truncated files.

### Where to read branding from the upload
- Name: package.json \`name\`, index.html \`<title>\`, root component title/meta
- Colors: tailwind.config.*, CSS/SCSS variables, :root tokens
- Fonts: index.html Google Fonts links, font-family in CSS, tailwind fontFamily

Apply extracted values to the converted project's index.html, tailwind config,
root component title, and package.json name. There is no starter-kit
app-settings.config.ts unless you create it because the source needs it.

---

## TARGET VERSIONS (applied automatically — all conversions)

Version selection rule:
1. If the USER PROMPT specifies an Angular or React version (e.g. "Angular 20",
   "React 18.3", "version 20" while Angular is the target) → use THAT version.
2. Otherwise use the latest stable defaults (currently Angular 22 / React 19).
   A UI-selected version is injected as [VERSION INSTRUCTION] and counts as (1).

The concrete pins are in the TARGET VERSION MANDATE block appended after this
prompt — obey THAT block for package.json and APIs. Do not invent a different major.

- Angular: standalone components + \`@angular/build\` when the target major supports
  them; prefer signals / \`inject()\` / \`@if\` \`@for\` when available on that major.
- React: Vite + TypeScript, functional components + hooks only.
  Automatic JSX runtime (no unused \`import React from 'react'\`).

## FOLDER STRUCTURE & CODE QUALITY (applied automatically)

### Styling (ALL conversions — mandatory)
- ALL styling uses **Tailwind CSS** utility classes in templates/JSX (\`class\` / \`className\`).
- ALL style files use **SCSS** (\`.scss\`) — never \`.css\` for component or global styles.
- Prefer Tailwind utilities over custom rules. Keep \`.scss\` files minimal (empty comment
  or a few \`@apply\` / nesting rules only when truly needed).
- Global entry: Angular \`src/styles.scss\`; React \`src/index.scss\` (with \`@tailwind\` layers).

### Angular structure
\`\`\`
src/
  main.ts
  index.html
  styles.scss
  environments/
  app/
    app.component.ts|html|scss
    app.config.ts
    app.routes.ts
    pages/          # every converted feature/page
    components/     # shared UI from the source
    services/       # services / hooks converted from the source
    lib/            # utils
\`\`\`
- One feature per folder. Matching \`.ts\` + \`.html\` + \`.scss\` triad per component.
- \`styleUrl: './name.component.scss'\` (never \`.css\`).
- \`standalone: true\` everywhere. \`providedIn: 'root'\` for app-wide services.
- Clear names, small focused components, no dead code, no unused imports.
- Strict typing; no \`any\` unless unavoidable. Public template API only
  (public/protected — never private in templates).
- Convert EVERY source feature. Do not keep a starter-kit tree. Do not drop
  pages to "auth + dashboard only" unless the user explicitly asks.

### React best structure
\`\`\`
src/
  main.tsx
  App.tsx
  App.scss
  index.scss
  components/     # shared presentational UI
  features/       # feature modules (auth/, dashboard/, …)
  pages/          # route-level screens (optional if features own routes)
  hooks/          # shared custom hooks
  lib/            # utils (cn, formatters)
  services/       # API clients
\`\`\`
- Entry is \`src/main.tsx\` → \`src/App.tsx\` (never Angular-style \`src/app/\`).
- Import \`./index.scss\` from main; component styles as \`.scss\` only.
- Feature-first folders; co-locate feature components with the feature.
- Typed props, pure presentational components where possible, hooks for state/
  side effects. No unused vars/imports. Prefer composition over giant files.
`;

/**
 * Angular → Angular (same framework): convert the full app.
 */
export const ANGULAR_TO_ANGULAR_PROMPT = `
## ANGULAR → ANGULAR COMPLETE CONVERSION (applied automatically)

Convert the FULL uploaded Angular project. Do not strip features.

- Keep every page, component, service, guard, interceptor, and route that exists in the source
  (unless the USER PROMPT explicitly asks to remove something).
- Preserve branding extracted from the source (name, colors, fonts, titles).
- Use standalone components, templateUrl/styleUrl triads, Tailwind in HTML, .scss style files.
- Final app MUST be runnable: npm install → ng serve
- Stay on real Angular APIs only. Do not invent packages.
`;

/** @deprecated Use ANGULAR_TO_ANGULAR_PROMPT — kept for older imports. */
export const DEFAULT_STRIP_DOWN_PROMPT = ANGULAR_TO_ANGULAR_PROMPT;

/**
 * React → React (same framework): convert the full app.
 */
export const REACT_TO_REACT_PROMPT = `
## REACT → REACT COMPLETE CONVERSION (applied automatically)

Convert the FULL uploaded React project. Do not strip features.

- Keep every page, component, hook, context, and route from the source
  (unless the USER PROMPT explicitly asks to remove something).
- Preserve branding extracted from the source.
- Functional components + hooks, Vite + TypeScript, Tailwind in JSX, .scss style files.
- Main entry: src/main.tsx → src/App.tsx.
- Final app MUST be runnable: npm install → npm start / vite
`;

/**
 * Generic cross-framework baseline (used with direction-specific prompts).
 */
export const DEFAULT_CROSS_FRAMEWORK_PROMPT = `
## CROSS-FRAMEWORK BASELINE (applied automatically)

Convert features to idiomatic target-framework code.
Convert the FULL source app — every page, component, route, and service.
Do NOT strip the project down to auth + dashboard unless the user explicitly asks.
USER MIGRATION MANDATE IS HIGHEST PRIORITY for titles, colors, theme, branding.
Do not keep source defaults when the user asked to change them.
Prefer official framework APIs and plain custom components over invented wrappers.
`;

/**
 * Angular → React anti-hallucination rules.
 */
export const ANGULAR_TO_REACT_PROMPT = `
## ANGULAR → REACT ANTI-HALLUCINATION RULES (applied automatically)

### Truthfulness
- NEVER invent npm packages or React APIs that do not exist.
- NEVER leave Angular artifacts in output: no @Component, @Injectable,
  templateUrl, styleUrl, NgModule, *ngIf, *ngFor, router-outlet, or .component.ts/.html.
- Services → plain TS modules, context, or hooks. Guards → protected route wrappers.
- DI inject() → props, context, or custom hooks. RxJS streams → hooks + fetch/promises
  (or keep rxjs only if already a real dependency and needed).

### Structure (Vite + React 19 + TypeScript)
- App entry: src/main.tsx boots src/App.tsx (NOT src/app/app.tsx).
- Use .tsx for any file that returns JSX (pages, components, layouts). Never put JSX in a .ts file — that causes TS1161 Unterminated regular expression literal.
- Utils, hooks, services, stores, and types stay .ts.
- Functional components + hooks only (React 19).
- Prefer folders: components/, features/, hooks/, lib/, services/, pages/.
- Routing: react-router-dom (BrowserRouter or createBrowserRouter).
- Do NOT generate angular.json, tsconfig.app.json, or Angular workspace files.
- High code quality: typed props, no unused imports, small focused modules.

### Icons & UI
- lucide-angular / @lucide/angular → lucide-react (real named exports: Home, Search).
- Do NOT invent @radix-ng/* or Angular CDK packages in React output.
- Map Angular inputs/outputs to React props and callbacks.
- class bindings / ngClass → className + cn() from a real utils helper if present.

### Consistency
- Every JSX identifier must be imported or defined. No orphan components.
- No empty handlers or stub "// implement later" for required UI the user asked for.
- Only real npm deps in package.json; skip @angular/* packages in the React app.

### Domain types & store (MANDATORY — copy source, do not invent)
- Copy \`models/*.ts\` field-for-field. If Task has \`status: 'todo' | 'in-progress' | 'done'\`,
  use those literals exactly. Never add fields the source model does not have
  (no \`priority\`, \`completed\`, \`dueDate\`). Never write \`in_progress\`.
- NGXS \`TaskState.items\` stays \`items\` on the zustand store. Pages may alias
  \`const { items: tasks } = useTaskStore()\`. Do not invent \`state.tasks\`.
- Import \`Task\` / \`TaskDraft\` / \`TaskStatus\` from \`models/task.model\` (the copied source
  file). Never invent \`types/task\`, \`interfaces/task\`, or \`services/task.service\`.
- \`useTaskStore\` must be a real \`create()\` export (or a barrel that re-exports that file).
  Do not emit \`export { useTaskStore } from './taskStore'\` unless \`taskStore.ts\` exists.

### Library mapping (MANDATORY)
- @ngxs/store → zustand. \`create((set, get) => ({ ... }))\`. No @State/@Action/dispatch(new X()).
  Export \`useXStore\` with the same CRUD methods. Selectors become \`useXStore((s) => s.field)\`.
- @angular/material → @mui/material (+ @emotion/react, @emotion/styled).
  MatSidenav → Drawer, MatDialog → Dialog, MatToolbar → AppBar+Toolbar,
  mat-icon → Icon, mat-button → Button, mat-icon-button → IconButton,
  mat-form-field → FormControl/TextField, mat-select → Select.
  MatDialog.open(Foo, { data }).afterClosed() → useState + \`<Foo open data onClose />\`.
  Dialog components take \`{ open, onClose, data }\` — never MatDialogRef / MAT_DIALOG_DATA.
- Angular template leftovers are forbidden in React: no mat-* tags, no (click)/[opened]/{{ }},
  no @if/@for, no app-* selectors, no @angular/* or @ngxs/* imports.
- lucide-angular / @lucide/angular → lucide-react.
`;

/**
 * React → Angular anti-hallucination rules.
 */
export const REACT_TO_ANGULAR_PROMPT = `
## REACT → ANGULAR ANTI-HALLUCINATION RULES (applied automatically)

### BRANDING EXTRACTION (MANDATORY — read uploaded source files)

Before generating code, READ the uploaded React project files and extract:

1. **Project Name**: From package.json name, index.html <title>, or meta tags
   → Apply to: index.html <title>, app.component.ts title, package.json name

2. **Colors**: From tailwind.config.js theme.colors or CSS variables
   → Apply to: tailwind.config.js (primary, secondary, tertiary colors)
   and the same tokens in converted templates

3. **Fonts**: From index.html Google Fonts link or CSS font-family
   → Apply to: index.html Google Fonts link, tailwind.config.js fontFamily

4. **Title/Branding text**: From meta tags, og:title, component titles
   → Apply to: All page titles and branding locations

Do NOT use default blue (#0788C0) or any hardcoded colors — use the EXTRACTED colors.
Do NOT use default project names — use the EXTRACTED name.

### Truthfulness
- NEVER invent npm packages (e.g. @radix-ng/*) or exports that are not real.
- NEVER copy React APIs into Angular templates or classes (no useState/useEffect
  in .ts components; no JSX in .html).
- If a Radix/shadcn primitive has no Angular equivalent, rewrite it as a plain
  standalone Angular component with @Input/@Output — do not fake a module.

### Lucide icons → plain inline SVG (REQUIRED — no lucide Angular package)
- EVERY \`lucide-react\` icon MUST become a **real inline \`<svg>\`** in Angular templates.
- FORBIDDEN packages in Angular output: \`@lucide/angular\`, \`lucide-angular\`, \`lucide-react\`,
  \`lucide\`. Do NOT add them to package.json. Do NOT import them.
- FORBIDDEN: \`LucideHome\` imports, \`<svg lucideHome>\` directives, \`[lucideIcon]\`,
  \`<lucide-home>\`, React \`<Home />\` component tags.
- REQUIRED conversion:
  React \`import { Home, LogOut } from 'lucide-react'\` + \`<Home className="w-4 h-4" />\`
  → Angular (no import) +
  \`\`\`html
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
       fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
       stroke-linejoin="round" class="w-4 h-4" aria-hidden="true">
    <!-- Lucide path children for that icon -->
  </svg>
  \`\`\`
- Copy the official Lucide SVG paths for each icon (stroke icons, viewBox 0 0 24 24,
  stroke="currentColor"). Preserve className → class. No Angular icon library.

### Angular quality
- Target the mandated Angular version APIs only (signals, inject(), standalone, @if/@for).
- Follow page-folder structure under src/app/pages plus components/services as needed.
- Strong typing; matching .ts/.html/.scss; Tailwind in templates; no hallucinated modules.
- Do NOT create app.module.ts — use standalone bootstrap (main.ts + app.config.ts).
- Always \`export const routes\` from app.routes.ts (never unexported \`const routes\`).
- Every template member (methods/fields) MUST exist on the class; keep .ts and .html in sync.
- Child selectors like \`<app-admin-shell>\` MUST be listed in the parent's \`imports\` array.

### Templates vs TypeScript consistency
- EVERY name in .html MUST exist on the class (public/protected field, @Input,
  @Output, or method). Generate matching .ts + .html + .scss triads (Tailwind in HTML).
- Do not put bare \`className\` / \`cn(...)\` in templates unless the class defines them.
  Prefer a \`mergedClass\` getter in .ts; or expose \`protected readonly cn = cn\`.
  NEVER put \`cn\` (or any plain function) in the \`@Component({ imports: [...] })\` array.
- NEVER leave \`(click)=""\`. NEVER use \`return\` / multi-statement JS in bindings —
  call one class method.
- NEVER use arrow functions (\`=>\`) or TypeScript casts (\`as Foo\`) in templates.
  Move filtering/mapping into class methods. For DOM values use \`$any($event.target).value\`.
- NEVER invent Angular APIs: no \`RenderFragment\`, no \`IconDefinition\`, no \`Input<T>\` as a
  property type (use \`@Input() name\` or \`input()\`), no \`Location.pathname\` (use
  \`Location.path()\` or \`Router.url\`).
- NEVER \`@import "tw-animate-css"\` (or other Tailwind v4-only CSS) into \`.scss\` —
  Angular Sass cannot parse \`@theme\` / \`@utility\` / \`@property\`. Use Tailwind utilities only.
- Icons: plain inline \`<svg>...</svg>\` only — never lucide packages or lucideXxx attributes.
- Child tags MUST match the child's \`selector\` (prefer \`app-*\`) and be listed in \`imports\`.
- No \`private\` members in templates. No field + getter with the same name.
- NEVER declare the same member twice (e.g. stub method \`onClick(...)\` AND
  \`@Input() onClick\`). One declaration only.
- NEVER \`prop: string = null\` / \`prop: number = null\` — use \`string | null\`,
  \`number | null\`, or a non-null default (\`''\`, \`0\`).
- Parent \`(onSave)="save($event)"\` requires the child \`@Output() onSave =
  new EventEmitter<...>()\` (not \`@Input()\`). Typed \`$event\` must match
  the handler parameter (not DOM \`Event\` unless it is a native DOM listener).
- Import HostListener / Input / Output / Component from '@angular/core' when used.
- CommonModule from '@angular/common' only (never from '@angular/core').
- Form errors: \`errors?.['required']\` bracket access.
- Well-formed HTML; no self-closing custom elements (\`<app-x></app-x>\`).
### Imports & routing
- \`@/\` → \`src/\`. Prefer relative imports under src/app/.
- Routes import each page from ITS OWN file — NEVER from './app.component'.
- app.component.ts is ONLY the root shell (usually router-outlet).
- No node:process / Node built-ins in browser app code.

### Libraries
- embla-carousel: default \`EmblaCarousel\` + \`EmblaOptionsType\` / \`EmblaCarouselType\`
  — NOT named Embla / EmblaOptions / EmblaApi.
- Skip @radix-ui/* React packages in Angular package.json.
`;

/**
 * Incremental migration blueprint prompt — instructs the AI to create an
 * ordered plan from leaf nodes (no dependencies) to root nodes.
 * Used for BOTH cross-framework conversion and same-framework conversion.
 */
export const INCREMENTAL_BLUEPRINT_PROMPT = `
## INCREMENTAL MIGRATION BLUEPRINT — DEPENDENCY ORDER (applied automatically)

You are creating an INCREMENTAL migration plan. Convert the FULL uploaded project.
The runtime writes one logical UNIT per AI call (Angular .ts+.html+.scss together).
Compile checks run periodically and again at the end — do not assume every unit
is built before the next one is planned.

### Ordering Rules (MANDATORY):
1. **Leaf nodes first**: Files with NO dependencies on other app files
   (utilities, types, constants, validators, pipes, pure functions)
2. **Simple shared UI**: Small presentational components with minimal imports
3. **Services / hooks**: Angular services, React hooks, API clients, stores
4. **Feature pages**: Forms, modals, layouts, auth pages, dashboard
5. **Root wiring last**: App shell, routing, bootstrap-related src files

### Logical units (MANDATORY):
- Angular component = ONE unit of three sibling paths listed BACK-TO-BACK in order:
  \`name.component.ts\`, then \`name.component.html\`, then \`name.component.scss\`
- React component = ONE unit: \`Name.tsx\` then optional companion \`Name.scss\`
- Services, pipes, utils, routes, configs-in-src = ONE file = ONE unit
- Never scatter a component triad across distant steps

### Output Format:
Return a JSON object with a single key "incrementalPlan" containing an array.
Each element is ONE file in the ordered plan (triad siblings listed consecutively):

\`\`\`json
{
  "incrementalPlan": [
    {
      "step": 1,
      "newPath": "src/lib/format.ts",
      "explanationOfSource": "Port utility (leaf — no app deps)",
      "approximateSourceFilesToRead": ["src/lib/format.ts"],
      "dependencies": [],
      "complexity": "low",
      "unit": "src/lib/format.ts"
    },
    {
      "step": 2,
      "newPath": "src/app/pages/admin-users/admin-users.component.ts",
      "explanationOfSource": "Admin users page TypeScript",
      "approximateSourceFilesToRead": ["src/routes/admin-users.tsx"],
      "dependencies": ["src/lib/format.ts"],
      "complexity": "high",
      "unit": "src/app/pages/admin-users/admin-users.component"
    },
    {
      "step": 3,
      "newPath": "src/app/pages/admin-users/admin-users.component.html",
      "explanationOfSource": "Admin users page template",
      "approximateSourceFilesToRead": ["src/routes/admin-users.tsx"],
      "dependencies": ["src/lib/format.ts"],
      "complexity": "high",
      "unit": "src/app/pages/admin-users/admin-users.component"
    },
    {
      "step": 4,
      "newPath": "src/app/pages/admin-users/admin-users.component.scss",
      "explanationOfSource": "Admin users page styles (minimal SCSS)",
      "approximateSourceFilesToRead": [],
      "dependencies": ["src/lib/format.ts"],
      "complexity": "low",
      "unit": "src/app/pages/admin-users/admin-users.component"
    }
  ]
}
\`\`\`

### Rules:
- **FIRST STEP**: Extract branding (name, colors, fonts) from uploaded project source files
- Prefer stubs/minimal wiring so each completed UNIT can compile before later units exist
  (e.g. routes may temporarily omit pages not yet migrated; expand routes when those units land)
- "dependencies" lists plan \`newPath\` values (or unit ids) that must exist before this file
- "unit" groups sibling files of one component; identical \`unit\` for triad members
- "complexity" must be one of: "low", "medium", "high"
- Include ALL needed app files for the FULL source project (not config: package.json, tsconfig, angular.json, vite.config)
- For Angular: always plan full .ts + .html + .scss triads with matching names
- For React: plan .tsx for pages/components (never .ts if the file has JSX) + optional .scss
- Convert every source feature. Do NOT omit pages unless the user explicitly asked to delete them.
- Cover every file required for a runnable result with the same functionality as the source
- Output ONLY raw JSON — no markdown, no explanation, no backticks
`;

/**
 * Returns the appropriate default prompt based on source → target frameworks.
 *
 * @param {string} fromTech - Source framework
 * @param {string} toTech   - Target framework
 * @returns {string} The default prompt to append after the user prompt
 */
export function getDefaultPrompt(fromTech, toTech) {
  const from = (fromTech || '').toLowerCase();
  const to = (toTech || '').toLowerCase();

  const isAngular = (s) => s.includes('angular');
  const isReact = (s) => s.includes('react');

  // Angular → Angular
  if (isAngular(from) && isAngular(to)) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${ANGULAR_TO_ANGULAR_PROMPT}`;
  }

  // React → React
  if (isReact(from) && isReact(to)) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${REACT_TO_REACT_PROMPT}`;
  }

  // React → Angular
  if (isReact(from) && isAngular(to)) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}\n${REACT_TO_ANGULAR_PROMPT}`;
  }

  // Angular → React
  if (isAngular(from) && isReact(to)) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}\n${ANGULAR_TO_REACT_PROMPT}`;
  }

  // Same unknown framework — do not invent an Angular strip-down.
  // fall back to no-hallucination + cross-framework baseline only.
  if (from && to && from === to) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}`;
  }

  return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}`;
}

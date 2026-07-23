/**
 * Default / master prompts appended after the user's migration prompt.
 *
 * Priority order the AI must obey:
 *   1. USER PROMPT (titles, colors, scope, branding, copy) — highest
 *   2. Direction-specific rules below (anti-hallucination + structure)
 *   3. Source code — only as material to convert; never invent missing APIs
 */

/** Shared preamble for every migration direction. */
export const NO_HALLUCINATION_PREAMBLE = `
## USER PROMPT FIRST — NO HALLUCINATION (applied automatically)

1. Follow the USER's migration prompt exactly. Their titles, colors, themes,
   branding, copy, and scope overrides are highest priority.
2. Do NOT invent npm packages, exports, modules, components, props, hooks,
   decorators, or APIs that do not exist in the real target framework / npm.
3. Do NOT invent files, routes, or features the user did not ask for and that
   are not present in (or required to convert) the source project.
4. If something in the source has no clean equivalent, rewrite it with plain
   target-framework primitives — never fake a package or module name.
5. Output must compile and run after npm install → ng serve / npm start.
   No dangling imports, placeholders like "// TODO implement", or truncated files.
`;

/**
 * Angular → Angular (same framework): strip down to auth + dashboard.
 */
export const ANGULAR_TO_ANGULAR_PROMPT = `
## ANGULAR → ANGULAR STRIP-DOWN (applied automatically)

STRIP DOWN THE PROJECT — KEEP ONLY AUTH + DASHBOARD:

### DELETE all components/files EXCEPT:
- Auth module/folder — login, registration, forgot password, OTP verification, password reset, etc.
- Dashboard component and its sub-components (charts, stats, widgets)
- Core app shell — App component, routing, main layout wrapper
- Shared services — auth service, HTTP interceptors, route guards, token storage
- Configuration files — package.json, angular.json, tsconfig.json, tsconfig.app.json, etc.
- Global styles — src/styles.css or similar

### REMOVE these pages/components ENTIRELY:
- Profile/settings/user-management (unless critical for auth flow)
- Listing/table/CRUD pages for books, products, users, items, etc.
- Blog, about, contact, landing, or marketing pages
- Admin-only pages (unless they are the dashboard itself)
- Demo, placeholder, template, or skeleton components
- Feature modules unrelated to auth or dashboard

### UPDATE routing:
- Login as default/landing route ('' or '/login')
- Registration and forgot-password as accessible routes
- Dashboard as post-login home ('/dashboard')
- Auth guard protecting dashboard and authenticated routes

### PRESERVE:
- npm dependencies in package.json (do not remove packages)
- Config files (angular.json, tsconfig.json, etc.)
- Shared services, guards, and interceptors that support auth

### Final app MUST be immediately runnable:
- npm install → ng serve
- Working login/register with validation
- Working dashboard after login
- No dangling imports, missing modules, or broken routing
- Delete unused component files — do not leave orphans
- Stay on real Angular APIs only (standalone components, CommonModule from
  @angular/common, Router from @angular/router). Do not invent packages.
`;

/** @deprecated Use ANGULAR_TO_ANGULAR_PROMPT — kept for older imports. */
export const DEFAULT_STRIP_DOWN_PROMPT = ANGULAR_TO_ANGULAR_PROMPT;

/**
 * React → React (same framework): strip down to auth + dashboard.
 */
export const REACT_TO_REACT_PROMPT = `
## REACT → REACT STRIP-DOWN (applied automatically)

STRIP DOWN THE PROJECT — KEEP ONLY AUTH + DASHBOARD:

### DELETE all components/files EXCEPT:
- Auth — login, registration, forgot password, OTP, password reset, etc.
- Dashboard and its sub-components (charts, stats, widgets)
- Core app shell — App, router setup, main layout
- Shared logic — auth context/hooks, API client, route guards/protected routes
- Configuration — package.json, vite.config / next config, tsconfig, etc.
- Global styles

### REMOVE entirely:
- Profile/settings/user-management (unless critical for auth)
- CRUD/listing pages, blog, about, contact, landing, marketing
- Admin-only pages (unless they are the dashboard)
- Demo / placeholder / skeleton components
- Features unrelated to auth or dashboard

### UPDATE routing:
- Login as default route
- Register + forgot-password accessible
- Dashboard as post-login home
- Protected route wrapper for authenticated pages

### PRESERVE:
- package.json dependencies (do not strip packages arbitrarily)
- Build/config files
- Auth-related hooks, context, and API helpers

### Final app MUST be immediately runnable:
- npm install → npm start / vite
- Working login/register + dashboard
- Functional React only: function components + hooks. No Angular leftovers
  (@Component, templateUrl, NgModule). No invented packages.
- Main entry: src/App.tsx (not src/app/app.tsx). Delete unused files.
`;

/**
 * Generic cross-framework baseline (used with direction-specific prompts).
 */
export const DEFAULT_CROSS_FRAMEWORK_PROMPT = `
## CROSS-FRAMEWORK BASELINE (applied automatically)

Convert features to idiomatic target-framework code.
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

### Structure (Vite + React + TypeScript)
- App entry: src/main.tsx boots src/App.tsx (NOT src/app/app.tsx).
- Use .tsx for components. Functional components + hooks only.
- Routing: react-router-dom (BrowserRouter, Routes, Route, Navigate, Link).
- Do NOT generate angular.json, tsconfig.app.json, or Angular workspace files.

### Icons & UI
- lucide-angular / @lucide/angular → lucide-react (real named exports: Home, Search).
- Do NOT invent @radix-ng/* or Angular CDK packages in React output.
- Map Angular inputs/outputs to React props and callbacks.
- class bindings / ngClass → className + cn() from a real utils helper if present.

### Consistency
- Every JSX identifier must be imported or defined. No orphan components.
- No empty handlers or stub "// implement later" for required UI the user asked for.
- Only real npm deps in package.json; skip @angular/* packages in the React app.
`;

/**
 * React → Angular anti-hallucination rules.
 */
export const REACT_TO_ANGULAR_PROMPT = `
## REACT → ANGULAR ANTI-HALLUCINATION RULES (applied automatically)

### Truthfulness
- NEVER invent npm packages (e.g. @radix-ng/*) or exports that are not real.
- NEVER copy React APIs into Angular templates or classes (no useState/useEffect
  in .ts components; no JSX in .html).
- If a Radix/shadcn primitive has no Angular equivalent, rewrite it as a plain
  standalone Angular component with @Input/@Output — do not fake a module.

### @lucide/angular (Angular 20) — REQUIRED pattern
- Package is \`@lucide/angular\` (NOT legacy \`lucide-angular\`, NOT \`lucide-react\`).
- FORBIDDEN: LucideIconModule, LucideAngularModule, LucideAngularComponent (legacy).
- CORRECT static: import \`LucideHome\`, \`LucideSearch\`, etc., list in \`imports\`,
  render \`<svg lucideHome></svg>\`.
- CORRECT dynamic: \`LucideIcon\` + \`provideLucideIcons(LucideHome, …)\` and
  \`<svg [lucideIcon]="'home'"></svg>\`.
- Map lucide-react names: Home → LucideHome.

### Templates vs TypeScript consistency
- EVERY name in .html MUST exist on the class (public/protected field, @Input,
  @Output, or method). Generate matching .ts + .html + .css triads.
- Do not put bare \`className\` / \`cn(...)\` in templates unless the class defines them.
  Prefer a \`mergedClass\` getter in .ts; or expose \`protected readonly cn = cn\`.
- NEVER leave \`(click)=""\`. NEVER use \`return\` / multi-statement JS in bindings —
  call one class method.
- No \`private\` members in templates. No field + getter with the same name.
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

  // Same unknown framework — generic strip-down via Angular text is wrong;
  // fall back to no-hallucination + cross-framework baseline only.
  if (from && to && from === to) {
    return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}`;
  }

  return `${NO_HALLUCINATION_PREAMBLE}\n${DEFAULT_CROSS_FRAMEWORK_PROMPT}`;
}

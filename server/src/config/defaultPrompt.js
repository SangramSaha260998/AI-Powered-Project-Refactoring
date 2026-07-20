/**
 * Default system prompt for same-framework (Angular→Angular) migrations.
 *
 * This prompt is automatically appended to the user's migration prompt
 * when the source and target frameworks are the same. It tells the AI
 * to STRIP DOWN the project to only auth + dashboard functionality.
 *
 * You can customize this file to change the default behavior.
 */
export const DEFAULT_STRIP_DOWN_PROMPT = `
## DEFAULT STRIP-DOWN INSTRUCTIONS (applied automatically)

STRIP DOWN THE PROJECT — KEEP ONLY AUTH + DASHBOARD:

### DELETE all components/files EXCEPT:
- Auth module/folder — login, registration, forgot password, OTP verification, password reset, etc.
- Dashboard component and its sub-components (charts, stats, widgets)
- Core app shell — App component, routing module, main layout wrapper
- Shared services — auth service, HTTP interceptors, route guards, token storage
- Configuration files — package.json, angular.json, tsconfig.json, tsconfig.app.json, etc.
- Global styles — src/styles.css or similar

### REMOVE these pages/components ENTIRELY:
- Any profile/settings/user-management pages (unless critical for auth flow)
- Any listing/table/CRUD pages for entities like books, products, users, items, etc.
- Any blog, about, contact, landing, or marketing pages
- Any admin-only pages (unless they are the dashboard itself)
- Any demo, placeholder, template, or skeleton components
- Any feature modules unrelated to auth or dashboard

### UPDATE routing so the app boots with:
- Login page as the default/landing route (e.g., '' or '/login')
- Registration and forgot-password as accessible routes
- Dashboard as the post-login home route (e.g., '/dashboard')
- Auth guard protecting dashboard and any authenticated routes

### PRESERVE:
- All npm dependencies in package.json (do not remove packages)
- All configuration files (angular.json, tsconfig.json, etc.)
- All shared services, guards, and interceptors that support auth flow

### Final app MUST be immediately runnable:
- npm install → ng serve (or npm start)
- Working login/register flow with validation
- Working dashboard page visible after login
- No dangling imports, missing modules, or broken routing

CRITICAL: The output should be a fully functional Angular application that compiles and runs without errors. Delete unused component files from the file system — do not leave orphaned files behind.
`;

/**
 * Default prompt for cross-framework migrations (e.g., Angular→React).
 * This is a generic fallback when frameworks differ.
 */
export const DEFAULT_CROSS_FRAMEWORK_PROMPT = `
## DEFAULT INSTRUCTIONS (applied automatically)

NOTE: If you are migrating between different frameworks, convert all components
appropriately. Keep the architecture clean and follow best practices for the
target framework. The app must be fully runnable after migration.
`;

/**
 * Returns the appropriate default prompt based on whether frameworks match.
 *
 * @param {string} fromTech - Source framework
 * @param {string} toTech   - Target framework
 * @returns {string} The default prompt to append
 */
export function getDefaultPrompt(fromTech, toTech) {
  const from = (fromTech || '').toLowerCase();
  const to = (toTech || '').toLowerCase();

  // Same-framework → strip down mode
  if (from === to) {
    return DEFAULT_STRIP_DOWN_PROMPT;
  }

  // Cross-framework → standard migration
  return DEFAULT_CROSS_FRAMEWORK_PROMPT;
}

/**
 * Priority rules that define the decision hierarchy for a migration.
 *
 * These rules are injected into the AI blueprint prompt so the model has an
 * explicit "source of truth" for each aspect of the migration — matching the
 * ChatGPT workflow recommendation:
 *
 *   React project        → source of truth for functionality, UI appearance, page structure
 *   Angular reference    → source of truth for architecture, coding conventions,
 *                          shared components, services/interceptors, styling, routing
 *
 * The user can override these via the UI (priorityRules selector) or by
 * writing custom rules in their prompt.
 */

/**
 * Default priority rules when the user does not override them.
 * `react` = the uploaded source project; `angular` = the reference project.
 */
export const DEFAULT_PRIORITY_RULES = {
  sourceOfTruth: {
    functionality: 'react',
    uiAppearance: 'react',
    pageStructure: 'react',
    architecture: 'angular',
    codingConventions: 'angular',
    sharedComponents: 'angular',
    servicesInterceptors: 'angular',
    stylingConventions: 'angular',
    routingPatterns: 'angular',
  },
  invariants: [
    'Do not change business behavior',
    'Do not redesign UI',
    'Reuse existing Angular shared components where applicable',
    'Do not duplicate existing Angular services/components',
    'Preserve API behavior',
    'Preserve validation behavior',
    'Preserve loading/error/empty states',
    'Preserve responsive behavior',
  ],
};

/**
 * Alternative rule set: the Angular reference project is the source of truth
 * for UI appearance too (reference UI wins over the React source).
 */
export const ANGULAR_UI_PRIORITY_RULES = {
  sourceOfTruth: {
    functionality: 'react',
    uiAppearance: 'angular',
    pageStructure: 'angular',
    architecture: 'angular',
    codingConventions: 'angular',
    sharedComponents: 'angular',
    servicesInterceptors: 'angular',
    stylingConventions: 'angular',
    routingPatterns: 'angular',
  },
  invariants: [
    'Do not change business behavior',
    'Use the Angular reference project UI as the visual source of truth',
    'Reuse existing Angular shared components where applicable',
    'Do not duplicate existing Angular services/components',
    'Preserve API behavior',
    'Preserve validation behavior',
    'Preserve loading/error/empty states',
    'Preserve responsive behavior',
  ],
};

/**
 * Returns the priority rules for a given mode key.
 * @param {string} mode - 'react-ui' (default) | 'angular-ui' | 'custom'
 * @param {object} [customRules] - Custom rules object when mode === 'custom'
 */
export function getPriorityRules(mode = 'react-ui', customRules = null) {
  if (mode === 'angular-ui') return ANGULAR_UI_PRIORITY_RULES;
  if (mode === 'custom' && customRules && typeof customRules === 'object') {
    return {
      sourceOfTruth: {
        ...DEFAULT_PRIORITY_RULES.sourceOfTruth,
        ...(customRules.sourceOfTruth || {}),
      },
      invariants: Array.isArray(customRules.invariants)
        ? customRules.invariants
        : DEFAULT_PRIORITY_RULES.invariants,
    };
  }
  return DEFAULT_PRIORITY_RULES;
}

/**
 * Renders the priority rules as a prompt block the AI can follow.
 * @param {object} rules - Priority rules object
 * @returns {string}
 */
export function formatPriorityRulesPrompt(rules) {
  const r = rules || DEFAULT_PRIORITY_RULES;
  const lines = [
    '## PRIORITY RULES — DECISION HIERARCHY (MANDATORY)',
    '',
    'The following defines which project is the source of truth for each aspect:',
    '',
  ];
  for (const [aspect, source] of Object.entries(r.sourceOfTruth || {})) {
    const label = aspect
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase());
    lines.push(`- ${label}: ${source === 'react' ? 'React source project' : 'Angular reference project'}`);
  }
  lines.push('');
  lines.push('INVARIANTS (never violate):');
  for (const inv of r.invariants || []) {
    lines.push(`- ${inv}`);
  }
  lines.push('');
  return lines.join('\n');
}
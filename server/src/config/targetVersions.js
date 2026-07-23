/**
 * Target framework version resolution for migrations.
 *
 * Rule (all conversion directions):
 *   1. If the USER PROMPT names a specific Angular/React version → use it
 *   2. Otherwise → latest stable defaults below
 */

/** Latest stable pins (update when bumping defaults). */
export const LATEST_ANGULAR = {
  major: 22,
  core: '22.0.8',
  tooling: '22.0.7',
  typescript: '~6.0.3',
  zone: '~0.16.0'
};

export const LATEST_REACT = {
  major: 19,
  react: '19.2.8',
  typesReact: '19.2.17',
  typesReactDom: '19.2.3',
  vite: '8.1.5',
  pluginReact: '6.0.4',
  typescript: '~5.9.2'
};

/** Known major → compatible toolchain (best-effort for user-requested majors). */
const ANGULAR_BY_MAJOR = {
  22: { ...LATEST_ANGULAR },
  21: {
    major: 21,
    core: '21.2.18',
    tooling: '21.2.12',
    typescript: '~5.9.2',
    zone: '~0.15.0'
  },
  20: {
    major: 20,
    core: '20.3.9',
    tooling: '20.3.16',
    typescript: '~5.9.2',
    zone: '~0.15.0'
  },
  19: {
    major: 19,
    core: '19.2.14',
    tooling: '19.2.15',
    typescript: '~5.7.2',
    zone: '~0.15.0'
  },
  18: {
    major: 18,
    core: '18.2.13',
    tooling: '18.2.12',
    typescript: '~5.5.4',
    zone: '~0.14.10'
  }
};

const REACT_BY_MAJOR = {
  19: { ...LATEST_REACT },
  18: {
    major: 18,
    react: '18.3.1',
    typesReact: '18.3.18',
    typesReactDom: '18.3.5',
    vite: '6.4.3',
    pluginReact: '4.7.0',
    typescript: '~5.6.3'
  },
  17: {
    major: 17,
    react: '17.0.2',
    typesReact: '17.0.83',
    typesReactDom: '17.0.26',
    vite: '5.4.11',
    pluginReact: '4.3.4',
    typescript: '~5.4.5'
  }
};

const ANGULAR_MAJOR_MIN = 15;
const ANGULAR_MAJOR_MAX = 22;
const REACT_MAJOR_MIN = 16;
const REACT_MAJOR_MAX = 19;

function isPlausibleMajor(framework, major) {
  if (!Number.isFinite(major) || major < 1) return false;
  if (framework === 'angular') return major >= ANGULAR_MAJOR_MIN && major <= ANGULAR_MAJOR_MAX;
  if (framework === 'react') return major >= REACT_MAJOR_MIN && major <= REACT_MAJOR_MAX;
  return major >= 1 && major <= 30;
}

function buildParsed(major, minor, patch) {
  const full =
    minor != null && patch != null
      ? `${major}.${minor}.${patch}`
      : minor != null
        ? `${major}.${minor}.0`
        : null;
  return { major, full };
}

/**
 * Parse a version mention from free text for a given framework keyword.
 * Examples: "Angular 19", "angular v20.3", "React 18.3.1", "version 20" (when targeting Angular)
 *
 * @param {string} text
 * @param {'angular'|'react'} framework
 * @param {{ toTech?: string }} [options]
 * @returns {{ major: number, full: string|null } | null}
 */
export function parseFrameworkVersionFromPrompt(text, framework, options = {}) {
  if (!text || typeof text !== 'string') return null;
  const fw = framework.toLowerCase();
  const to = (options.toTech || '').toLowerCase();
  const targetingThis = to.includes(fw);

  const patterns = [
    // angular 19.2.8 / angular - 20 / angular:20 / Angular20 / angular v20
    new RegExp(
      `\\b${fw}\\s*[-:]?\\s*(?:version|ver|v)?\\s*[:=]?\\s*v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?\\b`,
      'i'
    ),
    // glued: angular20 / react18
    new RegExp(`\\b${fw}(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?\\b`, 'i'),
    // @angular/core ^19 / react@18.3.1
    new RegExp(
      fw === 'angular'
        ? /@angular\/(?:core|cli)\s*[:=]?\s*['"]?\^?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i
        : /(?:react-dom|react)\s*@\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i
    ),
    // convert/migrate/target/... to|into|in angular 20
    new RegExp(
      `(?:convert|migrate|upgrade|downgrade|target|use|using|on|with|to|into|in)\\s+(?:to\\s+|into\\s+|in\\s+)?${fw}\\s*[-:]?\\s*(?:version\\s+)?v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?\\b`,
      'i'
    )
  ];

  // When the UI target is this framework, also accept bare version phrases:
  // "version 20", "ver 20", "v20", "use 20.3"
  if (targetingThis) {
    patterns.push(
      /\b(?:version|ver)\s*[:=]?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/i,
      /\bv(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/i,
      /(?:use|using|target|to|into|on)\s+v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\b/i
    );
  }

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const major = Number(m[1]);
    if (!isPlausibleMajor(fw, major)) continue;
    const minor = m[2] != null ? Number(m[2]) : null;
    const patch = m[3] != null ? Number(m[3]) : null;
    return buildParsed(major, minor, patch);
  }
  return null;
}

function resolveAngularStack(parsed) {
  if (!parsed) {
    return { ...LATEST_ANGULAR, source: 'latest', requested: null };
  }
  const base = ANGULAR_BY_MAJOR[parsed.major] || {
    major: parsed.major,
    core: parsed.full || `${parsed.major}.0.0`,
    tooling: parsed.full || `${parsed.major}.0.0`,
    typescript: parsed.major >= 22 ? '~6.0.3' : parsed.major >= 20 ? '~5.9.2' : '~5.7.2',
    zone: parsed.major >= 22 ? '~0.16.0' : parsed.major >= 19 ? '~0.15.0' : '~0.14.10'
  };
  return {
    major: parsed.major,
    core: parsed.full || base.core,
    tooling: base.tooling,
    typescript: base.typescript,
    zone: base.zone,
    source: 'user-prompt',
    requested: parsed.full || String(parsed.major)
  };
}

function resolveReactStack(parsed) {
  if (!parsed) {
    return { ...LATEST_REACT, source: 'latest', requested: null };
  }
  const base = REACT_BY_MAJOR[parsed.major] || {
    major: parsed.major,
    react: parsed.full || `${parsed.major}.0.0`,
    typesReact: `${parsed.major}.0.0`,
    typesReactDom: `${parsed.major}.0.0`,
    vite: parsed.major >= 19 ? '8.1.5' : '6.4.3',
    pluginReact: parsed.major >= 19 ? '6.0.4' : '4.7.0',
    typescript: '~5.6.3'
  };
  const react = parsed.full || base.react;
  return {
    major: parsed.major,
    react,
    typesReact: REACT_BY_MAJOR[parsed.major] && !parsed.full ? base.typesReact : `${parsed.major}.0.0`,
    typesReactDom: REACT_BY_MAJOR[parsed.major] && !parsed.full ? base.typesReactDom : `${parsed.major}.0.0`,
    vite: base.vite,
    pluginReact: base.pluginReact,
    typescript: base.typescript,
    source: 'user-prompt',
    requested: parsed.full || String(parsed.major)
  };
}

/**
 * Resolve Angular + React stacks from the user prompt and target framework.
 *
 * @param {string} userPrompt
 * @param {string} toTech
 */
export function resolveTargetVersions(userPrompt, toTech) {
  const to = (toTech || '').toLowerCase();
  const angularParsed = parseFrameworkVersionFromPrompt(userPrompt, 'angular', { toTech });
  const reactParsed = parseFrameworkVersionFromPrompt(userPrompt, 'react', { toTech });

  const wantAngular = to.includes('angular') || (!to && !!angularParsed);
  const wantReact = to.includes('react') || (!to && !!reactParsed);

  return {
    angular: resolveAngularStack(wantAngular ? angularParsed : null),
    react: resolveReactStack(wantReact ? reactParsed : null),
    target: to.includes('angular') ? 'angular' : to.includes('react') ? 'react' : 'unknown'
  };
}

/**
 * Human-readable mandate block appended into the AI prompt.
 * This is the ONLY place that states the concrete version pins.
 */
export function formatVersionMandate(resolved) {
  const { angular, react, target } = resolved;
  const lines = [
    '## TARGET VERSION MANDATE (HIGHEST PRIORITY FOR VERSIONS)',
    '',
    'Version selection rule for ALL conversions:',
    '1. If the USER PROMPT specifies an Angular or React version → use EXACTLY that version.',
    '2. Otherwise → use the latest stable version pinned below.',
    'Do NOT upgrade/downgrade away from these pins. Do NOT write a different major into package.json.',
    ''
  ];

  if (target === 'angular' || target === 'unknown') {
    lines.push(
      `- REQUIRED Angular version: **${angular.core}**` +
        (angular.source === 'user-prompt'
          ? ` (requested in user prompt: ${angular.requested})`
          : ' (latest stable — user did not specify a version)'),
      `  package.json must use @angular/* ^${angular.core}, @angular/cli|^build ^${angular.tooling}, typescript ${angular.typescript}, zone.js ${angular.zone}`
    );
  }
  if (target === 'react' || target === 'unknown') {
    lines.push(
      `- REQUIRED React version: **${react.react}**` +
        (react.source === 'user-prompt'
          ? ` (requested in user prompt: ${react.requested})`
          : ' (latest stable — user did not specify a version)'),
      `  package.json must use react/react-dom ^${react.react}, Vite ^${react.vite}, @types/react ^${react.typesReact}`
    );
  }

  return lines.join('\n');
}

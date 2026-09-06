import assert from 'node:assert/strict';
import {
  applyMigrationScope,
  findLandingSeedFiles,
  filterFilesMapToLandingScope,
  isLandingFirstScope,
  normalizeMigrationScope,
} from '../src/services/migrationScope.js';

assert.equal(normalizeMigrationScope('landing-first'), 'landing-first');
assert.equal(normalizeMigrationScope('phase1'), 'landing-first');
assert.equal(normalizeMigrationScope('full'), 'full');
assert.ok(isLandingFirstScope('landing-only'));

const filesMap = {
  'src/main.tsx': `import App from './App';`,
  'src/App.tsx': `import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import Dashboard from './pages/Dashboard';
export default function App() {
  return <Routes><Route path="/" element={<Home />} /><Route path="/dashboard" element={<Dashboard />} /></Routes>;
}`,
  'src/pages/Home.tsx': `import { Hero } from '../components/Hero';
export default function Home() { return <Hero />; }`,
  'src/pages/Dashboard.tsx': `export default function Dashboard() { return <div>Admin</div>; }`,
  'src/components/Hero.tsx': `export function Hero() { return <section>Welcome</section>; }`,
  'src/components/AdminChart.tsx': `export function AdminChart() { return <div />; }`,
};

const analysis = {
  routes: [{ path: '/', file: 'src/App.tsx' }],
  dependencyGraph: {
    edges: [
      { from: 'src/App.tsx', to: 'src/pages/Home.tsx' },
      { from: 'src/App.tsx', to: 'src/pages/Dashboard.tsx' },
      { from: 'src/pages/Home.tsx', to: 'src/components/Hero.tsx' },
      { from: 'src/pages/Dashboard.tsx', to: 'src/components/AdminChart.tsx' },
    ],
  },
};

const seeds = findLandingSeedFiles(filesMap, analysis);
assert.ok(seeds.includes('src/pages/Home.tsx'));

const scoped = filterFilesMapToLandingScope(filesMap, analysis);
assert.ok(scoped['src/pages/Home.tsx']);
assert.ok(scoped['src/components/Hero.tsx']);
assert.ok(scoped['src/main.tsx']);
assert.ok(scoped['src/App.tsx']);
assert.equal(scoped['src/pages/Dashboard.tsx'], undefined);
assert.equal(scoped['src/components/AdminChart.tsx'], undefined);

const applied = applyMigrationScope(filesMap, analysis, 'landing-first');
assert.equal(Object.keys(applied.filesMap).length, Object.keys(scoped).length);

console.log('migrationScope.mjs: all assertions passed');

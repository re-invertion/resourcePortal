#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const BASELINE = new URL('../docs/testing/baseline-inventory.json', import.meta.url);
const MIGRATIONS = new URL('../config/test-migrations.json', import.meta.url);

const domains = [
  ['packages/resourceportal-api/src/networking/', 'networking'],
  ['packages/resourceportal-api/src/network-egress/', 'networking'],
  ['packages/resourceportal-api/src/mcp/', 'mcp'],
  ['packages/resourceportal-api/src/auth/', 'identity'],
  ['packages/resourceportal-api/src/identity-providers/', 'identity'],
  ['packages/resourceportal-api/src/oauth-applications/', 'identity'],
  ['packages/resourceportal-api/src/service-identities/', 'identity'],
  ['packages/resourceportal-api/src/security/', 'security'],
  ['packages/resourceportal-api/src/prisma/', 'database'],
  ['packages/resourceportal-api/src/migrations/', 'database'],
  ['packages/resourceportal-api/src/domains/', 'domains'],
  ['packages/resourceportal-api/src/platform-dns/', 'domains'],
  ['packages/resourceportal-api/src/storage', 'storage'],
  ['packages/resourceportal-api/src/volumes/', 'storage'],
  ['packages/resourceportal-api/src/app-groups/', 'applications'],
  ['packages/resourceportal-api/src/platform-', 'platform'],
  ['packages/resourceportal-api/src/operations/', 'operations'],
  ['packages/resourceportal-api/src/bug-reports/', 'bug-reports'],
  ['packages/resourceportal-api/src/billing/', 'billing'],
  ['packages/resourceportal-api/src/tenants/', 'tenants'],
  ['packages/resourceportal-api/src/audit/', 'audit'],
  ['packages/resourceportal-api/src/capacity/', 'capacity'],
  ['packages/resourceportal-api/src/disaster-recovery/', 'recovery'],
  ['packages/resourceportal-api/src/observability/', 'observability'],
  ['packages/resourceportal-api/src/users/', 'users'],
  ['packages/resourceportal-api/', 'api-other'],
  ['packages/resourceportal-web/src/security/', 'security'],
  ['packages/resourceportal-web/', 'web'],
  ['packages/resourceportal-sdk/', 'sdk'],
  ['packages/resourceportal-cli/', 'cli'],
  ['packages/resourceportal-help/', 'help'],
  ['test/installer/', 'installer'],
  ['test/cli/', 'cli'],
  ['test/federation/', 'identity'],
  ['test/', 'tooling'],
  ['scripts/', 'system-scripts'],
];

export function domainFor(path) {
  return domains.find(([prefix]) => path.startsWith(prefix))?.[1] ?? 'unclassified';
}
export function levelFor(path) {
  if (path.startsWith('test/installer/')) return 'contract';
  if (path.startsWith('test/cli/')) return 'packaging';
  if (path.startsWith('test/federation/')) return 'e2e';
  if (path.startsWith('scripts/')) return 'system';
  if (path.includes('/src/pages/') || path.includes('/src/components/')) return 'component';
  return 'unit';
}
export function listTests(root='.') {
  const roots=['packages/resourceportal-api','packages/resourceportal-web','packages/resourceportal-sdk','packages/resourceportal-cli','packages/resourceportal-help','test','scripts'];
  const files=[];
  const walk=(dir)=>{
    for(const ent of readdirSync(dir,{withFileTypes:true})){
      if(['node_modules','dist','.git','coverage'].includes(ent.name))continue;
      const path=join(dir,ent.name);
      if(ent.isDirectory())walk(path);
      else if(ent.isFile() && (/\.(spec|test)\./.test(ent.name) || /^test-.*\.sh$/.test(ent.name)))
        files.push(relative(root,path).split(sep).join('/'));
    }
  };
  for(const folder of roots)if(existsSync(join(root,folder)))walk(join(root,folder));
  return files.sort();
}
export function validateBaseline(baselinePaths,actualPaths,migrations={}) {
  const missing=baselinePaths.filter(p=>!actualPaths.includes(p)&&!(
    typeof migrations[p]==='string'&&actualPaths.includes(migrations[p])&&!baselinePaths.includes(migrations[p])
  ));
  const unknown=actualPaths.filter(p=>domainFor(p)==='unclassified');
  const invalidMigrations=Object.entries(migrations)
    .filter(([from,to])=>!baselinePaths.includes(from)||typeof to!=='string'||!actualPaths.includes(to)||actualPaths.includes(from))
    .map(([from])=>from);
  return {missing,unknown,invalidMigrations};
}
export function collectMatrix(paths) {
  const matrix={};
  for(const path of paths) {
    const domain=domainFor(path),level=levelFor(path);
    matrix[domain]??={};
    matrix[domain][level]=(matrix[domain][level]||0)+1;
  }
  return matrix;
}
if(process.argv[1]?.endsWith('test-catalog.mjs')) {
  const baseline=JSON.parse(readFileSync(BASELINE,'utf8'));
  const migrations=JSON.parse(readFileSync(MIGRATIONS,'utf8')).moves;
  const actual=listTests();
  const {missing,unknown,invalidMigrations}=validateBaseline(baseline.tests.map(t=>t.path),actual,migrations);
  const report={total:actual.length,added:actual.length-baseline.tests.length+missing.length,
    baselineMissing:missing,unclassified:unknown,invalidMigrations,domains:collectMatrix(actual)};
  console.log(JSON.stringify(report,null,2));
  if(missing.length||unknown.length||invalidMigrations.length)process.exitCode=1;
}

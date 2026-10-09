#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { domainFor, levelFor, listTests } from './test-catalog.mjs';

const workspaces = new Map([
  ['packages/resourceportal-api/', '@resource-portal/api'],
  ['packages/resourceportal-web/', '@resource-portal/web'],
  ['packages/resourceportal-sdk/', '@resource-portal/sdk'],
  ['packages/resourceportal-cli/', '@resource-portal/cli'],
  ['packages/resourceportal-help/', '@resource-portal/help'],
]);

export function selectionPlan(paths, {domain, level}={}) {
  const selected=paths.filter(path=>(!domain||domainFor(path)===domain)&&(!level||levelFor(path)===level));
  const buckets=new Map();
  for(const path of selected) {
    const entry=[...workspaces].find(([prefix])=>path.startsWith(prefix));
    if(entry){
      const [prefix,workspace]=entry;
      if(!buckets.has(workspace))buckets.set(workspace,[]);
      buckets.get(workspace).push(path.slice(prefix.length));
    }else if(path.endsWith('.sh')) {
      if(!buckets.has('bash'))buckets.set('bash',[]);
      buckets.get('bash').push(path);
    }else if(path.endsWith('.mjs')||path.endsWith('.js')){
      if(!buckets.has('node'))buckets.set('node',[]);
      buckets.get('node').push(path);
    }else {
      throw new Error('No runner for '+path);
    }
  }
  const commands=[];
  for(const [workspace,files] of buckets){
    if(workspace==='bash')for(const file of files)commands.push(['bash',file]);
    else if(workspace==='node')commands.push(['node','--test',...files]);
    else commands.push(['npm','--workspace',workspace,'test','--',...files]);
  }
  return {paths:selected,commands};
}

if(process.argv[1]?.endsWith('test-selection.mjs')){
  const args=process.argv.slice(2);
  const option=(name)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  const domain=option('--domain'),level=option('--level');
  if(!domain&&!level){console.error('Require --domain or --level to avoid accidental full suite');process.exit(2);}
  const plan=selectionPlan(listTests(),{domain,level});
  if(plan.paths.length===0){console.error('No matching tests; cannot report success');process.exit(2);}
  console.log(JSON.stringify({count:plan.paths.length,commands:plan.commands},null,2));
  if(args.includes('--run')){
    for(const command of plan.commands){
      const r=spawnSync(command[0],command.slice(1),{stdio:'inherit',env:process.env});
      if(r.status!==0){process.exit(r.status||1);}
    }
  }
}

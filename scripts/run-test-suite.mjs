#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const config=JSON.parse(readFileSync(new URL('../config/test-suites.json', import.meta.url),'utf8'));
const args=process.argv.slice(2);
const option=(name)=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const level=option('--level'), domain=option('--domain'), single=option('--suite');
const selected=config.suites.filter(s=>(!level||s.level===level)&&(!domain||s.domain===domain)&&(!single||s.id===single));
if(selected.length===0){
  console.error('No matching test suite');
  process.exitCode=2;
}else if(args.includes('--list')||args.length===0){
  console.log(selected.map(s=>[s.id,s.level,s.domain,s.environment,s.command.join(' ')].join('\t')).join('\n'));
}else{
  for(const suite of selected){
    if(suite.environment==='workflow'&&!args.includes('--allow-workflow-only')){
      console.error('Suite '+suite.id+' requires provisioned environment: '+suite.workflow);
      process.exitCode=2;break;
    }
    console.log('Running '+suite.id+': '+suite.command.join(' '));
    const result=spawnSync(suite.command[0],suite.command.slice(1),{stdio:'inherit',env:process.env});
    if(result.status!==0){process.exitCode=result.status||1;break;}
  }
}

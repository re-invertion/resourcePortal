/**
 * Lease-scoped source-policy ownership. Do not blindly flush a tenant's
 * routing priority/table: verify exact source, gateway and RP interface.
 */
const safeDevice=/^rp-a-[0-9a-f]{8}$/;
const ipv4=/^(?:\d{1,3}\.){3}\d{1,3}$/;
const table="20015";
const pref="18015";
function escapeRegex(s:string):string { return s.replaceAll(".","\\."); }
export type StaticRoutingClaim = {source:string;gateway:string;device:string;prefix?:string};
/** Derive an exact connected network from the owned static interface address. */
export function staticConnectedPrefix(source:string,mask:number):string {
  const parts=source.split('.').map(Number);
  if(parts.length!==4||parts.some(x=>!Number.isInteger(x)||x<0||x>255)||
     !Number.isInteger(mask)||mask<1||mask>32) throw new Error('Invalid static connected CIDR');
  const value=parts.reduce((n,x)=>((n<<8)|x)>>>0,0);
  const bits=(0xffffffff << (32-mask))>>>0;
  const network=(value & bits)>>>0;
  return [24,16,8,0].map(n=>(network>>>n)&255).join('.')+'/'+mask;
}

export type StaticPolicyInspection = {
  rulePresent:boolean;routePresent:boolean;fullyConfigured:boolean;
  cleanup:readonly (readonly string[])[];
};
export function inspectStaticRoutingClaim(
  input:StaticRoutingClaim,rules:string,routes:string,
):StaticPolicyInspection {
  if(!safeDevice.test(input.device)||!ipv4.test(input.source)||!ipv4.test(input.gateway))
    throw new Error("Invalid RP-owned static application routing identity");
  const matchedRules=rules.split(/\r?\n/).map(x=>x.trim())
    .filter(x=>new RegExp("^"+pref+":").test(x));
  if(matchedRules.length>1)throw new Error("Duplicate static policy routing priorities");
  if(matchedRules.length===1 &&
     !new RegExp("^"+pref+":\\s+from "+escapeRegex(input.source)+
       "(?:/32)? lookup "+table+"(?:\\s|$)").test(matchedRules[0]))
    throw new Error("Static rule is owned by a different source or table");
  const routeRows=routes.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  if(routeRows.length>2) throw new Error("Static routing table contains unexpected routes");
  const defaultPattern=new RegExp("^default via "+escapeRegex(input.gateway)+
    " dev "+escapeRegex(input.device)+"(?:\\s+(?:proto|src|metric)\\s+[^\\s]+)*$");
  const defaultRows=routeRows.filter(x=>x.startsWith('default'));
  if(defaultRows.length>1||defaultRows.some(x=>!defaultPattern.test(x)))
    throw new Error("Static route table is foreign or disagrees with desired gateway");
  const connectedRows=routeRows.filter(x=>!x.startsWith('default'));
  const expected=input.prefix;
  if(connectedRows.length>1 || connectedRows.some(row=>
    !expected || !new RegExp('^'+escapeRegex(expected)+' dev '+escapeRegex(input.device)+
      '(?:\\s+(?:proto|scope|src|metric)\\s+[^\\s]+)*$').test(row)))
    throw new Error("Static routing table contains unexpected routes");
  if(routeRows.length!==defaultRows.length+connectedRows.length)
    throw new Error("Static routing table contains unexpected routes");
  const rulePresent=matchedRules.length===1;
  const routePresent=defaultRows.length===1;
  const connectedPresent=connectedRows.length===1;
  return {
    rulePresent,routePresent,fullyConfigured:rulePresent&&routePresent&&connectedPresent,
    cleanup:[
      ...(rulePresent ? [["-4","rule","del","pref",pref,"from",input.source+"/32","lookup",table]] : []),
      ...(routePresent ? [["-4","route","del","default","via",input.gateway,
        "dev",input.device,"table",table]] : []),
      ...(connectedPresent ? [["-4","route","del",expected!,"dev",input.device,"table",table]] : []),
    ]
  };
}


type TableReadResult = {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: Error | undefined;
};

/** Check only the dedicated RP routing table. A fresh namespace has no FIB
 * table 20015, so iproute2 reports ENOENT (status 2) instead of empty stdout.
 * Every other status/stderr (including EPERM/EACCES) is a hard failure.
 */
export function readRpStaticTable(
  execute: (args: readonly string[]) => TableReadResult,
): string {
  const result = execute(["-4", "route", "show", "table", table]);
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (!result.error && result.status === 0 && !stderr) return stdout;
  if (!result.error && result.status === 2 && !stdout &&
      /^Error: ipv4: FIB table does not exist\.\s*Dump terminated\.?$/.test(stderr))
    return "";
  throw new Error("RP static routing table 20015 inspection failed: " +
    (result.error?.message || stderr || "exit " + String(result.status)));
}

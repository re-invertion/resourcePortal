/**
 * Lease-scoped source-policy ownership. Do not blindly flush a tenant's
 * routing priority/table: verify exact source, gateway and RP interface.
 */
const safeDevice=/^rp-a-[0-9a-f]{8}$/;
const ipv4=/^(?:\d{1,3}\.){3}\d{1,3}$/;
const table="20015";
const pref="18015";
function escapeRegex(s:string):string { return s.replaceAll(".","\\."); }
export type StaticRoutingClaim = {source:string;gateway:string;device:string};
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
  if(routeRows.length>1) throw new Error("Static routing table contains unexpected routes");
  if(routeRows.length===1&&!new RegExp("^default via "+
       escapeRegex(input.gateway)+" dev "+escapeRegex(input.device)+
       "(?:\\s+(?:proto|src|metric)\\s+[^\\s]+)*$").test(routeRows[0]))
    throw new Error("Static route table is foreign or disagrees with desired gateway");
  const rulePresent=matchedRules.length===1;
  const routePresent=routeRows.length===1;
  return {
    rulePresent,routePresent,fullyConfigured:rulePresent&&routePresent,
    cleanup:[
      ...(rulePresent ? [["-4","rule","del","pref",pref,"from",input.source+"/32","lookup",table]] : []),
      ...(routePresent ? [["-4","route","del","default","via",input.gateway,
        "dev",input.device,"table",table]] : []),
    ]
  };
}

/** Only the exact iproute2 missing-table diagnostic represents a clean,
 * never-created routing table. All other failures must abort revocation. */
export function parseStaticTableRead(
  status: number | null, stdout: string, stderr: string,
): string {
  if(status===0) return stdout.trim();
  if(status===2 && !stdout.trim() &&
      stderr.trim()==="Error: ipv4: FIB table does not exist. Dump terminated.")
    return "";
  throw new Error("Static LAN route inspection failed: " +
    (stderr.trim() || "exit "+status));
}

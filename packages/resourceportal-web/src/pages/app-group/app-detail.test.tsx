import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ApplicationDetail } from "./app-detail";
function json(value: unknown){return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}})}
it("runs application runtime actions through the application endpoint", async()=>{
 const fetchMock=vi.fn(async(input:RequestInfo|URL)=>{const p=String(input);if(p.endsWith("/single-apps"))return json([{id:"app1",name:"checkout",runtimeState:"Running",effectiveRuntimeState:"Running",health:"Healthy"}]);if(p.endsWith("/runtime-config"))return json({environment:{},secrets:[]});if(p.endsWith("/http-endpoints"))return json([]);if(p.endsWith("/runtime/stop"))return json({});return json([])});vi.stubGlobal("fetch",fetchMock);
 render(<ApplicationDetail tenantId="t1" appGroupId="ag1" appId="app1"/>);
 const stop=await screen.findByRole("button",{name:"Stop application"});fireEvent.click(stop);
 await vi.waitFor(()=>expect(fetchMock.mock.calls.some(([p])=>String(p).endsWith("/single-apps/app1/runtime/stop"))).toBe(true));
});

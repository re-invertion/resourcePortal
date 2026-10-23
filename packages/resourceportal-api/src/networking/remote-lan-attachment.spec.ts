import { describe, expect, it } from "vitest";
import { validateRemoteLanAttachments, remoteLanAttachmentForWorkload } from "./remote-lan-attachment";

const attachment = {
  tenantId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  singleAppId: "aaaaaaaa-bbbb-4ccc-8ddd-aaaaaaaaaaaa",
  gateId: "aaaaaaaa-bbbb-4ccc-8ddd-bbbbbbbbbbbb",
  interfaceName: "rpl2a0",
  macAddress: "02:aa:bb:cc:dd:ee",
  status: "Active" as const,
};
describe("remote LAN attachment authorization", () => {
  it("requires an exact tenant, app and gate match", () => {
    const [approved] = validateRemoteLanAttachments({version:1,attachments:[attachment]});
    expect(remoteLanAttachmentForWorkload([approved], attachment.tenantId, attachment.singleAppId, attachment.gateId)).toEqual(approved);
    expect(remoteLanAttachmentForWorkload([approved], "ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee", attachment.singleAppId, attachment.gateId)).toBeUndefined();
    expect(remoteLanAttachmentForWorkload([approved], attachment.tenantId, attachment.gateId, attachment.gateId)).toBeUndefined();
    expect(remoteLanAttachmentForWorkload([approved], attachment.tenantId, attachment.singleAppId, attachment.singleAppId)).toBeUndefined();
  });
  it("never activates pending or revoked attachments", () => {
    for(const status of ["Pending","Provisioning","Error","Revoking","Revoked"] as const) {
      const [candidate] = validateRemoteLanAttachments({version:1,attachments:[{...attachment,status}]});
      expect(remoteLanAttachmentForWorkload([candidate],attachment.tenantId,attachment.singleAppId,attachment.gateId)).toBeUndefined();
    }
  });
  it("rejects duplicate app identities even with different gates", () => {
    expect(() => validateRemoteLanAttachments({version:1,attachments:[attachment,{...attachment,gateId:attachment.singleAppId}]})).toThrow();
  });
  it("rejects multicast, globally administered and invalid MACs", () => {
    for(const macAddress of ["01:aa:bb:cc:dd:ee","00:aa:bb:cc:dd:ee","invalid"]) {
      expect(() => validateRemoteLanAttachments({version:1,attachments:[{...attachment,macAddress}]})).toThrow();
    }
  });
  it("rejects unsupported snapshots and unsafe interface names", () => {
    expect(() => validateRemoteLanAttachments({version:2,attachments:[]})).toThrow();
    expect(() => validateRemoteLanAttachments({version:1,attachments:[{...attachment,interfaceName:"eth0; rm -rf /"}]})).toThrow();
  });
});
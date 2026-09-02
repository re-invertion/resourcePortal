import { describe, expect, it } from "vitest";
import {
  customRootDomainUpdateForm,
  domainUpdateForm,
  membershipUpdateForm,
  oauthApplicationUpdateForm,
  platformServiceIdentityUpdateForm,
  tenantServiceIdentityUpdateForm,
} from "./form-templates";

describe("mutation form templates", () => {
  it("keeps PATCH-only contracts separate from CREATE contracts", () => {
    expect(membershipUpdateForm).toEqual({ status: "", roleIds: [""] });
    expect(domainUpdateForm).toEqual({ httpEndpointId: "", tlsEnabled: null });
    expect(customRootDomainUpdateForm).toEqual({ verificationStatus: "" });
    expect(oauthApplicationUpdateForm).toEqual({
      name: "",
      redirectUris: [""],
      postLogoutRedirectUris: [""],
    });
    expect(tenantServiceIdentityUpdateForm).toEqual({
      name: "",
      description: "",
      status: "",
      roleIds: [""],
    });
    expect(platformServiceIdentityUpdateForm).toEqual({
      name: "",
      description: "",
      status: "",
    });
  });
});

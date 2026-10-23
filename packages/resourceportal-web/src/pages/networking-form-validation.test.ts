import { describe, expect, it } from "vitest";
import {
  hasFormErrors,
  validateGateForm,
  validateNetworkForm,
} from "./networking-form-validation";

describe("networking form validation", () => {
  it("keeps Gate validation inline for invalid resource names", () => {
    const errors = validateGateForm({
      name: "Office Gateway",
      description: "",
    });
    expect(errors.name).toMatch(/lowercase/i);
    expect(hasFormErrors(errors)).toBe(true);
  });

  it("validates optional Network CIDR as private IPv4 /16 through /28", () => {
    expect(validateNetworkForm({ name: "backend", description: "", cidr: "" }).cidr).toBeUndefined();
    expect(validateNetworkForm({ name: "backend", description: "", cidr: "8.8.8.0/24" }).cidr).toMatch(/private/i);
    expect(validateNetworkForm({ name: "backend", description: "", cidr: "10.20.0.0/30" }).cidr).toMatch(/\/16 through \/28/i);
    expect(validateNetworkForm({ name: "backend", description: "", cidr: "10.20.0.0/24" }).cidr).toBeUndefined();
  });

});

const RESOURCE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ipv4Parts(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number(part);
  });
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : null;
}

export function resourceNameError(value: string) {
  const name = value.trim();
  if (!name) return "Name is required.";
  if (name.length > 63) return "Name must be 63 characters or fewer.";
  if (!RESOURCE_NAME.test(name)) {
    return "Use lowercase letters, numbers and single hyphens only.";
  }
  return undefined;
}

export function descriptionError(value: string) {
  return value.length > 1000 ? "Description must be 1000 characters or fewer." : undefined;
}

export function networkCidrError(value: string) {
  const cidr = value.trim();
  if (!cidr) return undefined;
  const match = /^(.+)\/(\d{1,2})$/.exec(cidr);
  if (!match) return "Enter a private IPv4 CIDR, for example 10.240.20.0/24.";
  const address = ipv4Parts(match[1] ?? "");
  const prefix = Number(match[2]);
  if (!address || !Number.isInteger(prefix) || prefix < 16 || prefix > 28) {
    return "CIDR must be an IPv4 network with prefix /16 through /28.";
  }
  const [a, b] = address;
  const privateRange =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  if (!privateRange) return "CIDR must use a private RFC1918 address range.";
  return undefined;
}

export function ipv4Error(value: string, required = true) {
  const address = value.trim();
  if (!address) return required ? "IPv4 address is required." : undefined;
  return ipv4Parts(address) ? undefined : "Enter a valid IPv4 address.";
}

export function integerRangeError(
  value: string,
  label: string,
  min: number,
  max: number,
) {
  if (!value.trim()) return `${label} is required.`;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    return `${label} must be an integer from ${min} to ${max}.`;
  }
  return undefined;
}

export type NetworkForm = { name: string; description: string; cidr: string };
export type GateForm = { name: string; description: string };
export type RoutingForm = {
  mode: "Manual" | "BGP";
  localAsn: string;
  routerAddress: string;
  routerAsn: string;
  sourceAddress: string;
  holdTimeSeconds: string;
};

export function validateNetworkForm(form: NetworkForm) {
  return {
    name: resourceNameError(form.name),
    description: descriptionError(form.description),
    cidr: networkCidrError(form.cidr),
  };
}

export function validateGateForm(form: GateForm) {
  return {
    name: resourceNameError(form.name),
    description: descriptionError(form.description),
  };
}

export function validateRoutingForm(form: RoutingForm) {
  if (form.mode !== "BGP") return {};
  const errors: Record<string, string | undefined> = {
    localAsn: integerRangeError(form.localAsn, "Gate ASN", 1, 4_294_967_295),
    routerAsn: integerRangeError(form.routerAsn, "Router ASN", 1, 4_294_967_295),
    routerAddress: ipv4Error(form.routerAddress),
    sourceAddress: ipv4Error(form.sourceAddress, false),
    holdTimeSeconds: integerRangeError(form.holdTimeSeconds, "Hold time", 9, 65_535),
  };
  if (
    !errors.localAsn &&
    !errors.routerAsn &&
    Number(form.localAsn) === Number(form.routerAsn)
  ) {
    errors.routerAsn = "Router ASN must differ from the Gate ASN.";
  }
  return errors;
}

export function hasFormErrors(errors: Record<string, string | undefined>) {
  return Object.values(errors).some(Boolean);
}

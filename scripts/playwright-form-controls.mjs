function listLabelFallback(control) {
  if (typeof control?.toString !== "function" || typeof control?.page !== "function") {
    return undefined;
  }

  const description = control.toString();
  const match = description.match(/getByLabel\((['"])(.*?) item \d+\1/);
  if (!match?.[2]) return undefined;

  return control
    .page()
    .getByLabel(match[2], { exact: true })
    .filter({ visible: true })
    .first();
}

async function resolveControl(control) {
  try {
    const tagName = await control.evaluate((element) => element.tagName);
    return { control, tagName };
  } catch (error) {
    const fallback = listLabelFallback(control);
    if (!fallback) throw error;

    const tagName = await fallback.evaluate((element) => element.tagName);
    return { control: fallback, tagName };
  }
}

export async function fillPlaywrightControl(control, value) {
  const serializedValue = value == null ? "" : String(value);
  const resolved = await resolveControl(control);

  if (resolved.tagName === "SELECT") {
    await resolved.control.selectOption(serializedValue);
    return;
  }

  await resolved.control.fill(serializedValue);
}

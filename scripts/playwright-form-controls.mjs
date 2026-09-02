export async function fillPlaywrightControl(control, value) {
  const serializedValue = value == null ? "" : String(value);
  const tagName = await control.evaluate((element) => element.tagName);

  if (tagName === "SELECT") {
    await control.selectOption(serializedValue);
    return;
  }

  await control.fill(serializedValue);
}

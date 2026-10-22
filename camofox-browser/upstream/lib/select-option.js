/** Select an option by its accessible label, then by its HTML value. */
export async function selectOption(locator, option) {
  try {
    return await locator.selectOption({ label: option });
  } catch (labelError) {
    try {
      return await locator.selectOption({ value: option });
    } catch {
      throw labelError;
    }
  }
}

/**
 * Controls are exposed by their accessible role so the agent can operate
 * native selects and custom dropdowns with refs rather than brittle CSS.
 */
export const INTERACTIVE_ROLES = Object.freeze([
  'button', 'link', 'textbox', 'checkbox', 'radio',
  'menuitem', 'listitem', 'combobox', 'tab', 'searchbox', 'slider', 'spinbutton', 'switch',
]);

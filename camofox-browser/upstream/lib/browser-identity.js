export function contextIdentityOptions({ hasProxy, directIdentity }) {
  if (hasProxy) return { permissions: ['geolocation'] };
  return directIdentity ? { ...directIdentity } : {};
}

export function launchLocale({ hasProxy, directIdentity }) {
  return hasProxy ? undefined : directIdentity?.locale;
}

// Tracks a page while it exists outside a session tab group. Reapers use this
// to avoid treating a session as empty during context.newPage().
export function acquirePageLease(session) {
  const leases = session.pageLeases ||= new Set();
  const lease = { page: null, released: false };
  leases.add(lease);
  return lease;
}

export function setLeasedPage(lease, page) {
  lease.page = page;
  return page;
}

export function releasePageLease(session, lease) {
  if (!lease || lease.released) return;
  lease.released = true;
  session?.pageLeases?.delete(lease);
}

export function hasActivePageLeases(session) {
  return Boolean(session?.pageLeases?.size);
}

export function isPageLeased(session, page) {
  return Boolean(page && session?.pageLeases && [...session.pageLeases].some((lease) => lease.page === page));
}

const GOOGLE_ORGANIC_RESULT_WAIT_MS = 5000;

function pageHasGoogleOrganicResult() {
  const resultContainer = document.querySelector('#rso') || document.querySelector('#search');
  if (!resultContainer) return false;

  return [...resultContainer.querySelectorAll('h3')].some((heading) => {
    const link = heading.closest('a[href]');
    if (!link?.href) return false;
    try {
      const url = new URL(link.href, document.baseURI);
      return /^https?:$/.test(url.protocol) && !/(^|\.)google\./i.test(url.hostname);
    } catch {
      return false;
    }
  });
}

export async function hasGoogleOrganicResults(page) {
  if (!page || page.isClosed()) return false;

  const hasResults = () => page.evaluate(pageHasGoogleOrganicResult).catch(() => false);
  if (await hasResults()) return true;

  try {
    await page.waitForFunction(pageHasGoogleOrganicResult, {
      timeout: GOOGLE_ORGANIC_RESULT_WAIT_MS,
    });
  } catch {
    // The caller classifies a still-empty result page and uses the fallback.
  }

  return hasResults();
}

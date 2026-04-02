/**
 * SourceTag Cookie Persistence Worker
 *
 * Deploy this Cloudflare Worker on your domain to extend SourceTag cookie
 * persistence to 400 days in Safari and privacy-focused browsers.
 *
 * Without this worker, JavaScript cookies are limited to 7 days in Safari,
 * Brave, and all iOS browsers. This worker re-sets the cookie via HTTP
 * Set-Cookie headers, which these browsers allow for up to 400 days.
 *
 * Setup:
 * 1. Your site must be proxied through Cloudflare (orange cloud)
 * 2. Go to Workers & Pages > Create Worker
 * 3. Paste this code
 * 4. Add a route: yourdomain.com/* (or specific paths)
 *
 * Configuration: change the COOKIE_NAME below if you've customised it
 * in your SourceTag dashboard.
 */

const WORKER_VERSION = 1;
const COOKIE_NAME = '_sourcetag';
const COOKIE_MAX_AGE_DAYS = 400;
const REFRESH_INTERVAL_HOURS = 24;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Version check endpoint — lets SourceTag verify the worker is installed and up to date
    if (url.pathname === '/__sourcetag/worker') {
      return new Response(JSON.stringify({ version: WORKER_VERSION }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': 'https://app.sourcetag.io',
          'Cache-Control': 'no-store',
        },
      });
    }

    // Only process GET requests for HTML pages (not assets)
    if (request.method !== 'GET') {
      return fetch(request);
    }
    const accept = request.headers.get('accept') || '';

    // Pass through non-page requests (JS, CSS, images, fonts, etc.)
    if (!accept.includes('text/html')) {
      return fetch(request);
    }

    // Get the response from the origin
    const response = await fetch(request);

    // Only modify HTML responses
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      return response;
    }

    // Check if the SourceTag cookie exists
    const cookieHeader = request.headers.get('cookie') || '';
    const cookieMatch = cookieHeader.match(
      new RegExp('(?:^|; )' + COOKIE_NAME + '=([^;]*)')
    );

    if (!cookieMatch) {
      // No cookie yet - nothing to refresh
      return response;
    }

    // Check the refresh marker to avoid setting Set-Cookie on every page load
    const refreshMarker = COOKIE_NAME + '_r';
    const hasRecentRefresh = cookieHeader.includes(refreshMarker + '=');

    // Check if this is a new attribution event
    const hasUtms = url.searchParams.has('utm_source') ||
      url.searchParams.has('utm_medium') ||
      url.searchParams.has('utm_campaign');
    const hasClickId = url.searchParams.has('gclid') ||
      url.searchParams.has('fbclid') ||
      url.searchParams.has('msclkid') ||
      url.searchParams.has('ttclid') ||
      url.searchParams.has('gbraid') ||
      url.searchParams.has('wbraid');

    // Check for external referrer (organic search, social, etc.)
    const referer = request.headers.get('referer') || '';
    let hasExternalReferrer = false;
    if (referer) {
      try {
        const refHost = new URL(referer).hostname;
        hasExternalReferrer = refHost !== url.hostname;
      } catch (e) {}
    }

    // Only refresh if: new attribution data, external referrer, OR refresh marker expired (24hr)
    if (!hasUtms && !hasClickId && !hasExternalReferrer && hasRecentRefresh) {
      return response;
    }

    // Clone the response and add Set-Cookie headers
    const newResponse = new Response(response.body, response);

    const maxAge = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;
    const secure = url.protocol === 'https:' ? '; Secure' : '';

    // Derive root domain using the same probe approach as the JS script's
    // getCookieDomain(). Naive "last two parts" fails for multi-part TLDs
    // (e.g. .co.uk). Instead we walk up from the hostname and use the
    // broadest level that isn't a bare public suffix.
    const parts = url.hostname.split('.');
    let rootDomain = url.hostname;
    if (parts.length > 2) {
      // Try progressively broader domains, stopping at the first that
      // isn't a public suffix (i.e. skip candidates like co.uk, org.uk).
      for (let i = 1; i < parts.length - 1; i++) {
        const candidate = parts.slice(i).join('.');
        // A candidate with only 2 parts where the first part is 2-3 chars
        // is likely a public suffix — skip it
        const candidateParts = candidate.split('.');
        if (candidateParts.length === 2 && candidateParts[0].length <= 3) {
          continue;
        }
        rootDomain = candidate;
        break;
      }
    }
    const domainAttr = rootDomain !== url.hostname ? '; Domain=.' + rootDomain : '';

    // Sanitise cookie value via JSON round-trip to strip malformed data
    let safeValue = cookieMatch[1];
    try {
      const decoded = decodeURIComponent(cookieMatch[1]);
      const parsed = JSON.parse(decoded);
      if (parsed !== null) {
        safeValue = encodeURIComponent(JSON.stringify(parsed));
      }
    } catch (e) {
      // If parse fails, skip the refresh entirely rather than re-set bad data
      return response;
    }

    // Re-set the attribution cookie with 400-day expiry
    newResponse.headers.append(
      'Set-Cookie',
      `${COOKIE_NAME}=${safeValue}; Path=/${domainAttr}; Max-Age=${maxAge}; SameSite=Lax${secure}`
    );

    // Set refresh marker (24hr) to avoid refreshing on every page load
    const refreshMaxAge = REFRESH_INTERVAL_HOURS * 60 * 60;
    newResponse.headers.append(
      'Set-Cookie',
      `${refreshMarker}=1; Path=/${domainAttr}; Max-Age=${refreshMaxAge}; SameSite=Lax; HttpOnly${secure}`
    );

    return newResponse;
  }
};

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
 * The cookie name is always _sourcetag; no configuration is needed.
 */

const WORKER_VERSION = 2;
const COOKIE_NAME = '_sourcetag';
const COOKIE_MAX_AGE_DAYS = 400;
const REFRESH_INTERVAL_HOURS = 24;
const CLICK_ID_PARAMS = ['gclid', 'fbclid', 'msclkid', 'gbraid', 'wbraid', 'ttclid'];

// Use the domain the browser script chose (stored as `d` in the cookie) so we
// overwrite the same cookie instead of creating a second one. Old cookies
// without `d` fall back to a heuristic.
function cookieDomainAttr(host, parsed) {
  const d = parsed && parsed.d;
  if (typeof d === 'string' && /^(\.[a-z0-9-]+(\.[a-z0-9-]+)*)?$/i.test(d) &&
      (d === '' || host === d.slice(1) || host.endsWith(d))) {
    return d ? '; Domain=' + d : '';
  }
  return '; Domain=' + legacyDomain(host);
}

// The pre-`d` heuristic. Old versions wrote cookies here, so it is also the domain to expire.
// remove after 2027-12-14
function legacyDomain(host) {
  const parts = host.split('.');
  let root = host;
  if (parts.length > 2) {
    for (let i = 1; i < parts.length - 1; i++) {
      const cand = parts.slice(i).join('.');
      const cp = cand.split('.');
      if (cp.length === 2 && cp[0].length <= 3) continue;
      root = cand;
      break;
    }
  }
  return '.' + root;
}

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
    const hasClickId = CLICK_ID_PARAMS.some((p) => url.searchParams.has(p));

    // Check for external referrer (organic search, social, etc.)
    const referer = request.headers.get('referer') || '';
    let hasExternalReferrer = false;
    if (referer) {
      try {
        const refHost = new URL(referer).hostname;
        // Same rule as the WP plugin: other hosts count, same-site subdomains do not.
        hasExternalReferrer = refHost !== url.hostname && !refHost.endsWith('.' + url.hostname);
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

    // Sanitise cookie value via JSON round-trip to strip malformed data
    let safeValue = cookieMatch[1];
    let parsed;
    try {
      parsed = JSON.parse(decodeURIComponent(cookieMatch[1]));
      if (parsed !== null) {
        safeValue = encodeURIComponent(JSON.stringify(parsed));
      }
    } catch (e) {
      // If parse fails, skip the refresh entirely rather than re-set bad data
      return response;
    }

    const domainAttr = cookieDomainAttr(url.hostname, parsed);

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

    // Expire stale duplicates on the legacy heuristic domain (only when it differs from the one just set)
    // remove after 2027-12-14
    const legacy = '; Domain=' + legacyDomain(url.hostname);
    if (legacy !== domainAttr) {
      for (const n of [COOKIE_NAME, refreshMarker]) {
        newResponse.headers.append('Set-Cookie', `${n}=; Path=/${legacy}; Max-Age=0; SameSite=Lax${secure}`);
      }
    }

    return newResponse;
  }
};

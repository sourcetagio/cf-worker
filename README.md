# SourceTag Cookie Persistence Worker

Cloudflare Worker that re-sets the SourceTag attribution cookie via HTTP headers, giving you 400-day persistence in Safari, Brave, and other browsers that cap JavaScript cookies at 7 days.

## Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sourcetagio/cf-worker)

## Setup

1. Click the deploy button and log into your Cloudflare account
2. Go to your domain in Cloudflare > **Workers Routes**
3. Add a route: `yourdomain.com/*` pointing to `sourcetag-cookies`
4. Add `www.yourdomain.com/*` too if you use www

Non-HTML requests (scripts, images, CSS) are passed through untouched.

## How it works

On each HTML page load, the worker looks for the `_sourcetag` cookie. If it exists and any of these are true:

- UTM parameters in the URL
- A click ID (gclid, fbclid, etc.) in the URL
- External referrer
- 24+ hours since the last refresh

...it re-sets the cookie with a 400-day expiry via `Set-Cookie`. A marker cookie (`_sourcetag_r`) stops it from doing this on every single page load.

## WordPress?

Use the [WordPress plugin](https://github.com/sourcetagio/wp-plugin) instead — it handles cookie persistence without needing Cloudflare.

## Docs

[sourcetag.io/docs/cloudflare-worker-cookies](https://sourcetag.io/docs/cloudflare-worker-cookies)

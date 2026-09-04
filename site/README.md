# Website deployment

The launch site is deliberately static. It has no package install, build step, server runtime, analytics, cookies, or third-party requests.

For Cloudflare Pages:

- Production branch: `main`
- Framework preset: None
- Build command: leave blank
- Build output directory: `site`
- Root directory: repository root

Before production deployment, preview the exact public commit and verify `/`,
`/styles.css`, `/favicon.svg`, and all four `/assets/product-*.jpg` showcase
images return `200`; inspect desktop and narrow layouts; tab through every
interactive element; and confirm the browser console has no errors or
third-party network requests.

The owner completes the Cloudflare account/repository connection, authorizes production deployment, and configures the custom domain. After DNS is active, confirm Cloudflare’s universal certificate is issued, Always Use HTTPS is enabled, the apex redirects consistently if `www` is added, and the GitHub repository homepage matches the canonical HTTPS URL.

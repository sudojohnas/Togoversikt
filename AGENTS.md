# Working on this repository with Codex

The owner authorizes implementing requested changes, running relevant checks,
committing, pushing, opening a pull request, and automatic production publication
when the checks pass. Complete routine work without asking follow-up questions;
make reasonable choices and describe material assumptions in the result.
Never commit secrets or unrelated changes.

## Complete a requested change

1. Start from current `origin/main` and use a branch named
   `codex/autopublish-<short-description>`. This prefix opts the PR into the owner's
   automatic publication service.
2. Implement the request and run the checks below. Fix failures before finishing.
3. Commit and push all relevant changes, then open a ready (not draft) pull request
   against `main` in this repository. Do not stop at a local diff or draft PR.
4. The owner's Debian service checks GitHub CI for the exact PR head, then merges
   eligible PRs automatically. Publication follows the merge. Do not ask the owner
   to merge or publish manually. Check the PR/deployment result when tools permit.
5. If this environment lacks a tool or permission to push or create the PR, say
   exactly what is missing. Do not claim publication occurred.

Only same-repository PRs authored by `sudojohnas`, targeting `main`, and using the
`codex/autopublish-` prefix are eligible. Other branches keep their existing flow.

## Setup and checks

Use Node.js 22 or newer. Install with `npm ci`. Run `npm test`, `npm run build`,
`git diff --exit-code -- public/app.js`, `npm audit --audit-level=high`, and
`npx wrangler deploy --dry-run --outdir /tmp/togoversikt-worker`.
When editing frontend sources, run the build and commit generated `public/app.js`
before the diff check. Cloudflare Workers Builds publishes `main` to togoversikt.no.
Keep production secrets in Cloudflare; none are needed for local tests or dry-run.

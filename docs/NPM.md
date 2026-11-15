# npm distribution

The local package is tested by `pnpm test:package`, including installation outside
this repository, declarations, the CLI/API, fonts and validation failure safety.
There is no npm publication as part of a build, test, PR merge or Docker release.

## First publication (maintainer)

The unscoped name is `epub-optimizer`. Availability is not reserved by this repository.
Use a maintainer npm account with 2FA. Do not paste authentication tokens into a
chat or commit them. This machine must first authenticate interactively with
`npm login --registry=https://registry.npmjs.org`.

Publish only an already reviewed and published GitHub release, from its exact tag,
in a clean checkout. Check `package.json` version, the release image record's `sha`,
and the tag's peeled commit; they must match. Run the documented quality/package
checks, then pack and inspect the tarball before publishing:

```bash
pnpm pack --out /tmp/epub-optimizer-release.tgz
npm publish /tmp/epub-optimizer-release.tgz --dry-run --registry=https://registry.npmjs.org
# Only after reviewing the dry run and confirming npm account ownership:
npm publish /tmp/epub-optimizer-release.tgz --access public --registry=https://registry.npmjs.org
```

A local first publication uses interactive npm authentication; it does not have
GitHub Actions provenance. Existing npm versions cannot be replaced. Never try to
publish unreleased features as the version of an older GitHub release.

## Subsequent publications (GitHub Actions)

After the first package exists, configure its npm trusted publisher for:

- GitHub owner: `kiki-le-singe`
- Repository: `epub-optimizer`
- Workflow: `npm-publish.yml`
- Environment: `release`
- Allowed action: package publication

This is npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) flow:
short-lived GitHub OIDC authentication instead of a stored npm publishing token.
Keep the existing `release` environment approval requirement enabled.

Manually run **Publish released npm package** from `main`, supplying the latest
published stable `vX.Y.Z` tag. It verifies the GitHub release and tested image record,
checks the source is on main, runs the shared Node 22/24 quality suite (including
installed-package tests), and packs that exact source before publishing with provenance.
Drafts, prereleases, older GitHub releases and mismatched source records are rejected.
It does not publish GitHub releases or modify Docker tags. A failure leaves the
GitHub release untouched; inspect the log before retrying.

Do not run this workflow until the npm trusted publisher is configured. Workflow
syntax and guards can be tested locally, but a dry run cannot prove npm ownership,
OIDC trust or actual registry publication.

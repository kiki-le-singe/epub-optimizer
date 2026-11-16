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

## Subsequent publications (GitHub Actions, with human approval)

Version 3.16.0 is already published. Do not submit it again: staged and published
versions share the same unique version identifier. Use the next reviewed stable
GitHub release to exercise this workflow.

After the first package exists, configure its npm trusted publisher for:

- GitHub owner: `kiki-le-singe`
- Repository: `epub-optimizer`
- Workflow: `npm-publish.yml`
- Environment: `release`
- Leave **Allow npm publish** and **Allow npm dist-tag** unchecked; staging is allowed.

This is npm's [trusted publishing](https://docs.npmjs.com/trusted-publishers/) flow:
short-lived GitHub OIDC authentication instead of a stored npm publishing token.
Keep the existing `release` environment approval requirement enabled.

Manually run **Stage released npm package** from `main`, supplying the latest
published stable `vX.Y.Z` tag. It verifies the GitHub release and tested image record,
checks the source is on main, runs the shared Node 22/24 quality suite (including
installed-package tests), and packs that exact source before submitting it with `npm stage publish` and provenance.
The publishing job pins npm 11.21.2 because older bundled npm versions may not
provide the stage command. A successful workflow means **awaiting approval**, not
public availability.
Drafts, prereleases, older GitHub releases and mismatched source records are rejected.
It does not publish GitHub releases or modify Docker tags. A failure leaves the
GitHub release untouched; inspect the log before retrying.

Do not run this workflow until the npm trusted publisher is configured. Workflow
syntax and guards can be tested locally, but a dry run cannot prove npm ownership,
OIDC trust or actual registry publication.

## Approve a staged version

Open the package's **Staged Packages** section on npm, inspect the submitted version
and approve it using your account's 2FA. Alternatively, on an authenticated machine
with npm 11.21.2 or a later release supporting staged publishing:

```bash
npm stage list epub-optimizer
npm stage view <stage-id>
npm stage approve <stage-id>
```

Approval is a maintainer action; the GitHub workflow never approves automatically.
After approval, verify the version and `latest` on the public registry. Neither
successful staging nor a dry run proves that a package is public.

npm's [trusted publisher documentation](https://docs.npmjs.com/trusted-publishers/)
requires a newly created trust connection to make its first successful publish within
two days. Configure it close to the next release; if it expires before then, recreate
the connection. Its real OIDC/staging behavior is verified on the next new version,
not by trying to replace the published 3.16.0.

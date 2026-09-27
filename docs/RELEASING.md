# Releases and CI

## Prepare a version

Commit and push changes to `develop`, then wait for its CI to pass. In GitHub Actions, run **Prepare release** from `main` with a new version such as `3.7.0` or `3.7.0-rc.1`. The workflow checks CI against the current develop commit, merges it into main, updates `package.json`, and dispatches **Release** plus main's CI. It refuses version downgrades and detects develop moving after the CI check.

The local alternative remains `pnpm release:prepare 3.7.0`, followed by **Release** on main. The prerelease checkbox must match a prerelease suffix in the version. Preparation always uses remote branches: uncommitted or unpushed changes are not included.

When first installing these workflows, they must reach main before **Prepare release** is available there. The existing local preparation command can perform that first merge.

## Build and validate

CI and Release call the same quality and Docker workflows:

- Node 22 and 24: frozen dependency installation, compilation, tests and coverage thresholds, and EPUBCheck E2E. Lint, formatting and TypeScript checks run once on Node 24.
- Native Linux AMD64 and ARM64 runners: image build, all seven Docker/Compose E2E workflows, and a Trivy scan of OS and application packages, including Java dependencies that the scanner detects.
- Docker layers are cached per architecture with the GitHub Actions cache backend. Cache restoration is an optimization, not a correctness dependency.
- All jobs have time limits. Commands piped through `tee` use Bash with `pipefail`, so saved logs cannot hide a failing test.

PR/CI images remain local to the runner. Release builds push technical `candidate-*` tags to GHCR to preserve provenance and SBOM attestations, then pull and test the exact digests. **These candidates are available in the registry but are not stable distribution tags.** Only digests whose E2E tests and scan policy pass enter the release record. There is no rebuild during promotion.

Trivy writes all vulnerability severities, including unfixed findings, to `trivy.json`. The blocking policy is **CRITICAL with an available fix**. HIGH and unfixed findings remain visible for review. A missing report or scanner error fails the check; do not bypass a failed scan by deleting its report. Scanner database updates can legitimately change results between runs.

## Review and publish

The Release workflow assembles the tested architecture digests and creates:

1. An annotated `vX.Y.Z` tag at the validated source commit.
2. A draft GitHub release. Notes come from `release-notes/vX.Y.Z.md` when present; otherwise GitHub generates notes from the release history.
3. A `release-image.json` release asset binding the source commit, version, repository, tested platform digests and final index digest.

**Neither `X.Y.Z` nor `latest` is updated at this stage.** Review the draft and publish it in GitHub. The **Publish release images and sync branches** workflow then verifies the record, promotes the same index to `X.Y.Z`, and updates `latest` only for a stable release with no newer published stable version. Allow this workflow to complete before announcing Docker availability.

Prereleases get their own version tag and never update `latest`. Replaying an older release cannot move latest backwards. Do not modify or remove the image record or delete referenced candidate images; they are needed for finalization and retries.

After promotion, develop is fast-forwarded to main when possible. If the branches diverge or branch protection rejects the push, the workflow creates or reuses a main-to-develop synchronization PR. Conflicts require manual resolution. The repository must allow GitHub Actions to create pull requests for this fallback to work; existing branch protections are respected.

GitHub suppresses ordinary workflow triggers for changes made with `GITHUB_TOKEN`. The automation explicitly dispatches CI after a bot push and tests a synchronization PR's merge ref through CI's optional `pull-request` input. That dispatched run is visible on the Actions page; it is not a substitute for any required PR checks configured in repository rules. A human PR update or an appropriately configured GitHub App may be needed to satisfy those rules.

Publishing the draft through the GitHub UI triggers finalization. If another workflow publishes it with `GITHUB_TOKEN`, explicitly dispatch the finalization workflow too.

## Retry safely

- Before the image record exists: rerun Release. An existing tag is accepted only if it points at the exact same source commit. Existing draft notes are preserved.
- After the record exists: rerun Release to verify and reuse it without rebuilding or rewriting notes. On a new commit, use a new version; never move a released tag.
- If finalization fails: rerun **Publish release images and sync branches**, or dispatch it from main with `tag: vX.Y.Z`. It reuses the recorded digest and can finish synchronization even if the Docker tags were already promoted.
- An absent remote tag is distinct from a network/authentication failure. Network failures stop preparation.
- Legacy releases such as 3.6.0 have no image record and cannot be replayed with the new finalizer. Their existing images remain available.

A manual **Release** rerun must use the original source commit (or the original workflow run) once the version tag exists. A newer main commit with the same version is rejected intentionally.

## Download diagnostics

Every quality and Docker job uploads diagnostics even after failure, retained for 14 days:

- JUnit and coverage reports;
- CLI/Docker logs containing EPUBCheck output;
- JSON reports from generated EPUB fixtures;
- complete Trivy JSON results for image jobs.

E2E scripts copy the generated reports before deleting their temporary fixture directories. Set `EPUB_E2E_ARTIFACT_DIR=reports/e2e` to collect them locally. EPUB files and symlink targets are not exported by the diagnostic helper.

## Token permissions

CI and quality checks use read-only repository access. Only release image jobs get package write access; draft creation gets repository write access. Finalization additionally gets PR and Actions write access for synchronization and explicit CI dispatch. Preparation gets repository and Actions write access. External actions are pinned by full commit SHA.

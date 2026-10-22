# Releases and CI

## Prepare a version

Commit and push changes to `develop`, then wait for its CI to pass. In GitHub Actions, run **Prepare release** from `main` with a new version such as `3.7.0` or `3.7.0-rc.1`. The workflow checks CI against the current develop commit, creates or updates `codex/release-X.Y.Z`, merges develop into that branch and updates `package.json`. It opens a PR to main, waits for its real pull-request CI and the **Required CI** gate, then merges through GitHub's API with the expected head commit. Only then does it dispatch **Release**, bound to that merged commit. Main's push triggers CI normally. Version downgrades and changes to develop, the PR head or its target during validation stop preparation.

The local alternative is `pnpm release:prepare 3.7.0` with authenticated Git and GitHub CLI access restricted to this repository. It uses the same PR and CI checks; follow it with **Release** on main, setting `expected-sha` to the printed source commit. The prerelease checkbox must match a prerelease suffix in the version. Preparation always uses remote branches: uncommitted or unpushed changes are not included.

### Install the release App and branch rules

Do this in order so branch protection never blocks the old direct-push automation:

1. Merge the automation change into develop after its PR CI passes.
2. Register a private GitHub App on the repository owner's account (for example, `epub-optimizer-release-kiki`). Disable webhooks; no server is required. Give it repository **Contents**, **Pull requests**, **Actions**, and **Workflows** read/write access (Workflows offers write only). Do not grant administration, account or organization permissions.
3. Install the App using **Only select repositories → epub-optimizer**. The registration's “Only on this account” setting alone does not restrict repository access.
4. In **epub-optimizer → Settings → Secrets and variables → Actions**, add the App's **Client ID** as the repository variable `RELEASE_APP_CLIENT_ID`. Generate a private key in the App settings and add its complete PEM contents as the repository secret `RELEASE_APP_PRIVATE_KEY`. Do not commit the key or paste it into a chat. The App ID and Client ID are different fields; use the Client ID here.
5. Promote the automation from develop to main with an ordinary PR and successful CI, without bumping the version or invoking a release. Both branches must have the new workflows before strict rules are enabled.
6. Run **Prepare release** on main with **dry-run** checked and a future version. This checks App token issuance, Git access, develop's push CI and the preparation plan without pushing a branch, opening a PR or dispatching Release. Actual PR creation and merge behavior still need verification on the first authorized release.
7. In the active ruleset for main/develop, keep deletion and force-push protection; enable **Require a pull request before merging** and **Require status checks to pass**, selecting **Required CI** from GitHub Actions and requiring the branch to be up to date. Keep the bypass list empty. For automatic merging, do not require a human approval; adding one intentionally blocks merging until a reviewer approves it and preparation is retried.

The tag ruleset for `v*` should block updates and deletions while allowing creation of new version tags. Do not add the release App to its bypass list.

The App token is explicitly restricted to `kiki-le-singe/epub-optimizer`, limited to the permissions requested by each job, and revoked when the job ends. Preparation requests Actions write access to dispatch Release; finalization only requests Actions read access. GHCR still uses the job's `GITHUB_TOKEN`, not the App token. Missing App configuration fails before release preparation or image promotion.

## Build and validate

CI and Release call the same quality and Docker workflows:

- Node 22 and 24: frozen dependency installation, compilation, tests and coverage thresholds, and EPUBCheck E2E. Lint, formatting and TypeScript checks run once on Node 24.
- Native Linux AMD64 and ARM64 runners: image build, all seven Docker/Compose E2E workflows, and a Trivy scan of OS and application packages, including Java dependencies that the scanner detects.
- Docker layers are cached per architecture with the GitHub Actions cache backend. Cache restoration is an optimization, not a correctness dependency.
- All jobs have time limits. Commands piped through `tee` use Bash with `pipefail`, so saved logs cannot hide a failing test.

PR/CI images remain local to the runner. Release builds push technical `candidate-*` tags to GHCR to preserve provenance and SBOM attestations, then pull and test the exact digests. **These candidates are available in the registry but are not stable distribution tags.** Only digests whose E2E tests and scan policy pass enter the release record. There is no rebuild during promotion.

The runtime uses the pinned Node 24 Bookworm image, applies Debian security updates when built, and excludes npm/Corepack, which are only needed during the build.

Trivy writes all vulnerability severities, including unfixed findings, to `trivy.json`. The blocking policy is **CRITICAL with an available fix**. HIGH and unfixed findings remain visible for review. A missing report or scanner error fails the check; do not bypass a failed scan by deleting its report. Scanner database updates can legitimately change results between runs.

## Review and publish

The Release workflow assembles the tested architecture digests and creates:

1. An annotated `vX.Y.Z` tag at the validated source commit.
2. A draft GitHub release. Notes come from `release-notes/vX.Y.Z.md` when present; otherwise GitHub generates notes from the release history.
3. A `release-image.json` release asset binding the source commit, version, repository, tested platform digests and final index digest.

**Neither `X.Y.Z` nor `latest` is updated at this stage.** Review the draft and publish it in GitHub. The **Publish release images and sync branches** workflow then verifies the record, promotes the same index to `X.Y.Z`, and updates `latest` only for a stable release with no newer published stable version. Allow this workflow to complete before announcing Docker availability.

Prereleases get their own version tag and never update `latest`. Replaying an older release cannot move latest backwards. Do not modify or remove the image record or delete referenced candidate images; they are needed for finalization and retries.

After promotion, the workflow creates or updates `codex/sync-main-develop` from develop and merges main into that branch. It opens or reuses a synchronization PR to develop, waits for its **Required CI** gate, and merges through GitHub's API. If develop already contains main, no PR is needed. Main and develop are never pushed directly. Conflicts, changed source/target commits and repository rules stop the operation; the PR remains available for inspection.

The dedicated App token triggers ordinary `pull_request` CI without the approval required for PR events generated with `GITHUB_TOKEN`. The coordinator accepts only a successful CI run associated with that PR's exact head and base, with a successful **Required CI** job. A skipped or missing gate fails closed. CI's optional `pull-request` manual input remains available for diagnostics, but a `workflow_dispatch` run cannot satisfy required PR checks and is never accepted by the coordinator. CI remains read-only; privileged workflows never execute PR code with the App token.

Publishing the draft through the GitHub UI triggers finalization. If another workflow publishes it with `GITHUB_TOKEN`, explicitly dispatch the finalization workflow too.

## Retry safely

- Preparation verifies develop's push CI with the same App token used by the coordinator. Missing runs, pending runs and incomplete conclusions are reread every 10 seconds for up to three minutes; a completed unsuccessful run fails immediately. Only the newest matching push run for the pinned develop SHA is eligible, and develop is checked again before creating the preparation branch. Logs identify the SHA, run ID, status and conclusion. Dry runs use this same check.
- Finalization rereads a missing release catalogue entry for up to three minutes. For a published event, it also waits for a stale draft flag to clear and requires the event's exact release ID. A manually dispatched draft is rejected immediately: publish it first. The wait never publishes a draft or promotes images before a published release and its tested image record have been verified. API or authentication errors stop immediately rather than being treated as pending state. Individual GitHub CLI requests retain their existing command time limits.
- Before the image record exists: rerun Release. An existing tag is accepted only if it points at the exact same source commit. Existing draft notes are preserved.
- After the record exists: rerun Release to verify and reuse it without rebuilding or rewriting notes. On a new commit, use a new version; never move a released tag.
- PR validation waits at most 45 minutes, within the App token's one-hour lifetime. On timeout, an approval requirement, failed CI or a concurrent branch update, inspect the open PR and retry the originating workflow. Retry failed PR CI through its original pull-request run; a manual dispatch is not equivalent. Keep the `codex/release-*` and `codex/sync-main-develop` branches reserved for automation; retries update them without force pushes.
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

CI and quality checks use read-only repository access. Only release image jobs get package write access; draft creation gets repository write access. Preparation and synchronization use the repository-scoped App token for Git and PR operations. Their job `GITHUB_TOKEN` stays read-only for repository contents; finalization additionally grants it package write access for GHCR. The App does not bypass repository rules. External actions are pinned by full commit SHA.

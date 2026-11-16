# Docker Hub distribution (maintainer setup)

GHCR remains the existing public distribution. Docker Hub is optional and is not
available until the namespace, public repository and first successful mirror are
confirmed. Do not advertise a placeholder Docker Hub pull command as published.

## One-time setup

1. Create a Docker account at https://hub.docker.com and note the exact Docker ID.
2. Create a **public** repository named `epub-optimizer` in that namespace. Do not
   enable automatic builds or grant Docker Hub access to GitHub repositories.
3. Add a short description and the repository overview below.
4. Create an expiring Docker Hub personal access token with the read/write access
   needed to push images. Do not grant delete access. Review the scope Docker offers
   for the account; personal tokens can grant access beyond one repository. Do not
   paste the token in chat, source files or command arguments.
5. In **kiki-le-singe/epub-optimizer → Settings → Secrets and variables → Actions**,
   add repository variables `DOCKERHUB_USERNAME` (the Docker ID) and `DOCKERHUB_IMAGE`
   (`YOUR_DOCKER_ID/epub-optimizer`). Add `DOCKERHUB_TOKEN` as a secret, preferably
   in the protected `release` environment used by the mirroring job.

The publishing job uses the existing protected `release` environment. Only enable
the image variable after both the repository and credentials are ready. No Docker
Hub account is needed by users pulling a public image, subject to registry limits.

## First mirror and verification

After this automation is merged into main, run **Mirror tested release to Docker
Hub** from main with the latest published stable GitHub release tag (currently
`v3.16.1`). It uses Skopeo to copy the recorded index and all child manifests with
`--all --preserve-digests`; it never rebuilds or selects only the runner architecture.

The script verifies the release/tag/source, index digest, exact tested child image
and attestation manifests, existing destination version, and GHCR `latest` before
copying the version and `latest`. A digest conversion fails. Drafts, prereleases,
older releases and a mismatched existing version fail. Network/auth failures fail
closed. A partial copy can leave the version available without updating `latest`;
inspect the logs and retry the same release. Never delete/reassign version tags to
work around a mismatch.

Once both destination tags match the recorded digest, pull from Docker Hub on the
target host and exercise the same single-book/drop-folder checks as GHCR. A mirror
unit test does not prove Docker Hub permissions, multi-platform registry support
or a successful upload. Physical NAS interfaces remain unverified.

Future finalization runs mirror after GHCR promotion and branch synchronization
when `DOCKERHUB_IMAGE` is set. A Docker Hub failure leaves the completed GHCR
publication intact; retry the dedicated mirror workflow. The manual path also
allows the current release to be mirrored without creating another version.

After the first successful upload, add the actual Docker Hub link and pull command
to README and the NAS guide. Users can choose either registry; use immutable version
digests for reproducible deployment. Initial uploads do not establish search ranking.

## Suggested public repository overview

**Short description:** Optimize EPUB size with content checks and bundled EPUBCheck.

EPUB Optimizer compresses images, minifies XHTML/CSS/JavaScript and validates output
with EPUBCheck before publication. Docker includes Node.js, Java and EPUBCheck.
It supports Linux AMD64 and ARM64 and offers single-book, batch and watched-folder
workflows. Original inputs can be mounted read-only; the watcher needs no container
network or inbound port. Read the installation and usage instructions at:

https://github.com/kiki-le-singe/epub-optimizer

Source and license: MIT. Issues and release notes are maintained in the GitHub
repository. Docker Hub mirrors the exact tested release images published on GHCR.

Maintainer references: [Docker Hub access tokens](https://docs.docker.com/security/access-tokens/personal-access-tokens/),
[Skopeo copy options](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md).

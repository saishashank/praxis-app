# arm64 Python requirements

`scripts/ingest/requirements.txt` carries SHA-256 hashes for **x86_64 CPython 3.12 on Linux only**.
`pip install --require-hashes` on an aarch64 box (Oracle Ampere A1, INFRA §9) rejects those files, so
`Dockerfile.jobs` uses a second hashed file on arm64, `scripts/ingest/requirements-arm64.txt`, and stops
with a clear error when it is missing. Hashes are never written by hand.

## How the arm64 file is made

```bash
node scripts/ingest/gen-arm64-reqs.mjs
```

The script keeps **exactly** the versions pinned in `requirements.txt` (no new resolution, so the two
files can never drift apart in versions) and, for each pin, lists the SHA-256 of every file PyPI
publishes that pip may choose on CPython 3.12 / Linux aarch64: pure wheels, `cp312` or `abi3`
manylinux/musllinux aarch64 wheels, and the sdist. The hashes come from PyPI's JSON API. If a binary
package has no aarch64 wheel, the script reports it and exits 1. `--check` fails when the committed
file is stale.

Re-run it whenever `requirements.txt` changes, review the diff and commit both files together.

## How it is proven

The branch CI job (`selfhost-check.yml`) builds `praxis-jobs` for `linux/arm64` on an arm64 runner,
which runs `pip install --require-hashes` with this file. A wrong or missing hash fails that build.

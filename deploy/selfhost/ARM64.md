# arm64 Python requirements (TODO before the first arm64 jobs image)

`scripts/ingest/requirements.txt` carries SHA-256 hashes for **x86_64 CPython 3.12 on Linux only**.
`pip install --require-hashes` on an aarch64 box (Oracle Ampere A1, INFRA §9) rejects those files, so
`Dockerfile.jobs` looks for a second hashed file for arm64 and stops with a clear error when it is
missing. Hashes are never written by hand.

## Generate `scripts/ingest/requirements-arm64.txt`

Run on an arm64 Linux machine (or in an arm64 container, for example
`docker run --rm --platform linux/arm64 -v "$PWD":/w -w /w python:3.12-slim-bookworm bash`):

```bash
python -m pip install pip-tools
# Same direct requirement as requirements.txt (yfinance==1.7.0, see its header).
echo "yfinance==1.7.0" > /tmp/requirements.in
pip-compile --generate-hashes --allow-unsafe --no-header --output-file scripts/ingest/requirements-arm64.txt /tmp/requirements.in
```

Then:

1. Copy the explanatory header of `requirements.txt`, change "x86_64" to "aarch64", and add the date.
2. Review the diff against `requirements.txt`: the package names and versions must be the same set
   (only the hash lists differ). A version that differs needs a decision before it is committed.
3. Prove it installs: `pip install --require-hashes --only-binary=:all: -r scripts/ingest/requirements-arm64.txt`
   in a `python:3.12-slim-bookworm` arm64 container.
4. Commit the file. `Dockerfile.jobs` then picks it up automatically for `TARGETARCH=arm64`
   (override with `--build-arg PY_REQUIREMENTS=<path>`), and `build-selfhost.yml` adds `linux/arm64`
   to the jobs image on its own once the file exists.

Re-run these steps whenever `requirements.txt` changes (INFRA §15.1: hashed requirements resolved for
both architectures).

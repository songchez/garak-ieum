#!/usr/bin/env bash
set -euo pipefail

# Dependencies and generated bundles stay in a fresh temporary directory.
# The application package.json, lockfile, and node_modules are not used or changed.
poc_source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
poc_work_dir="$(mktemp -d "${TMPDIR:-/tmp}/garak-composition-poc.XXXXXX")"
cp -- "$poc_source_dir/package.fixture.json" "$poc_work_dir/package.json"
cp -- "$poc_source_dir/pnpm-lock.fixture.yaml" "$poc_work_dir/pnpm-lock.yaml"
cp -- "$poc_source_dir/run.mjs" "$poc_source_dir/fixtures.mjs" "$poc_work_dir/"
cd -- "$poc_work_dir"
pnpm install --frozen-lockfile --ignore-scripts
node run.mjs
printf '\nFull result: %s/results.json\n' "$poc_work_dir"

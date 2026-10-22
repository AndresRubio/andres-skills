#!/usr/bin/env bash
set -eu
bash "$(dirname "$0")/../fixtures/make_fixture.sh" "$PWD/fixture" --no-squash

#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-Rogn/copilot-cli-agent-observer}"
REF="${REF:-master}"
SOURCE_DIR="${SOURCE_DIR:-}"
INSTALL_ROOT="${INSTALL_ROOT:-${HOME}/.copilot/extensions}"

tmp_dir="$(mktemp -d)"
archive_url="https://github.com/${REPO}/archive/refs/heads/${REF}.tar.gz"
install_root="${INSTALL_ROOT}"
target_dir="${install_root}/agent-observer"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

if [[ -n "${SOURCE_DIR}" ]]; then
  source_dir="${SOURCE_DIR}/.github/extensions/agent-observer"
else
  echo "Downloading ${archive_url}"
  curl -fsSL "${archive_url}" | tar -xzf - -C "${tmp_dir}"
  repo_root="$(find "${tmp_dir}" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  source_dir="${repo_root}/.github/extensions/agent-observer"
fi

if [[ ! -d "${source_dir}" ]]; then
  echo "Extension folder missing: ${source_dir}" >&2
  exit 1
fi

mkdir -p "${install_root}"
if [[ -d "${target_dir}" ]]; then
  if ! rm -rf "${target_dir}" 2>/dev/null; then
    echo "" >&2
    echo "ERROR: Cannot remove existing install — files are locked." >&2
    echo "The native webview binary is likely held open by a running Copilot CLI session." >&2
    echo "" >&2
    echo "Fix: close the Agent Observer window (or exit Copilot CLI), then re-run this script." >&2
    exit 1
  fi
fi
cp -R "${source_dir}" "${target_dir}"

echo "Installed Agent Observer to ${target_dir}"
echo ""
echo "Next steps:"
echo "  1. Already in Copilot CLI with experimental/extensions enabled?"
echo "     Ask Copilot to reload extensions (extensions_reload), then run /agent-observer."
echo "  2. Starting fresh?"
echo "     Run: copilot --experimental"
echo "     Then: /env to confirm, /agent-observer to launch."

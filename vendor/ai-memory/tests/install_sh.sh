#!/usr/bin/env bash
# install.sh refusals, run against crafted release tarballs in a temp dir:
# a symlink or hard-link member is refused before anything is unpacked, a
# plain release installs, and the wget fallback pins https for the default
# GitHub base (refusing a wget that cannot). Needs no network.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-memory-install-sh.XXXXXX")"
trap 'rm -rf "${TMP_ROOT}"' EXIT

TARGET=linux-x86_64
ASSET="ai-memory-${TARGET}.tar.gz"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# publish <name> <tree>: a release dir serving latest/download/<asset> and its
# checksum, built from <tree> the way release.yml builds it.
publish() {
  local name="$1" tree="$2" dir="${TMP_ROOT}/$1/release/latest/download"
  mkdir -p "${dir}"
  tar -C "${tree}" -czf "${dir}/${ASSET}" .
  printf '%s  %s\n' "$(sha256 "${dir}/${ASSET}")" "${ASSET}" >"${dir}/${ASSET}.sha256"
  printf '%s\n' "${TMP_ROOT}/${name}/release"
}

plain_tree() {
  local tree="$1"
  mkdir -p "${tree}/hooks"
  printf '#!/bin/sh\necho "ai-memory 0.0.0-test"\n' >"${tree}/ai-memory"
  chmod 0755 "${tree}/ai-memory"
  printf 'echo hook\n' >"${tree}/hooks/_lib.sh"
}

# run_install <case> <base-url> [env...]: install into a fresh home; output in
# <case>/out.log, exit status returned.
run_install() {
  local name="$1" base="$2"
  shift 2
  mkdir -p "${TMP_ROOT}/${name}/home"
  env HOME="${TMP_ROOT}/${name}/home" AI_MEMORY_INSTALL_TARGET="${TARGET}" \
    AI_MEMORY_RELEASE_BASE_URL="${base}" "$@" \
    sh "${ROOT}/install.sh" >"${TMP_ROOT}/${name}/out.log" 2>&1
}

# Control: a release of plain files and directories installs.
plain_tree "${TMP_ROOT}/plain-tree"
base="$(publish plain "${TMP_ROOT}/plain-tree")"
run_install plain "file://${base}" || fail "plain release refused: $(cat "${TMP_ROOT}/plain/out.log")"
[ -x "${TMP_ROOT}/plain/home/.local/lib/ai-memory/ai-memory" ] || fail "plain release not unpacked"
# The test PATH lacks ~/.local/bin, so the next step names the link by its full
# path; with the bin dir on PATH it is the bare command.
grep -Fq "next: ${TMP_ROOT}/plain/home/.local/bin/ai-memory setup" "${TMP_ROOT}/plain/out.log" \
  || fail "off-PATH next step not absolute: $(cat "${TMP_ROOT}/plain/out.log")"
base_on_path="$(publish on-path "${TMP_ROOT}/plain-tree")"
run_install on-path "file://${base_on_path}" PATH="${TMP_ROOT}/on-path/home/.local/bin:${PATH}" \
  || fail "on-PATH install refused: $(cat "${TMP_ROOT}/on-path/out.log")"
grep -Fxq "next: ai-memory setup" <(sed 's/^[^:]*: //' "${TMP_ROOT}/on-path/out.log") \
  || fail "on-PATH next step not the bare command: $(cat "${TMP_ROOT}/on-path/out.log")"

# A symlink member pointing outside the tree is refused, and nothing lands.
plain_tree "${TMP_ROOT}/symlink-tree"
ln -s /etc/passwd "${TMP_ROOT}/symlink-tree/hooks/escape"
base="$(publish symlink "${TMP_ROOT}/symlink-tree")"
if run_install symlink "file://${base}"; then
  fail "a release with a symlink member was installed"
fi
grep -Fq "not a plain file or directory" "${TMP_ROOT}/symlink/out.log" \
  || fail "symlink refusal not explained: $(cat "${TMP_ROOT}/symlink/out.log")"
[ ! -e "${TMP_ROOT}/symlink/home/.local/lib/ai-memory" ] || fail "a refused release was unpacked"

# A hard-link member is refused the same way.
plain_tree "${TMP_ROOT}/hardlink-tree"
ln "${TMP_ROOT}/hardlink-tree/hooks/_lib.sh" "${TMP_ROOT}/hardlink-tree/hooks/again.sh"
base="$(publish hardlink "${TMP_ROOT}/hardlink-tree")"
if run_install hardlink "file://${base}"; then
  fail "a release with a hard-link member was installed"
fi
grep -Fq "not a plain file or directory" "${TMP_ROOT}/hardlink/out.log" \
  || fail "hard-link refusal not explained: $(cat "${TMP_ROOT}/hardlink/out.log")"

# wget fallback: with no curl on PATH and the default GitHub base, wget runs
# with --https-only; a wget without that flag is refused before downloading.
tools="${TMP_ROOT}/tools"
mkdir -p "${tools}"
for tool in sh awk sed head tar gzip mktemp rm mkdir mv ln chmod dirname uname \
  cat grep sha256sum shasum openssl env printf; do
  path="$(command -v "${tool}" 2>/dev/null || true)"
  case "${path}" in /*) ln -sf "${path}" "${tools}/${tool}" ;; esac
done
plain_tree "${TMP_ROOT}/wget-tree"
wget_dir="$(publish wget "${TMP_ROOT}/wget-tree")/latest/download"
fake_wget() {
  local dir="$1" help="$2"
  mkdir -p "${dir}"
  cat >"${dir}/wget" <<WGET
#!/bin/sh
printf '%s\n' "\$*" >>"${dir}/wget.log"
if [ "\$1" = --help ]; then printf '%s\n' "${help}"; exit 0; fi
out=""; while [ \$# -gt 1 ]; do [ "\$1" = -O ] && out="\$2"; shift; done
cp "${wget_dir}/\$(basename "\$1")" "\${out}"
WGET
  chmod 0755 "${dir}/wget"
}
ln -sf "$(command -v cp)" "${tools}/cp"
ln -sf "$(command -v basename)" "${tools}/basename"
fake_wget "${TMP_ROOT}/wget-gnu" "  --https-only   only follow secure HTTPS links"
run_install wget-gnu "https://github.com/akitaonrails/ai-memory/releases" \
  PATH="${TMP_ROOT}/wget-gnu:${tools}" \
  || fail "GNU wget install failed: $(cat "${TMP_ROOT}/wget-gnu/out.log")"
grep -Fq -- "-q --https-only -O" "${TMP_ROOT}/wget-gnu/wget.log" \
  || fail "default-base wget download did not pin https: $(cat "${TMP_ROOT}/wget-gnu/wget.log")"

fake_wget "${TMP_ROOT}/wget-busybox" "BusyBox wget"
if run_install wget-busybox "https://github.com/akitaonrails/ai-memory/releases" \
  PATH="${TMP_ROOT}/wget-busybox:${tools}"; then
  fail "a wget without --https-only was trusted for the default base"
fi
grep -Fq "cannot refuse a redirect" "${TMP_ROOT}/wget-busybox/out.log" \
  || fail "busybox wget refusal not explained: $(cat "${TMP_ROOT}/wget-busybox/out.log")"
if grep -Fq -- " -O " "${TMP_ROOT}/wget-busybox/wget.log"; then
  fail "a refused wget still downloaded"
fi

# Control: an explicit mirror base keeps plain wget, as with curl.
fake_wget "${TMP_ROOT}/wget-mirror" "BusyBox wget"
run_install wget-mirror "http://mirror.invalid/releases" \
  PATH="${TMP_ROOT}/wget-mirror:${tools}" \
  || fail "mirror wget install failed: $(cat "${TMP_ROOT}/wget-mirror/out.log")"
if grep -Fq -- "--https-only" "${TMP_ROOT}/wget-mirror/wget.log"; then
  fail "an explicit mirror base must not force --https-only"
fi

printf 'install.sh checks passed\n'

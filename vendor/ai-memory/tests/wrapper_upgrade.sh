#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ai-memory-wrapper-upgrade.XXXXXX")"
trap 'rm -rf "${TMP_ROOT}"' EXIT

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1" needle="$2"
  grep -Fq -- "${needle}" "${file}" \
    || fail "${file} does not contain expected text: ${needle}"
}

assert_not_contains() {
  local file="$1" needle="$2"
  if grep -Fq -- "${needle}" "${file}"; then
    fail "${file} unexpectedly contains: ${needle}"
  fi
}

FAKE_DOCKER="${TMP_ROOT}/podman"
cat >"${FAKE_DOCKER}" <<'DOCKER'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"${AI_MEMORY_WRAPPER_TEST_LOG}"

case "${1:-}" in
  pull)
    exit 0
    ;;
  ps)
    printf 'ai-memory\n'
    ;;
  compose)
    if [ "${2:-}" = "ps" ] && [ "${AI_MEMORY_TEST_COMPOSE_OWNS:-}" = "1" ]; then
      printf 'running-container-id\n'
    fi
    ;;
  inspect)
    case "${4:-}" in
      '{{.Id}}') printf 'running-container-id\n' ;;
      '{{.Config.Image}}') printf 'akitaonrails/ai-memory:latest\n' ;;
      *PortBindings*) printf '%s\n' '-p 127.0.0.1:49374:49374/tcp ' ;;
      *Mounts*)
        if printf '%s\n' "${4:-}" | grep -q 'if \.Mode'; then
          printf '%s\n' '-v ai-memory-data:/data:Z '
        else
          printf '%s\n' '-v ai-memory-data:/data '
        fi
        ;;
      *RestartPolicy*) printf '%s\n' '--restart unless-stopped' ;;
      '{{json .Config.Cmd}}') printf '[]\n' ;;
      *'.Config.Env'*)
        if [ "${2:-}" = "ai-memory" ]; then
          printf 'CUSTOM_VAR=custom_val\nHOSTNAME=container-id-123\ncontainer=podman\n'
        fi
        ;;
      *) printf 'unexpected inspect format: %s\n' "${4:-<missing>}" >&2; exit 2 ;;
    esac
    ;;
  *)
    printf 'unexpected docker command: %s\n' "$*" >&2
    exit 2
    ;;
esac
DOCKER
chmod 0755 "${FAKE_DOCKER}"

run_upgrade_case() {
  local name="$1" owns="$2" case_dir log output
  case_dir="${TMP_ROOT}/${name}"
  log="${case_dir}/docker.log"
  output="${case_dir}/output.log"
  mkdir -p "${case_dir}/home" "${case_dir}/cache"
  : >"${case_dir}/docker-compose.yml"

  (
    cd "${case_dir}"
    HOME="${case_dir}/home" \
    XDG_CACHE_HOME="${case_dir}/cache" \
    AI_MEMORY_DOCKER="${FAKE_DOCKER}" \
    AI_MEMORY_SKIP_SELF_UPGRADE=1 \
    AI_MEMORY_WRAPPER_TEST_LOG="${log}" \
    AI_MEMORY_TEST_COMPOSE_OWNS="${owns}" \
      "${ROOT}/bin/ai-memory" upgrade >"${output}" 2>&1
  )
}

run_upgrade_case standalone 0
assert_contains "${TMP_ROOT}/standalone/output.log" "does not manage the running ai-memory container"
assert_not_contains "${TMP_ROOT}/standalone/docker.log" "compose up -d"
assert_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "-v ai-memory-data:/data:Z"
assert_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "-e CUSTOM_VAR=custom_val"
assert_not_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "HOSTNAME="
assert_not_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "container=podman"
assert_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "${FAKE_DOCKER} stop ai-memory"
assert_not_contains "${TMP_ROOT}/standalone/cache/ai-memory/recreate-ai-memory.sh" "docker stop ai-memory"

run_upgrade_case compose 1
assert_contains "${TMP_ROOT}/compose/output.log" "restarting local ai-memory container via ${FAKE_DOCKER} compose"
assert_contains "${TMP_ROOT}/compose/docker.log" "compose up -d"
if [ -e "${TMP_ROOT}/compose/cache/ai-memory/recreate-ai-memory.sh" ]; then
  fail "Compose-owned container unexpectedly produced a standalone recreation script"
fi

# ---- multi-arch manifest version-check tests -----------------------------

if command -v python3 >/dev/null 2>&1; then
  H_INDEX="sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  H_ARM="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  H_AMD="sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  H_OLD="sha256:0000000000000000000000000000000000000000000000000000000000000000"

  MULTI_ARCH_JSON="{\"manifests\":[{\"digest\":\"${H_ARM}\",\"platform\":{\"architecture\":\"arm64\"}},{\"digest\":\"${H_AMD}\",\"platform\":{\"architecture\":\"amd64\"}}]}"

  run_version_check_case() {
    local name="$1" engine_flavor="$2" uname_m="$3" repo_digests="$4" digest_field="$5" buildx_digest="$6" remote_manifest="$7" expect_warn="$8"
    local case_dir="${TMP_ROOT}/ver_${name}"
    mkdir -p "${case_dir}/cache"
    local fake_engine="${case_dir}/engine"
    cat >"${fake_engine}" <<ENGINE
#!/usr/bin/env bash
case "\${1:-}" in
  buildx)
    if [ -n "${buildx_digest}" ]; then
      printf 'Name: %s\nDigest: %s\n' "\${4:-}" "${buildx_digest}"
    else
      printf 'Error: unrecognized command\n' >&2
      exit 1
    fi
    ;;
  image)
    fmt=""
    for arg in "\$@"; do
      case "\${arg}" in
        --format=*) fmt="\${arg#--format=}" ;;
      esac
    done
    case "\${fmt}" in
      *'.Digest'*)
        if [ "${engine_flavor}" = "docker" ]; then
          printf 'template parsing error: map has no entry for key "Digest"\n' >&2
          exit 1
        else
          printf '%b\n' "${digest_field}"
        fi
        ;;
      *'.RepoDigests'*)
        printf '%b\n' "${repo_digests}"
        ;;
      *)
        printf '%b\n' "${repo_digests}"
        ;;
    esac
    ;;
  manifest)
    printf '%b\n' '${remote_manifest}'
    ;;
  info)
    printf 'name=seccomp\n'
    ;;
  run)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
ENGINE
    chmod 0755 "${fake_engine}"

    local fake_uname="${case_dir}/uname"
    cat >"${fake_uname}" <<UNAME
#!/usr/bin/env bash
printf '%s\n' "${uname_m}"
UNAME
    chmod 0755 "${fake_uname}"

    local out="${case_dir}/out.log"
    python3 -c '
import os, pty, sys
master, slave = pty.openpty()
pid = os.fork()
if pid == 0:
    os.close(master)
    os.dup2(slave, 0)
    os.dup2(slave, 1)
    os.dup2(slave, 2)
    os.close(slave)
    env = dict(os.environ)
    env["PATH"] = sys.argv[1] + ":" + env["PATH"]
    env["AI_MEMORY_DOCKER"] = sys.argv[2]
    env["AI_MEMORY_NO_TTY"] = "1"
    env["XDG_CACHE_HOME"] = sys.argv[3]
    env.pop("AI_MEMORY_NO_VERSION_CHECK", None)
    os.execvpe(sys.argv[4], [sys.argv[4], "status"], env)
else:
    os.close(slave)
    output = b""
    while True:
        try:
            chunk = os.read(master, 1024)
            if not chunk: break
            output += chunk
        except OSError:
            break
    os.close(master)
    os.waitpid(pid, 0)
    with open(sys.argv[5], "wb") as f:
        f.write(output)
' "${case_dir}" "${fake_engine}" "${case_dir}/cache" "${ROOT}/bin/ai-memory" "${out}"

    if [ "${expect_warn}" -eq 1 ]; then
      assert_contains "${out}" "a newer image is available on Docker Hub"
    else
      assert_not_contains "${out}" "a newer image is available on Docker Hub"
    fi
  }

  # Podman cases: exposes .Digest and per-arch child digest in .RepoDigests
  run_version_check_case podman_amd64_matching "podman" "x86_64" "${H_INDEX}\n${H_AMD}" "${H_AMD}" "" "${MULTI_ARCH_JSON}" 0
  run_version_check_case podman_amd64_outdated "podman" "x86_64" "${H_INDEX}\n${H_OLD}" "${H_OLD}" "" "${MULTI_ARCH_JSON}" 1
  run_version_check_case podman_arm64_matching "podman" "aarch64" "${H_INDEX}\n${H_ARM}" "${H_ARM}" "" "${MULTI_ARCH_JSON}" 0
  run_version_check_case podman_arm64_outdated "podman" "aarch64" "${H_INDEX}\n${H_OLD}" "${H_OLD}" "" "${MULTI_ARCH_JSON}" 1

  # Docker cases: .Digest fails; .RepoDigests has manifest-list digest; buildx gets remote list digest
  run_version_check_case docker_amd64_matching "docker" "x86_64" "${H_INDEX}" "" "${H_INDEX}" "${MULTI_ARCH_JSON}" 0
  run_version_check_case docker_amd64_outdated "docker" "x86_64" "${H_OLD}" "" "${H_INDEX}" "${MULTI_ARCH_JSON}" 1
  run_version_check_case docker_arm64_matching "docker" "aarch64" "${H_INDEX}" "" "${H_INDEX}" "${MULTI_ARCH_JSON}" 0
  run_version_check_case docker_arm64_outdated "docker" "aarch64" "${H_OLD}" "" "${H_INDEX}" "${MULTI_ARCH_JSON}" 1

  # Classic Docker fallback: no buildx, only manifest-list locally; gated to avoid false positive
  run_version_check_case docker_classic_gated  "docker" "x86_64" "${H_INDEX}" "" "" "${MULTI_ARCH_JSON}" 0
fi

# ---- mcp-bridge native host routing (#1147) -------------------------------

# The session-aware MCP bridge must run on the host: its --server-url loopback
# is unreachable from inside the helper container on Docker Desktop. The
# wrapper must exec the checksum-verified native client without ever invoking
# the container engine.
BRIDGE_CASE_DIR="${TMP_ROOT}/mcp_bridge"
mkdir -p "${BRIDGE_CASE_DIR}/home" "${BRIDGE_CASE_DIR}/cache"

FAKE_NATIVE="${BRIDGE_CASE_DIR}/native-ai-memory"
cat >"${FAKE_NATIVE}" <<'NATIVE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${AI_MEMORY_WRAPPER_TEST_LOG}"
NATIVE
chmod 0755 "${FAKE_NATIVE}"

BRIDGE_DOCKER="${BRIDGE_CASE_DIR}/docker"
cat >"${BRIDGE_DOCKER}" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${AI_MEMORY_DOCKER_TEST_LOG}"
exit 0
DOCKER
chmod 0755 "${BRIDGE_DOCKER}"

: >"${BRIDGE_CASE_DIR}/native.log"
: >"${BRIDGE_CASE_DIR}/docker.log"
HOME="${BRIDGE_CASE_DIR}/home" \
XDG_CACHE_HOME="${BRIDGE_CASE_DIR}/cache" \
AI_MEMORY_DOCKER="${BRIDGE_DOCKER}" \
AI_MEMORY_NATIVE_BIN="${FAKE_NATIVE}" \
AI_MEMORY_WRAPPER_TEST_LOG="${BRIDGE_CASE_DIR}/native.log" \
AI_MEMORY_DOCKER_TEST_LOG="${BRIDGE_CASE_DIR}/docker.log" \
  "${ROOT}/bin/ai-memory" mcp-bridge --server-url http://127.0.0.1:49374/mcp </dev/null

assert_contains "${BRIDGE_CASE_DIR}/native.log" "mcp-bridge --server-url http://127.0.0.1:49374/mcp"
if [ -s "${BRIDGE_CASE_DIR}/docker.log" ]; then
  fail "mcp-bridge unexpectedly reached the container engine: $(cat "${BRIDGE_CASE_DIR}/docker.log")"
fi
printf 'wrapper mcp-bridge native routing checks passed\n'

# ---- lifecycle hook native host routing ----------------------------------

# `ai-memory hook` is what every generated hook config and plugin calls. Inside
# the helper container it costs ~280 ms per event and its default loopback URL
# is the container, not the host server. The wrapper must exec the native
# client with the payload on stdin and never touch the container engine: not
# through AI_MEMORY_DOCKER, and not through a `docker` found on PATH.
HOOK_CASE_DIR="${TMP_ROOT}/hook"
mkdir -p "${HOOK_CASE_DIR}/home" "${HOOK_CASE_DIR}/cache" "${HOOK_CASE_DIR}/path"

HOOK_NATIVE="${HOOK_CASE_DIR}/native-ai-memory"
cat >"${HOOK_NATIVE}" <<'NATIVE'
#!/usr/bin/env bash
printf 'argv: %s\n' "$*" >>"${AI_MEMORY_WRAPPER_TEST_LOG}"
printf 'stdin: %s\n' "$(cat)" >>"${AI_MEMORY_WRAPPER_TEST_LOG}"
NATIVE
chmod 0755 "${HOOK_NATIVE}"

for engine in docker podman; do
  cat >"${HOOK_CASE_DIR}/path/${engine}" <<'DOCKER'
#!/usr/bin/env bash
printf '%s %s\n' "$(basename "$0")" "$*" >>"${AI_MEMORY_DOCKER_TEST_LOG}"
exit 0
DOCKER
  chmod 0755 "${HOOK_CASE_DIR}/path/${engine}"
done

run_hook_case() {
  local native_bin="$1"
  shift
  HOME="${HOOK_CASE_DIR}/home" \
  XDG_CACHE_HOME="${HOOK_CASE_DIR}/cache" \
  PATH="${HOOK_CASE_DIR}/path:${PATH}" \
  AI_MEMORY_DOCKER="${HOOK_CASE_DIR}/path/docker" \
  AI_MEMORY_NATIVE_BIN="${native_bin}" \
  AI_MEMORY_WRAPPER_TEST_LOG="${HOOK_CASE_DIR}/native.log" \
  AI_MEMORY_DOCKER_TEST_LOG="${HOOK_CASE_DIR}/docker.log" \
    "${ROOT}/bin/ai-memory" "$@"
}

assert_no_container() {
  if [ -s "${HOOK_CASE_DIR}/docker.log" ]; then
    fail "$1 unexpectedly reached the container engine: $(cat "${HOOK_CASE_DIR}/docker.log")"
  fi
}

: >"${HOOK_CASE_DIR}/native.log"
: >"${HOOK_CASE_DIR}/docker.log"
printf '{"session_id":"s-1"}' \
  | run_hook_case "${HOOK_NATIVE}" hook --agent claude-code --event session-start
assert_contains "${HOOK_CASE_DIR}/native.log" "argv: hook --agent claude-code --event session-start"
assert_contains "${HOOK_CASE_DIR}/native.log" 'stdin: {"session_id":"s-1"}'
assert_no_container "hook"

: >"${HOOK_CASE_DIR}/native.log"
run_hook_case "${HOOK_NATIVE}" hook-drain </dev/null
assert_contains "${HOOK_CASE_DIR}/native.log" "argv: hook-drain"
assert_no_container "hook-drain"

# Without a usable native client the hook drops the event, says why on stderr,
# and still exits 0 at once; it never falls back to the container.
: >"${HOOK_CASE_DIR}/native.log"
hook_status=0
printf '{}' | run_hook_case "${HOOK_CASE_DIR}/missing-ai-memory" \
  hook --agent claude-code --event session-start 2>"${HOOK_CASE_DIR}/missing.err" \
  || hook_status=$?
[ "${hook_status}" -eq 0 ] || fail "hook without a native client exited ${hook_status}, want 0"
assert_contains "${HOOK_CASE_DIR}/missing.err" "AI_MEMORY_NATIVE_BIN is not executable"
assert_contains "${HOOK_CASE_DIR}/missing.err" "lifecycle hook event not captured"
assert_no_container "hook without a native client"

# On the hook path the wrapper only reuses an installed client: no update check
# and no download, which could take seconds or hang. With nothing installed it
# never runs curl; with a client installed it execs it without asking GitHub.
cat >"${HOOK_CASE_DIR}/path/curl" <<'CURL'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >>"${AI_MEMORY_DOCKER_TEST_LOG}"
exit 1
CURL
chmod 0755 "${HOOK_CASE_DIR}/path/curl"
run_cached_hook_case() {
  HOME="${HOOK_CASE_DIR}/home" \
  XDG_CACHE_HOME="${HOOK_CASE_DIR}/cache" \
  XDG_DATA_HOME="${HOOK_CASE_DIR}/data" \
  PATH="${HOOK_CASE_DIR}/path:${PATH}" \
  AI_MEMORY_DOCKER="${HOOK_CASE_DIR}/path/docker" \
  AI_MEMORY_WRAPPER_TEST_LOG="${HOOK_CASE_DIR}/native.log" \
  AI_MEMORY_DOCKER_TEST_LOG="${HOOK_CASE_DIR}/docker.log" \
    "${ROOT}/bin/ai-memory" "$@"
}
: >"${HOOK_CASE_DIR}/docker.log"
hook_status=0
printf '{}' | run_cached_hook_case hook --agent claude-code --event session-start \
  2>"${HOOK_CASE_DIR}/uncached.err" || hook_status=$?
[ "${hook_status}" -eq 0 ] || fail "hook with no installed client exited ${hook_status}, want 0"
assert_contains "${HOOK_CASE_DIR}/uncached.err" "not installed yet"
assert_no_container "hook with no installed client (no curl, no engine)"

mkdir -p "${HOOK_CASE_DIR}/data/ai-memory/native-runner"
cp "${HOOK_NATIVE}" "${HOOK_CASE_DIR}/data/ai-memory/native-runner/ai-memory"
: >"${HOOK_CASE_DIR}/native.log"
: >"${HOOK_CASE_DIR}/docker.log"
printf '{"session_id":"s-2"}' \
  | run_cached_hook_case hook --agent claude-code --event user-prompt-submit
assert_contains "${HOOK_CASE_DIR}/native.log" "argv: hook --agent claude-code --event user-prompt-submit"
assert_no_container "hook with an installed client (no update check)"
printf 'wrapper hook native routing checks passed\n'

printf 'wrapper upgrade ownership checks passed\n'

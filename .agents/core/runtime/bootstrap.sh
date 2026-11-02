# Loaded by .agents/ksf; no Node.js or package manager is needed here.

ksf_fail() {
  printf 'KSF runtime error [%s]: %s\n' "$1" "$2" >&2
  exit 1
}

ksf_read_manifest() {
  # Deliberately supports only the fixed scalar runtime schema documented in
  # bootstrap.md. No eval, YAML aliases, tags, multiline values or shell code.
  ksf_metadata=$(awk -v platform="$KSF_PLATFORM" '
    function fail(message) { print "KSF manifest error: " message > "/dev/stderr"; failed=1; exit 1 }
    function scalar(value) {
      sub(/^[ ]+/, "", value); sub(/[ ]+$/, "", value)
      if (value ~ /^"[^"]*"$/) value=substr(value, 2, length(value)-2)
      if (value ~ /[|\\\t\r]/) fail("unsupported scalar syntax")
      return value
    }
    /^[ ]*(#|$)/ { next }
    /^runtime:$/ { if (++roots != 1) fail("duplicate runtime section"); inside=1; next }
    /^[^ ]/ { inside=0; next }
    !inside { next }
    /^  [a-z][a-z0-9_]*:/ {
      line=$0; sub(/^  /, "", line); key=line; sub(/:.*/, "", key)
      value=line; sub(/^[^:]*:[ ]*/, "", value)
      if (seen[key]++) fail("duplicate runtime key " key)
      if (key=="packages") { if (value!="") fail("packages must be a mapping"); packages=1; next }
      packages=0
      if (key=="bootstrap_protocol" || key=="engine" || key=="version" || key=="source_entry") root[key]=scalar(value)
      next
    }
    packages && /^    [a-z0-9-]+:$/ {
      target=$0; sub(/^    /, "", target); sub(/:$/, "", target)
      if (targets[target]++) fail("duplicate platform " target)
      next
    }
    packages && /^      [a-z][a-z0-9_]*:/ {
      line=$0; sub(/^      /, "", line); key=line; sub(/:.*/, "", key)
      value=line; sub(/^[^:]*:[ ]*/, "", value)
      if (fields[target SUBSEP key]++) fail("duplicate package key " key)
      if (key!="archive_path" && key!="archive_root" && key!="archive_sha256" && key!="node_sha256" && key!="distribution_url") fail("unknown package key " key)
      if (target==platform) package[key]=scalar(value)
      next
    }
    { fail("unsupported runtime YAML syntax") }
    END {
      if (failed) exit 1
      if (roots!=1 || root["bootstrap_protocol"]!="1" || root["engine"]!="nodejs") fail("unsupported bootstrap protocol or engine")
      if (!targets[platform]) fail("no bundled package for " platform)
      if (root["version"] !~ /^[0-9]+\.[0-9]+\.[0-9]+$/) fail("an exact Node.js version is required")
      entry=root["source_entry"]; path=package["archive_path"]; directory=package["archive_root"]
      if (entry !~ /^\.agents\/core\/runtime\/src\/[A-Za-z0-9_.\/-]+\.js$/ || entry ~ /\.\.|\/\//) fail("invalid source_entry")
      if (path !~ /^\.agents\/core\/runtime\/packages\/[A-Za-z0-9_.-]+\.tar\.gz$/ || path ~ /\.\./) fail("invalid archive_path")
      if (directory!="node-v" root["version"] "-" platform) fail("archive_root does not match version and platform")
      if (length(package["archive_sha256"])!=64 || package["archive_sha256"] !~ /^[0-9a-f]+$/) fail("invalid archive_sha256")
      if (length(package["node_sha256"])!=64 || package["node_sha256"] !~ /^[0-9a-f]+$/) fail("invalid node_sha256")
      printf "%s|%s|%s|%s|%s|%s\n", root["version"], entry, path, directory, package["archive_sha256"], package["node_sha256"]
    }
  ' "$KSF_ROOT/.agents/core/manifest.yaml") || ksf_fail MANIFEST_INVALID 'Cannot read the required runtime declaration.'
  IFS='|' read -r KSF_NODE_VERSION ksf_source_entry ksf_archive_path ksf_archive_root ksf_archive_sha ksf_node_sha <<EOF
$ksf_metadata
EOF
  ksf_set_runtime_paths
}

ksf_set_runtime_paths() {
  KSF_CLI="$KSF_ROOT/$ksf_source_entry"
  ksf_archive="$KSF_ROOT/$ksf_archive_path"
  ksf_identity="$KSF_NODE_VERSION-$KSF_PLATFORM-$ksf_archive_sha"
  ksf_runtime_home="$KSF_ROOT/.agents/runtime-data/runtime"
  ksf_install="$ksf_runtime_home/node/$ksf_identity"
  KSF_NODE="$ksf_install/bin/node"
}

ksf_read_build_config() {
  # Build must not depend on its output manifest. macOS plutil reads the pinned
  # JSON input before Node.js exists; package hashes are trusted build inputs.
  ksf_config="$KSF_ROOT/.agents/core/build.json"
  [ -f "$ksf_config" ] && [ ! -L "$ksf_config" ] || ksf_fail BUILD_CONFIG_INVALID 'Missing .agents/core/build.json.'
  if [ "$KSF_PLATFORM" = linux-x64 ]; then
    [ -x /usr/bin/python3 ] || ksf_fail BUILD_CONFIG_INVALID 'Linux build requires Python 3; normal startup does not.'
    ksf_build_metadata=$(/usr/bin/python3 "$KSF_ROOT/.agents/core/runtime/tools/bootstrap-config.py" "$ksf_config" "$KSF_PLATFORM") || ksf_fail BUILD_CONFIG_INVALID 'Cannot read Linux build configuration.'
    IFS='|' read -r KSF_NODE_VERSION ksf_archive_path ksf_archive_sha <<EOF
$ksf_build_metadata
EOF
  else
  [ "$(/usr/bin/plutil -extract schema_version raw -o - "$ksf_config")" = 1 ] || ksf_fail BUILD_CONFIG_INVALID 'Unsupported build schema.'
  KSF_NODE_VERSION=$(/usr/bin/plutil -extract runtime.version raw -o - "$ksf_config") || ksf_fail BUILD_CONFIG_INVALID 'Missing Node.js version.'
  ksf_archive_path=$(/usr/bin/plutil -extract "runtime.packages.$KSF_PLATFORM.archive_path" raw -o - "$ksf_config") || ksf_fail BUILD_CONFIG_INVALID 'No build package for this platform.'
  ksf_archive_sha=$(/usr/bin/plutil -extract "runtime.packages.$KSF_PLATFORM.archive_sha256" raw -o - "$ksf_config") || ksf_fail BUILD_CONFIG_INVALID 'Missing trusted package SHA256.'
  fi
  printf '%s|%s|%s\n' "$KSF_NODE_VERSION" "$ksf_archive_path" "$ksf_archive_sha" | awk -F'|' '
    NF!=3 || $1 !~ /^[0-9]+\.[0-9]+\.[0-9]+$/ ||
    $2 !~ /^\.agents\/core\/runtime\/packages\/[A-Za-z0-9_.-]+\.tar\.gz$/ || $2 ~ /\.\./ ||
    length($3)!=64 || $3 !~ /^[0-9a-f]+$/ { exit 1 }
  ' || ksf_fail BUILD_CONFIG_INVALID 'Invalid version, package path or package SHA256.'
  ksf_source_entry=.agents/core/runtime/src/cli.js
  ksf_archive_root="node-v$KSF_NODE_VERSION-$KSF_PLATFORM"
  ksf_node_sha=pending
  ksf_set_runtime_paths
  ksf_check_archive
  ksf_validate_archive
  mkdir -p "$ksf_runtime_home/staging"
  ksf_input_stage=$(mktemp -d "$ksf_runtime_home/staging/build-input.XXXXXXXX") || ksf_fail INSTALL_FAILED 'Cannot inspect the build package.'
  LC_ALL=C tar -xOzf "$ksf_archive" "$ksf_archive_root/bin/node" > "$ksf_input_stage/node" || ksf_fail ARCHIVE_INVALID 'Cannot read Node.js from the build package.'
  ksf_node_sha=$(ksf_sha256 "$ksf_input_stage/node") || ksf_fail ARCHIVE_INVALID 'Cannot hash the build Node.js executable.'
  rm -rf "$ksf_input_stage"
  ksf_input_stage=''
}

ksf_fingerprint() {
  if [ "$KSF_PLATFORM" = linux-x64 ]; then
    stat -c '%s:%Y:%Z:%i:%f' "$1"
  else
    stat -f '%z:%m:%c:%i:%p' "$1"
  fi
}

ksf_probe_install() {
  ksf_probe=missing
  [ -f "$ksf_install/.install-record" ] && [ ! -L "$ksf_install/.install-record" ] &&
    [ -f "$KSF_NODE" ] && [ ! -L "$KSF_NODE" ] && [ -x "$KSF_NODE" ] || return 0
  ksf_record_fingerprint=$(awk -F= -v version="$KSF_NODE_VERSION" -v platform="$KSF_PLATFORM" \
    -v archive="$ksf_archive_sha" -v node="$ksf_node_sha" '
    { if (NF!=2 || seen[$1]++) exit 1; value[$1]=$2 }
    END {
      if (NR!=6 || value["protocol"]!="1" || value["version"]!=version || value["platform"]!=platform ||
          value["archive_sha256"]!=archive || value["node_sha256"]!=node || value["fingerprint"] !~ /^[0-9a-f:]+$/) exit 1
      print value["fingerprint"]
    }' "$ksf_install/.install-record") || return 0
  ksf_current_fingerprint=$(ksf_fingerprint "$KSF_NODE") || return 0
  ksf_probe=changed
  [ "$ksf_current_fingerprint" != "$ksf_record_fingerprint" ] || ksf_probe=ready
}

ksf_sha256() {
  if [ "$KSF_PLATFORM" = linux-x64 ]; then
    ksf_hash_output=$(LC_ALL=C sha256sum "$1") || return 1
  else
    ksf_hash_output=$(LC_ALL=C shasum -a 256 "$1") || return 1
  fi
  printf '%s\n' "${ksf_hash_output%% *}"
}

ksf_verify_node() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -x "$1" ] || return 1
  ksf_actual_sha=$(ksf_sha256 "$1") || return 1
  [ "$ksf_actual_sha" = "$ksf_node_sha" ] || return 1
  ksf_actual_version=$("$1" --version) || return 1
  [ "$ksf_actual_version" = "v$KSF_NODE_VERSION" ]
}

ksf_write_record() {
  ksf_record_node="$1/bin/node"
  ksf_record_stat=$(ksf_fingerprint "$ksf_record_node") || ksf_fail INSTALL_FAILED 'Cannot inspect prepared Node.js.'
  printf 'protocol=1\nversion=%s\nplatform=%s\narchive_sha256=%s\nnode_sha256=%s\nfingerprint=%s\n' \
    "$KSF_NODE_VERSION" "$KSF_PLATFORM" "$ksf_archive_sha" "$ksf_node_sha" "$ksf_record_stat" > "$1/.install-record.$$"
  mv "$1/.install-record.$$" "$1/.install-record"
}

ksf_release_lock() {
  if [ "$ksf_lock_owned" = 1 ]; then
    if [ "$KSF_PLATFORM" = linux-x64 ]; then
      exec 9>&-
    else
      rm -f "$ksf_lock"
    fi
    ksf_lock_owned=0
  fi
}

ksf_cleanup() {
  [ -z "$ksf_input_stage" ] || rm -rf "$ksf_input_stage"
  [ -z "$ksf_stage" ] || rm -rf "$ksf_stage"
  ksf_release_lock
}

ksf_lock_runtime() {
  mkdir -p "$ksf_runtime_home/node" "$ksf_runtime_home/staging" "$ksf_runtime_home/locks"
  ksf_lock="$ksf_runtime_home/locks/$ksf_identity.lock"
  [ ! -L "$ksf_lock" ] || ksf_fail UNSAFE_PATH 'Runtime lock is a symbolic link.'
  if [ "$KSF_PLATFORM" = linux-x64 ]; then
    [ -x /usr/bin/flock ] || ksf_fail LOCK_UNAVAILABLE 'Linux runtime preparation requires flock.'
    exec 9>"$ksf_lock"
    /usr/bin/flock -w 30 9 || ksf_fail LOCK_TIMEOUT 'Timed out waiting for runtime preparation.'
  else
  # macOS supplies shlock: atomic link-based PID locks with stale-owner recovery.
  # Wait is bounded; an unrelated process reusing a stale PID cannot cause an
  # indefinite wait or an unsafe lock steal.
  [ -x /usr/bin/shlock ] || ksf_fail LOCK_UNAVAILABLE 'This platform requires the native shlock utility.'
  ksf_attempt=0
  until /usr/bin/shlock -f "$ksf_lock" -p "$$"; do
    ksf_attempt=$((ksf_attempt + 1))
    [ "$ksf_attempt" -lt 300 ] || ksf_fail LOCK_TIMEOUT 'Timed out waiting for runtime preparation.'
    sleep 0.1
  done
  fi
  ksf_lock_owned=1
  # With this identity's lock held, no live preparer can own these directories.
  # Recover leftovers from untrappable interruption such as SIGKILL.
  for ksf_orphan in "$ksf_runtime_home/staging/$ksf_identity".*; do
    [ ! -d "$ksf_orphan" ] || rm -rf "$ksf_orphan"
  done
}

ksf_check_archive() {
  [ -f "$ksf_archive" ] && [ ! -L "$ksf_archive" ] || ksf_fail ARCHIVE_MISSING 'The declared bundled archive is missing.'
  ksf_actual_archive_sha=$(ksf_sha256 "$ksf_archive") || ksf_fail ARCHIVE_INVALID 'Cannot read the bundled archive.'
  [ "$ksf_actual_archive_sha" = "$ksf_archive_sha" ] || ksf_fail ARCHIVE_INVALID 'The bundled archive SHA256 does not match manifest.yaml.'
}

ksf_validate_archive() {
  # Only these two regular files are needed. Never unpack npm, headers, archive
  # symlinks or other entries into the repository or the installed runtime.
  ksf_archive_listing=$(LC_ALL=C tar -tvzf "$ksf_archive" "$ksf_archive_root/bin/node" "$ksf_archive_root/LICENSE") || ksf_fail ARCHIVE_INVALID 'Required files are missing from the archive.'
  printf '%s\n' "$ksf_archive_listing" | awk '
    substr($0, 1, 1)!="-" { bad=1 }
    END { if (NR!=2 || bad) exit 1 }
  ' || ksf_fail ARCHIVE_INVALID 'The archive must contain one regular Node.js file and one regular LICENSE file.'
}

ksf_install_runtime() {
  ksf_check_archive
  printf 'KSF: preparing Node.js %s (%s).\n' "$KSF_NODE_VERSION" "$KSF_PLATFORM" >&2
  ksf_stage=$(mktemp -d "$ksf_runtime_home/staging/$ksf_identity.XXXXXXXX") || ksf_fail INSTALL_FAILED 'Cannot create a staging directory.'
  ksf_validate_archive
  LC_ALL=C tar -xzf "$ksf_archive" -C "$ksf_stage" "$ksf_archive_root/bin/node" "$ksf_archive_root/LICENSE" || ksf_fail INSTALL_FAILED 'Cannot extract the bundled runtime.'
  ksf_prepared="$ksf_stage/$ksf_archive_root"
  [ -f "$ksf_prepared/LICENSE" ] && [ ! -L "$ksf_prepared/LICENSE" ] || ksf_fail ARCHIVE_INVALID 'Invalid Node.js license file.'
  ksf_verify_node "$ksf_prepared/bin/node" || ksf_fail NODE_INVALID 'Prepared Node.js does not match the declared SHA256 or version.'
  ksf_write_record "$ksf_prepared"
  # A failed preparation has not touched the previous installation. Only a
  # fully verified replacement may retire a damaged installation of this key.
  if [ -e "$ksf_install" ] || [ -L "$ksf_install" ]; then
    mv "$ksf_install" "$ksf_stage/previous" || ksf_fail INSTALL_FAILED 'Cannot retire the damaged installation.'
  fi
  if ! mv "$ksf_prepared" "$ksf_install"; then
    [ ! -e "$ksf_stage/previous" ] || mv "$ksf_stage/previous" "$ksf_install"
    ksf_fail INSTALL_FAILED 'Cannot publish the verified runtime.'
  fi
}

ksf_prepare_locked_runtime() {
  ksf_lock_runtime
  ksf_probe_install
  if [ "$ksf_force_verify" = 1 ]; then ksf_check_archive; fi
  if [ "$ksf_probe" = changed ] || { [ "$ksf_probe" = ready ] && [ "$ksf_force_verify" = 1 ]; }; then
    if ksf_verify_node "$KSF_NODE"; then
      ksf_write_record "$ksf_install"
      ksf_probe=ready
    else
      ksf_probe=missing
    fi
  fi
  if [ "$ksf_probe" != ready ]; then ksf_install_runtime; fi
  ksf_cleanup
  ksf_stage=''
}

ksf_prepare_runtime() {
  unset KSF_BOOTSTRAP_VERIFIED
  ksf_lock_owned=0
  ksf_lock=''
  ksf_stage=''
  ksf_input_stage=''
  trap 'ksf_cleanup' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM HUP
  ksf_system=$(uname -s)
  ksf_machine=$(uname -m)
  case "$ksf_system-$ksf_machine" in
    Darwin-arm64) KSF_PLATFORM=darwin-arm64 ;;
    Darwin-x86_64) KSF_PLATFORM=darwin-x64 ;;
    Linux-x86_64) KSF_PLATFORM=linux-x64 ;;
    *) ksf_fail UNSUPPORTED_PLATFORM 'Supported bundled targets: macOS ARM64 and Linux x64; Windows x64 uses ksf.ps1.' ;;
  esac
  if [ "${1-}" = build ]; then ksf_read_build_config; else ksf_read_manifest; fi
  [ -f "$KSF_CLI" ] || ksf_fail CLI_MISSING 'The declared JavaScript entry is missing.'
  ksf_force_verify=0
  if [ "${1-}" = runtime ] && [ "${2-}" = verify ]; then ksf_force_verify=1; fi
  ksf_probe_install
  if [ "$ksf_probe" != ready ] || [ "$ksf_force_verify" = 1 ]; then
    if [ "$KSF_PLATFORM" = linux-x64 ]; then
      # flock's descriptor belongs only to this preparation subshell. The
      # launcher must preserve every caller-owned descriptor for the CLI.
      (
        trap 'ksf_cleanup' EXIT
        trap 'exit 130' INT
        trap 'exit 143' TERM HUP
        ksf_prepare_locked_runtime
      )
    else
      ksf_prepare_locked_runtime
    fi
  fi
  if [ "$ksf_force_verify" = 1 ]; then
    KSF_BOOTSTRAP_VERIFIED=1
    export KSF_BOOTSTRAP_VERIFIED
  fi
  trap - EXIT INT TERM HUP
}

# Stable launcher protocol 1 delegates all normal-command policy to Core.
ksf_bootstrap_main() {
  ksf_prepare_runtime "$@"
  # Version checks and installation require an explicit system command.
  # KSF_SKIP_AUTO_UPDATE remains accepted for compatibility but has no effect.
  exec "$KSF_NODE" "$KSF_CLI" "$@"
}

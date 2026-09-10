#!/usr/bin/env bash

RP_OWNERSHIP_MANIFEST="${RP_OWNERSHIP_MANIFEST:-/var/lib/resourceportal/installer-state/owned-resources}"

rp_ownership_record() {
  local type="$1" value="$2" path="${RP_OWNERSHIP_MANIFEST}" tmp
  [[ "$type" =~ ^[a-z0-9-]+$ ]] || return 1
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1

  umask 077
  mkdir -p "$(dirname "$path")" || return 1
  touch "$path" || return 1
  chmod 0600 "$path" || return 1
  grep -Fxq -- "$type $value" "$path" && return 0

  tmp="${path}.tmp.$$"
  cat "$path" >"$tmp" || { rm -f "$tmp"; return 1; }
  printf '%s %s\n' "$type" "$value" >>"$tmp" || { rm -f "$tmp"; return 1; }
  chmod 0600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv -f "$tmp" "$path"
}

rp_ownership_has() {
  local type="$1" value="$2"
  [[ -r "${RP_OWNERSHIP_MANIFEST}" ]] && grep -Fxq -- "$type $value" "${RP_OWNERSHIP_MANIFEST}"
}

rp_ownership_values() {
  local type="$1"
  [[ -r "${RP_OWNERSHIP_MANIFEST}" ]] || return 0
  awk -v type="$type" '$1 == type { sub(/^[^ ]+ /, ""); print }' "${RP_OWNERSHIP_MANIFEST}"
}

rp_package_installed() {
  dpkg-query -W -f='${db:Status-Abbrev}\n' "$1" 2>/dev/null | grep -q '^ii '
}

rp_installed_package_names() {
  dpkg-query -W -f='${db:Status-Abbrev} ${binary:Package}\n' 2>/dev/null \
    | awk '$1 ~ /^ii/ && NF >= 2 { print $2 }' \
    | LC_ALL=C sort -u
}

rp_apt_install_with_ownership() {
  local ownership_tmpdir before after install_rc package
  local -a packages=("$@")
  ((${#packages[@]} > 0)) || return 0

  ownership_tmpdir="$(mktemp -d /tmp/resourceportal-package-ownership.XXXXXX)" || return 1
  before="$ownership_tmpdir/before"
  after="$ownership_tmpdir/after"
  if ! rp_installed_package_names >"$before"; then
    rm -rf "$ownership_tmpdir"
    return 1
  fi

  if DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"; then
    install_rc=0
  else
    install_rc=$?
  fi

  if ! rp_installed_package_names >"$after"; then
    rm -rf "$ownership_tmpdir"
    return 1
  fi

  while IFS= read -r package; do
    [[ -n "$package" ]] || continue
    if ! rp_ownership_record package "$package"; then
      rm -rf "$ownership_tmpdir"
      return 1
    fi
  done < <(LC_ALL=C comm -13 "$before" "$after")
  rm -rf "$ownership_tmpdir"

  (( install_rc == 0 )) || return "$install_rc"
}

rp_install_packages_with_ownership() {
  local package
  local -a packages=("$@")

  ((${#packages[@]} > 0)) || return 0

  apt-get update || return 1
  rp_apt_install_with_ownership "${packages[@]}" || return $?

  for package in "${packages[@]}"; do
    rp_package_installed "$package" || return 1
  done
}

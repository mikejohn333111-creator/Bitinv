#!/usr/bin/env bash
# Dry-run tests for server/setup.sh and server/uninstall.sh.
#
#   bash tools/test-setup.sh            # offline: fake Node.js release, fake app repo
#   bash tools/test-setup.sh --real-node  # also installs the real Node.js 22 from nodejs.org
#   bash tools/test-setup.sh --real-app   # also installs this checkout and starts its real server
#
# Every run happens inside a temporary folder (TBOT_SETUP_ROOT). System commands
# (systemctl, apt-get, ss, curl, useradd, caddy, ufw, iptables, ...) are replaced
# by small fakes that record what they were asked to do, and PATH only reaches
# harmless real tools, so nothing on this machine is changed. Run it as root,
# because the scripts refuse to run otherwise.
set -euo pipefail

HERE=$(cd "$(dirname "$0")/.." && pwd)
SETUP=$HERE/server/setup.sh
UNINSTALL=$HERE/server/uninstall.sh
DOCKER_CADDY=$HERE/server/docker-caddy.sh
REAL_NODE=$(command -v node)
REAL_CURL=$(command -v curl)
REAL_NODE_RUN=0
REAL_APP_RUN=0
for a in "$@"; do
  case $a in
    --real-node) REAL_NODE_RUN=1 ;;
    --real-app) REAL_APP_RUN=1 ;;
    *) echo "usage: $0 [--real-node] [--real-app]" >&2; exit 2 ;;
  esac
done

T=$(mktemp -d "${TMPDIR:-/tmp}/tbot-setup-test.XXXXXX")
if [[ -n ${TBOT_TEST_KEEP:-} ]]; then echo "Keeping test files in $T"; else trap 'rm -rf "$T"' EXIT; fi
PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
}
check() { # check "description" command...
  local d=$1
  shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}
has() { grep -qF -- "$2" "$1" 2>/dev/null; }
lacks() { ! grep -qF -- "$2" "$1" 2>/dev/null; }
count() { grep -cF -- "$2" "$1" 2>/dev/null || true; }

# ------------------------------------------------------------ safe PATH
SAFE=$T/safebin
mkdir -p "$SAFE"
for c in bash sh env cat cp mv rm mkdir rmdir ln chmod touch ls find sort tail head tr sed awk mawk grep cmp \
  date dirname basename uname install mktemp sha256sum tar xz flock git node printf id stat wc cut readlink seq \
  realpath diff stty tee; do
  p=$(command -v "$c" || true)
  [[ -n $p ]] && ln -sf "$p" "$SAFE/$c"
done

# ------------------------------------------------------------ fakes
STUBS=$T/stubs
mkdir -p "$STUBS"
mk() {
  cat >"$STUBS/$1"
  chmod +x "$STUBS/$1"
}

mk systemctl <<'EOF'
#!/bin/bash
S=$STUB_STATE
echo "systemctl $*" >>"$S/calls.log"
caddy_snapshot() {
  # What Caddy would load: the Caddyfile plus the files its top-level imports match.
  local cf=$ROOT/etc/caddy/Caddyfile pat f
  : >"$S/caddy-loaded"
  [[ -f $cf ]] || return 0
  cat "$cf" >>"$S/caddy-loaded"
  while read -r pat; do
    pat=${pat//\"/}
    [[ $pat == /* ]] && pat=$ROOT$pat || pat=$ROOT/etc/caddy/$pat
    for f in $pat; do [[ -f $f ]] && cat "$f" >>"$S/caddy-loaded"; done
  done < <(sed -n 's/^import[[:space:]]\+\([^[:space:]]*\).*/\1/p' "$cf")
}
listen_del() { grep -v "pid=$1," "$S/listen" >"$S/listen.tmp" || true; mv "$S/listen.tmp" "$S/listen"; }
start() {
  case $1 in
    tbot)
      local port
      port=$(sed -n 's/^TBOT_PORT=//p' "$ROOT/etc/tbot.env")
      listen_del 4242
      echo "LISTEN 0      511        127.0.0.1:$port      0.0.0.0:*    users:((\"node\",pid=4242,fd=21))" >>"$S/listen"
      echo 4242 >"$S/pid-tbot"
      touch "$S/active-tbot"
      echo x >>"$S/restarts-tbot"
      ;;
    caddy)
      [[ -z ${STUB_CADDY_START_FAIL:-} ]] || return 1
      caddy validate --config "$ROOT/etc/caddy/Caddyfile" >/dev/null || return 1
      listen_del 5151
      echo 'LISTEN 0      4096               *:80              *:*    users:(("caddy",pid=5151,fd=7))' >>"$S/listen"
      echo 'LISTEN 0      4096               *:443             *:*    users:(("caddy",pid=5151,fd=8))' >>"$S/listen"
      echo 5151 >"$S/pid-caddy"
      touch "$S/active-caddy"
      caddy_snapshot
      ;;
  esac
}
stop() {
  rm -f "$S/active-$1"
  [[ -f $S/pid-$1 ]] && listen_del "$(cat "$S/pid-$1")"
  rm -f "$S/pid-$1"
}
cmd=$1
shift
case $cmd in
  daemon-reload | reset-failed) exit 0 ;;
  enable | disable)
    now=0
    [[ $1 == --now ]] && { now=1; shift; }
    if [[ $cmd == enable ]]; then touch "$S/enabled-$1"; ((now)) && start "$1"; else rm -f "$S/enabled-$1"; ((now)) && stop "$1"; fi
    exit 0
    ;;
  start | restart) start "$1" ;;
  stop) stop "$1" ;;
  reload)
    [[ -f $S/active-$1 ]] || exit 1
    if [[ $1 == caddy ]]; then
      [[ -z ${STUB_CADDY_RELOAD_FAIL:-} ]] || exit 1
      caddy validate --config "$ROOT/etc/caddy/Caddyfile" >/dev/null || exit 1
      caddy_snapshot
      echo x >>"$S/reloads-caddy"
    fi
    ;;
  is-active) [[ $1 == --quiet ]] && shift; [[ -f $S/active-$1 ]] ;;
  show)
    name=${*: -1}
    if [[ -f $S/active-$name && -f $S/pid-$name ]]; then cat "$S/pid-$name"; else echo 0; fi
    ;;
  cat) [[ -f $S/unit-$1 ]] ;;
  *) exit 0 ;;
esac
EOF

mk ss <<'EOF'
#!/bin/bash
echo "ss $*" >>"$STUB_STATE/calls.log"
cat "$STUB_STATE/listen"
EOF

mk dpkg-query <<'EOF'
#!/bin/bash
pkg=${*: -1}
if grep -qx "$pkg" "$STUB_STATE/pkgs"; then printf 'install ok installed'; else exit 1; fi
EOF

mk apt-get <<'EOF'
#!/bin/bash
S=$STUB_STATE
echo "apt-get $*" >>"$S/calls.log"
words=()
while (($#)); do
  case $1 in
    -o) shift 2 ;;
    -*) shift ;;
    *) words+=("$1"); shift ;;
  esac
done
cmd=${words[0]}
case $cmd in
  update) exit 0 ;;
  install)
    for p in "${words[@]:1}"; do
      [[ ${STUB_APT_FAIL:-} == "$p" ]] && exit 100
      echo "$p" >>"$S/pkgs"
      if [[ $p == caddy ]]; then
        cp "$STUB_OPT/caddy" "$STUB_BIN/caddy"
        mkdir -p "$ROOT/etc/caddy"
        cp "$STUB_OPT/Caddyfile.stock" "$ROOT/etc/caddy/Caddyfile"
        touch "$S/unit-caddy"
        systemctl enable --now caddy
      fi
    done
    ;;
  purge | remove)
    for p in "${words[@]:1}"; do
      if [[ $p == caddy ]]; then
        systemctl stop caddy
        rm -f "$STUB_BIN/caddy" "$S/unit-caddy"
        [[ $cmd == purge ]] && rm -rf "$ROOT/etc/caddy"
      fi
      grep -vx "$p" "$S/pkgs" >"$S/pkgs.tmp" || true
      mv "$S/pkgs.tmp" "$S/pkgs"
    done
    ;;
esac
EOF

mkdir -p "$T/stubopt"
mk ../stubopt/caddy <<'EOF'
#!/bin/bash
echo "caddy $*" >>"$STUB_STATE/calls.log"
case $1 in
  validate)
    cfg=""
    while (($#)); do [[ $1 == --config ]] && cfg=$2; shift; done
    [[ -z ${STUB_CADDY_VALIDATE_FAIL:-} ]] || { echo "Error: fake validation failure" >&2; exit 1; }
    ! grep -q INVALID "$cfg"
    ;;
  version) echo "v2.10.0 fake" ;;
esac
EOF
cat >"$T/stubopt/Caddyfile.stock" <<'EOF'
# The Caddyfile is an easy way to configure your Caddy web server.
#
# Unless the file starts with a global options block, the first
# uncommented line is always the address of your site.
#
# To use your own domain name (with automatic HTTPS), first make
# sure your domain's A/AAAA DNS records are properly pointed to
# this machine's public IP, then replace ":80" below with your
# domain name.

:80 {
	# Set this path to your site's directory.
	root * /usr/share/caddy

	# Enable the static file server.
	file_server

	# Another common task is to set up a reverse proxy:
	# reverse_proxy localhost:8080

	# Or serve a PHP site through php-fpm:
	# php_fastcgi localhost:9000
}

# Refer to the Caddy docs for more information:
# https://caddyserver.com/docs/caddyfile
EOF

mk curl <<'EOF'
#!/bin/bash
S=$STUB_STATE
out="" url="" resolve="" wfmt=""
while (($#)); do
  case $1 in
    -o) out=$2; shift 2 ;;
    -w) wfmt=$2; shift 2 ;;
    --resolve) resolve=$2; shift 2 ;;
    --max-time | --retry | --noproxy) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
echo "curl $url${resolve:+ resolve=$resolve}" >>"$S/calls.log"
emit() { if [[ -n $out ]]; then cat >"$out"; else cat; fi; }
case $url in
  https://nodejs.org/dist/*)
    if [[ -n ${STUB_REAL_NODE:-} ]]; then
      if [[ -n $out ]]; then exec "$REAL_CURL" -fsSL -o "$out" "$url"; else exec "$REAL_CURL" -fsSL "$url"; fi
    fi
    f=$STUB_NODE_DIST/${url#https://nodejs.org/dist/}
    [[ -f $f ]] || exit 22
    emit <"$f"
    ;;
  https://api.ipify.org) [[ -n ${STUB_IP_A:-} ]] || exit 7; printf '%s' "$STUB_IP_A" | emit ;;
  https://ifconfig.me/ip) [[ -n ${STUB_IP_B:-} ]] || exit 7; printf '%s\n' "$STUB_IP_B" | emit ;;
  https://icanhazip.com) [[ -n ${STUB_IP_C:-} ]] || exit 7; printf '%s\n' "$STUB_IP_C" | emit ;;
  */public/caddy/stable/gpg.key)
    printf -- '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nZmFrZQ==\n-----END PGP PUBLIC KEY BLOCK-----\n' | emit ;;
  http://127.0.0.1:*/healthz)
    port=${url#http://127.0.0.1:}; port=${port%%/*}
    [[ -f $S/active-tbot ]] && grep -q "127.0.0.1:$port .*pid=4242" "$S/listen" || exit 7
    echo ok | emit ;;
  http://172.*:*/healthz)
    # The bot's extra address (the Docker network's gateway), asked from this server.
    a=${url#http://}; a=${a%%/*}
    [[ -f $S/active-tbot ]] || exit 7
    [[ ${a%:*} == "$(sed -n 's/^TBOT_EXTRA_HOST=//p' "$ROOT/etc/tbot.env")" ]] || exit 7
    [[ ${a#*:} == "$(sed -n 's/^TBOT_PORT=//p' "$ROOT/etc/tbot.env")" ]] || exit 7
    echo ok | emit ;;
  https://*/healthz)
    host=${url#https://}; host=${host%%/*}
    [[ -z ${STUB_CERT_FAIL:-} && ( -f $S/active-caddy || -f $S/reloads-docker ) ]] || exit 35
    grep -q "^$host {" "$S/caddy-loaded" 2>/dev/null || exit 35
    echo ok | emit ;;
  http*://*/)
    # A website behind the Caddy container: $S/site-<name> holds "code-before code-after-reload".
    host=${url#*://}; host=${host%%[:/]*}
    read -r b a <"$S/site-$host" 2>/dev/null || { b=000 a=000; }
    code=$b
    [[ -f $S/reloads-docker ]] && code=${a:-$b}
    [[ $code == 000 ]] || echo page | emit
    [[ -z $wfmt ]] || printf '%s' "$code"
    [[ $code != 000 ]] || exit 7 ;;
  *) exit 6 ;;
esac
EOF

mk ufw <<'EOF'
#!/bin/bash
S=$STUB_STATE
echo "ufw $*" >>"$S/calls.log"
touch "$S/ufw-rules"
[[ $1 == --force ]] && shift
case $1 in
  status)
    if [[ -n ${STUB_UFW_ACTIVE:-} ]]; then
      printf 'Status: active\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW       Anywhere\n'
      cat "$S/ufw-rules"
    else
      echo "Status: inactive"
    fi ;;
  allow)
    if [[ $2 == in ]]; then
      touch "$S/ufw-in"
      if grep -qxF "${*:2}" "$S/ufw-in"; then echo "Skipping adding existing rule"; else echo "${*:2}" >>"$S/ufw-in"; echo "Rule added"; fi
    else
      grep -q "^$2 " "$S/ufw-rules" || printf '%-26s ALLOW       Anywhere\n' "$2" >>"$S/ufw-rules"
    fi ;;
  delete)
    if [[ $3 == in ]]; then
      grep -vxF "${*:3}" "$S/ufw-in" >"$S/ufw.tmp" || true; mv "$S/ufw.tmp" "$S/ufw-in"
    else
      grep -v "^$3 " "$S/ufw-rules" >"$S/ufw.tmp" || true; mv "$S/ufw.tmp" "$S/ufw-rules"
    fi ;;
esac
EOF

mk iptables <<'EOF'
#!/bin/bash
S=$STUB_STATE
F=$S/iptables
touch "$F"
echo "iptables $*" >>"$S/calls.log"
op=$1 chain=$2
shift 2
case $op in
  -S) echo "-P INPUT ${STUB_IPT_POLICY:-ACCEPT}"; sed 's/^/-A INPUT /' "$F" ;;
  -C) grep -qxF -- "$*" "$F" ;;
  -I)
    n=$1; shift
    awk -v n="$n" -v r="$*" 'NR == n { print r } { print } END { if (NR < n) print r }' "$F" >"$F.tmp"; mv "$F.tmp" "$F" ;;
  -D) awk -v r="$*" '$0 == r && !d { d = 1; next } { print }' "$F" >"$F.tmp"; mv "$F.tmp" "$F" ;;
  -L)
    echo "Chain INPUT (policy ACCEPT)"
    echo "num  target     prot opt source               destination"
    awk '{ t = "?"; for (i = 1; i < NF; i++) if ($i == "-j") t = $(i + 1); print NR, t, "all", "--", "0.0.0.0/0", "0.0.0.0/0" }' "$F" ;;
esac
EOF

mk netfilter-persistent <<'EOF'
#!/bin/bash
echo "netfilter-persistent $*" >>"$STUB_STATE/calls.log"
EOF

mk useradd <<'EOF'
#!/bin/bash
echo "useradd $*" >>"$STUB_STATE/calls.log"
echo "${*: -1}" >>"$STUB_STATE/users"
[[ " $* " == *" --user-group "* ]] && echo "${*: -1}" >>"$STUB_STATE/groups"
exit 0
EOF
mk userdel <<'EOF'
#!/bin/bash
echo "userdel $*" >>"$STUB_STATE/calls.log"
grep -vx "$1" "$STUB_STATE/users" >"$STUB_STATE/u.tmp" || true; mv "$STUB_STATE/u.tmp" "$STUB_STATE/users"
grep -vx "$1" "$STUB_STATE/groups" >"$STUB_STATE/g.tmp" || true; mv "$STUB_STATE/g.tmp" "$STUB_STATE/groups"
EOF
mk groupdel <<'EOF'
#!/bin/bash
echo "groupdel $*" >>"$STUB_STATE/calls.log"
grep -vx "$1" "$STUB_STATE/groups" >"$STUB_STATE/g.tmp" || true; mv "$STUB_STATE/g.tmp" "$STUB_STATE/groups"
EOF
mk getent <<'EOF'
#!/bin/bash
case $1 in
  passwd) grep -qx "$2" "$STUB_STATE/users" && echo "$2:x:999:999::/opt/tbot:/usr/sbin/nologin" ;;
  group) grep -qx "$2" "$STUB_STATE/groups" && echo "$2:x:999:" ;;
  *) exit 2 ;;
esac
EOF
mk chown <<'EOF'
#!/bin/bash
echo "chown $*" >>"$STUB_STATE/calls.log"
EOF
mk runuser <<'EOF'
#!/bin/bash
echo "runuser ${*:1:2}" >>"$STUB_STATE/calls.log"
while (($#)) && [[ $1 != -- ]]; do shift; done
shift
exec "$@"
EOF
mk journalctl <<'EOF'
#!/bin/bash
echo "(fake journal)"
EOF
# Fake Docker. $S/docker holds the running containers ("name<TAB>image" in containers),
# each container's command, mounts and networks (c-<name>/), and the networks (n-<id>).
mk docker <<'EOF'
#!/bin/bash
S=$STUB_STATE
D=$S/docker
echo "docker $*" >>"$S/calls.log"
[[ -d $D ]] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
cmd=$1
shift
fmt=""
if [[ ${1:-} == -f || ${1:-} == --format ]]; then fmt=$2; shift 2; fi
# The Caddyfile path inside the container, as a file on this (fake) server.
host_path() {
  local c=$1 in=$2 type src dst
  while IFS='|' read -r type src dst; do
    if [[ $in == "$dst" ]]; then echo "$ROOT$src"; return; fi
    if [[ $in == "$dst"/* ]]; then echo "$ROOT$src${in#"$dst"}"; return; fi
  done <"$D/c-$c/mounts"
  echo "/nonexistent"
}
fw_open() { # is the bot's port open to the container network?
  local g=$1 p=$2
  if [[ -n ${STUB_UFW_ACTIVE:-} ]]; then grep -q "to $g port $p proto tcp" "$S/ufw-in" 2>/dev/null || return 1; fi
  if [[ ${STUB_IPT_POLICY:-ACCEPT} != ACCEPT ]]; then grep -q -- "-d $g -p tcp --dport $p -j ACCEPT" "$S/iptables" 2>/dev/null || return 1; fi
  [[ -z ${STUB_DOCKER_UNREACHABLE:-} ]]
}
case $cmd in
  info) exit 0 ;;
  ps)
    if [[ $fmt == *.Names* ]]; then cat "$D/containers"; else cut -f2 "$D/containers"; fi ;;
  inspect)
    c=$1
    [[ -d $D/c-$c ]] && grep -q "^$c	" "$D/containers" || { echo "Error: No such object: $c" >&2; exit 1; }
    case $fmt in
      *State.Running*) echo true ;;
      *.Path*) cat "$D/c-$c/args" ;;
      *.Mounts*) cat "$D/c-$c/mounts" ;;
      *NetworkMode*) cat "$D/c-$c/netmode" 2>/dev/null || echo server_default ;;
      *NetworkID*) cat "$D/c-$c/networks" ;;
      *NetworkSettings.Networks*) cut -d'|' -f1 "$D/c-$c/networks" | tr '\n' ' ' ;;
      *Config.Image*) grep "^$c	" "$D/containers" | cut -f2 ;;
    esac ;;
  network)
    [[ $1 == inspect ]] && shift
    [[ $1 == -f ]] && shift 2
    cat "$D/n-$1" ;;
  exec)
    c=$1
    shift
    case "$1 $2" in
      "sh -c") [[ -z ${STUB_NO_WGET:-} ]] && echo /usr/bin/wget ;;
      "wget -qO-")
        url=${*: -1}; a=${url#http://}; a=${a%%/*}
        env_host=$(sed -n 's/^TBOT_EXTRA_HOST=//p' "$ROOT/etc/tbot.env")
        env_port=$(sed -n 's/^TBOT_PORT=//p' "$ROOT/etc/tbot.env")
        if [[ -f $S/active-tbot && ${a%:*} == "$env_host" && ${a#*:} == "$env_port" ]] && fw_open "$env_host" "$env_port"; then
          echo ok
        else
          echo "wget: can't connect to remote host: Connection refused" >&2; exit 1
        fi ;;
      "caddy validate" | "caddy reload")
        cfg=""
        for ((i = 1; i <= $#; i++)); do [[ ${!i} == --config ]] && { j=$((i + 1)); cfg=${!j}; }; done
        f=$(host_path "$c" "$cfg")
        [[ -f $f ]] || { echo "Error: reading config file: open $cfg: no such file or directory" >&2; exit 1; }
        [[ -z ${STUB_CADDY_VALIDATE_FAIL:-} ]] || { echo "Error: adapting config using caddyfile: fake validation failure" >&2; exit 1; }
        ! grep -q INVALID "$f" || { echo "Error: unrecognized directive: INVALID" >&2; exit 1; }
        if [[ $2 == reload ]]; then
          [[ -z ${STUB_CADDY_RELOAD_FAIL:-} ]] || { echo "Error: sending configuration to instance: fake" >&2; exit 1; }
          cp "$f" "$S/caddy-loaded"
          echo x >>"$S/reloads-docker"
        fi
        echo "Valid configuration" ;;
      *) exit 127 ;;
    esac ;;
  *) exit 0 ;;
esac
EOF

mk sleep <<'EOF'
#!/bin/bash
exit 0
EOF

# ------------------------------------------------------------ fake Node.js releases
DIST=$T/dist
FAKE_V=v22.99.1
mkdir -p "$DIST/$FAKE_V"
for arch in x64 arm64; do
  d=$T/build/node-$FAKE_V-linux-$arch
  mkdir -p "$d/bin"
  # shellcheck disable=SC2016 # $1 and $@ belong to the fake node script
  printf '#!/bin/sh\nif [ "$1" = "--version" ]; then echo %s; exit 0; fi\nexec %s "$@"\n' "$FAKE_V" "$REAL_NODE" >"$d/bin/node"
  chmod +x "$d/bin/node"
  # Fake npm: notes how it was called in the folder it runs in.
  # shellcheck disable=SC2016
  printf '#!/bin/sh\necho "npm $* cache=$npm_config_cache" >.npm-called\n[ -d "$npm_config_cache" ] || exit 9\n' >"$d/bin/npm"
  chmod +x "$d/bin/npm"
  tar -C "$T/build" -cJf "$DIST/$FAKE_V/node-$FAKE_V-linux-$arch.tar.xz" "node-$FAKE_V-linux-$arch"
done
(
  cd "$DIST/$FAKE_V"
  sha256sum node-*.tar.xz
  echo "0000000000000000000000000000000000000000000000000000000000000000  node-$FAKE_V-linux-x64.tar.gz"
) >"$DIST/$FAKE_V/SHASUMS256.txt"
cat >"$DIST/index.json" <<EOF
[
{"version":"v24.9.0","date":"2026-09-01","files":["linux-arm64","linux-x64"],"lts":"Krypton","security":false},
{"version":"$FAKE_V","date":"2026-09-01","files":["linux-arm64","linux-x64"],"lts":"Jod","security":false},
{"version":"v22.100.0-rc","date":"2026-09-01","files":["linux-x64"],"lts":false,"security":false},
{"version":"v22.98.0","date":"2026-08-01","files":["linux-arm64","linux-x64"],"lts":"Jod","security":false},
{"version":"v20.30.0","date":"2026-08-01","files":["linux-arm64","linux-x64"],"lts":"Iron","security":false}
]
EOF

# ------------------------------------------------------------ fake app repository
REMOTE=$T/remote.git
git init -q --bare -b main "$REMOTE"
W=$T/work
git init -q -b main "$W"
mkdir -p "$W/server"
cat >"$W/package.json" <<'EOF'
{ "name": "fake-tbot", "private": true, "type": "module", "devDependencies": { "ws": "^8.18.0" } }
EOF
cat >"$W/server/main.mjs" <<'EOF'
// Stand-in for the real server: only "set-password" is needed by the setup.
// Understands TBOT_EXTRA_HOST like the real server (checked by docker-caddy.sh).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const dir = process.env.TBOT_DATA_DIR || ".tbot-data";
if (process.argv[2] === "set-password") {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const pw = Buffer.concat(chunks).toString("utf8");
  if (pw.length < 10) { console.error("The password needs at least 10 characters."); process.exit(2); }
  const salt = crypto.randomBytes(16);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
    salt: salt.toString("hex"), hash: crypto.scryptSync(pw, salt, 32).toString("hex"),
    test_sha: crypto.createHash("sha256").update(pw).digest("hex"),
  }), { mode: 0o600 });
  console.log("Password saved.");
}
EOF
git -C "$W" add -A
git -C "$W" -c user.email=t@t -c user.name=t commit -qm "fake app v1"
git -C "$W" push -q "$REMOTE" main

sha() { printf '%s' "$1" | sha256sum | awk '{print $1}'; }
auth_sha() { sed -n 's/.*"test_sha":"\([0-9a-f]*\)".*/\1/p' "$ROOT/var/lib/tbot/auth.json" 2>/dev/null; }

# ------------------------------------------------------------ scenario plumbing
new_box() { # new_box name: a fresh fake server
  BOX=$T/box-$1
  ROOT=$BOX/root
  ST=$BOX/state
  BIN=$BOX/bin
  mkdir -p "$ROOT/etc" "$ROOT/run/systemd/system" "$ROOT/root" "$ST" "$BIN"
  cp "$STUBS"/* "$BIN/"
  printf 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="22.04"\n' >"$ROOT/etc/os-release"
  printf '%s\n' git curl ca-certificates xz-utils >"$ST/pkgs"
  : >"$ST/listen"
  : >"$ST/users"
  : >"$ST/groups"
  : >"$ST/calls.log"
}
SCENARIO_ENV=()
run() { # run setup|uninstall [args...]; output in $OUT, status in $RC
  local script=$SETUP
  [[ $1 == uninstall ]] && script=$UNINSTALL
  [[ $1 == dc ]] && script=$DOCKER_CADDY
  shift
  OUT=$BOX/out.$((++RUNS))
  RC=0
  env -i PATH="$BIN:$SAFE" HOME=/root TMPDIR="$T" LANG=C.UTF-8 \
    TBOT_SETUP_ROOT="$ROOT" TBOT_REPO_URL="$REMOTE" TBOT_SETUP_NO_TTY=1 TBOT_SETUP_HTTPS_TRIES=2 \
    STUB_STATE="$ST" STUB_BIN="$BIN" STUB_OPT="$T/stubopt" STUB_NODE_DIST="$DIST" ROOT="$ROOT" REAL_CURL="$REAL_CURL" \
    "${SCENARIO_ENV[@]}" bash "$script" "$@" >"$OUT" 2>&1 </dev/null || RC=$?
}
RUNS=0
calls_since() { tail -n +"$1" "$ST/calls.log"; }
mark() { wc -l <"$ST/calls.log"; }
sum_dir() {
  (cd "$1" && find . -type f -o -type l | sort | while read -r f; do
    printf '%s ' "$f"
    if [[ -f $f ]]; then sha256sum <"$f"; else readlink "$f"; fi
  done)
}
nopw() { # the password must never show up in output, logs or results
  local pw=$1 f
  for f in "$OUT" "$ROOT/var/log/tbot-setup.log" "$ROOT/root/tbot-setup-result.txt" "$ROOT/etc/tbot.env" "$ST/calls.log"; do
    if [[ -f $f ]] && grep -qF -- "$pw" "$f"; then return 1; fi
  done
}

PW1='correct horse battery'
PW2='second-Pa55word!'
IP=129.146.10.20
HOSTN=129-146-10-20.sslip.io

# ============================================================ scenarios
echo "1. Fresh server, ports 80/443 free, ufw active, password from TBOT_PASSWORD"
new_box fresh
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "summary shows the https address" has "$OUT" "https://$HOSTN"
check "summary says the bot starts stopped" has "$OUT" "The bot starts stopped"
check "summary warns about profits" has "$OUT" "No bot can guarantee profits"
check "missing iproute2 installed, nothing else" has "$ST/calls.log" "install -y --no-install-recommends iproute2"
check "no apt upgrade" lacks "$ST/calls.log" "upgrade"
check "newest v22 picked (not v24, not rc)" test "$(readlink "$ROOT/opt/tbot/node")" = "node-$FAKE_V"
check "private node runs" test "$("$ROOT/opt/tbot/node/bin/node" --version)" = "$FAKE_V"
check "tbot user created without login" has "$ST/calls.log" "useradd --system --user-group --home-dir /opt/tbot --no-create-home --shell /usr/sbin/nologin tbot"
check "app cloned" test -f "$ROOT/opt/tbot/app/server/main.mjs"
check "data dir is 0700" test "$(stat -c %a "$ROOT/var/lib/tbot")" = 700
check "password stored exactly (no newline added)" test "$(auth_sha)" = "$(sha "$PW1")"
check "set-password ran as tbot" has "$ST/calls.log" "runuser -u tbot"
check "port 8080 chosen" has "$ROOT/etc/tbot.env" "TBOT_PORT=8080"
check "env has host 127.0.0.1" has "$ROOT/etc/tbot.env" "TBOT_HOST=127.0.0.1"
check "env has data dir" has "$ROOT/etc/tbot.env" "TBOT_DATA_DIR=/var/lib/tbot"
check "env trusts the local proxy" has "$ROOT/etc/tbot.env" "TBOT_TRUST_PROXY=1"
U=$ROOT/etc/systemd/system/tbot.service
for want in "User=tbot" "WorkingDirectory=/opt/tbot/app" "EnvironmentFile=/etc/tbot.env" \
  "ExecStart=/opt/tbot/node/bin/node server/main.mjs" "Restart=always" "RestartSec=5" "NoNewPrivileges=yes" \
  "ProtectSystem=strict" "ReadWritePaths=/var/lib/tbot /opt/tbot/app" "ProtectHome=yes" "PrivateTmp=yes" \
  "ProtectKernelTunables=yes" "ProtectControlGroups=yes" "RestrictSUIDSGID=yes" "LockPersonality=yes" "MemoryMax=400M"; do
  check "unit has $want" has "$U" "$want"
done
check "service enabled and restarted" has "$ST/calls.log" "systemctl restart tbot"
check "caddy repo added with signed-by key" has "$ROOT/etc/apt/sources.list.d/caddy-stable.list" "signed-by=/etc/apt/keyrings/caddy-stable.asc"
check "caddy installed with apt" has "$ST/calls.log" "install -y --no-install-recommends caddy"
check "stock Caddyfile backed up" test -f "$ROOT/etc/caddy/Caddyfile.before-tbot"
check "Caddyfile has our marker" has "$ROOT/etc/caddy/Caddyfile" "# tbot-managed:"
check "Caddyfile proxies the host to the port" has "$ROOT/etc/caddy/Caddyfile" "reverse_proxy 127.0.0.1:8080"
check "Caddyfile site is the sslip host" has "$ROOT/etc/caddy/Caddyfile" "$HOSTN {"
check "ufw opened 80" has "$ST/calls.log" "ufw allow 80/tcp"
check "ufw opened 443" has "$ST/calls.log" "ufw allow 443/tcp"
check "no other ufw changes" test "$(grep -c '^ufw allow' "$ST/calls.log")" = 2
check "https checked against the local Caddy" has "$ST/calls.log" "resolve=$HOSTN:443:127.0.0.1"
check "result file written" has "$ROOT/root/tbot-setup-result.txt" "HTTPS: working"
check "result file address line" grep -qx "Web address: https://$HOSTN" "$ROOT/root/tbot-setup-result.txt"
check "result file is private" test "$(stat -c %a "$ROOT/root/tbot-setup-result.txt")" = 600
check "log is private" test "$(stat -c %a "$ROOT/var/log/tbot-setup.log")" = 600
check "password never printed or logged" nopw "$PW1"
check "state records Caddy installed by us" has "$ROOT/opt/tbot/setup-state" "CADDY_INSTALLED_BY_TBOT=1"

echo "2. Same server, run again with nothing new (idempotent)"
before_caddy=$(sha256sum <"$ROOT/etc/caddy/Caddyfile")
restarts=$(wc -l <"$ST/restarts-tbot")
m=$(mark)
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "re-run succeeds (rc=$RC)" test "$RC" = 0
check "Node.js not downloaded again" bash -c "! tail -n +$m '$ST/calls.log' | grep -q 'node-v22.*tar.xz'"
check "bot not restarted" test "$(wc -l <"$ST/restarts-tbot")" = "$restarts"
check "says nothing changed" has "$OUT" "Nothing changed"
check "same port kept even though the bot holds it" has "$ROOT/etc/tbot.env" "TBOT_PORT=8080"
check "Caddyfile unchanged" test "$(sha256sum <"$ROOT/etc/caddy/Caddyfile")" = "$before_caddy"
check "one tbot block only" test "$(count "$ROOT/etc/caddy/Caddyfile" "# BEGIN tbot-managed")" = 1
check "caddy not installed again" bash -c "! tail -n +$m '$ST/calls.log' | grep -q 'install.*caddy'"
check "ufw not changed again" bash -c "! tail -n +$m '$ST/calls.log' | grep -q 'ufw allow'"
check "password kept" test "$(auth_sha)" = "$(sha "$PW1")"
check "keeps password message" has "$OUT" "Keeping the current password"
check "says it was already the newest version" has "$OUT" "Already the newest version"
check "does not claim the bot starts stopped when left running" has "$OUT" "The bot was left running as it was"
check "caddy not reloaded when nothing changed" bash -c "! tail -n +$m '$ST/calls.log' | grep -q 'systemctl reload caddy'"

echo "3. New version on GitHub, password changed, own domain"
echo "// v2" >>"$W/server/main.mjs"
git -C "$W" -c user.email=t@t -c user.name=t commit -qam "fake app v2"
git -C "$W" push -q "$REMOTE" main
SCENARIO_ENV=(TBOT_PASSWORD="$PW2" TBOT_DOMAIN="Bot.Example.com" STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "update run succeeds (rc=$RC)" test "$RC" = 0
check "pulled the new version" has "$ROOT/opt/tbot/app/server/main.mjs" "// v2"
check "bot restarted after update" test "$(wc -l <"$ST/restarts-tbot")" -gt "$restarts"
check "update summary says it carries on" has "$OUT" "If it was trading before, it carries on by itself"
check "password changed" test "$(auth_sha)" = "$(sha "$PW2")"
check "domain lower-cased and used" has "$ROOT/etc/caddy/Caddyfile" "bot.example.com {"
check "old sslip block replaced" lacks "$ROOT/etc/caddy/Caddyfile" "$HOSTN"
check "still one tbot block" test "$(count "$ROOT/etc/caddy/Caddyfile" "# BEGIN tbot-managed")" = 1
check "caddy reloaded" test -s "$ST/reloads-caddy"
check "password never printed or logged" nopw "$PW2"
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "domain remembered on the next run" has "$ROOT/etc/caddy/Caddyfile" "bot.example.com {"

echo "3a. Testing branch first (TBOT_BRANCH), then back to main"
git -C "$W" checkout -q -b server-bot
echo "// branch" >>"$W/server/main.mjs"
git -C "$W" -c user.email=t@t -c user.name=t commit -qam "branch change"
git -C "$W" push -q "$REMOTE" server-bot
git -C "$W" checkout -q main
SCENARIO_ENV=(TBOT_BRANCH=server-bot STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "switched to the test branch (rc=$RC)" has "$ROOT/opt/tbot/app/server/main.mjs" "// branch"
check "says it switched" has "$OUT" "Switched from the main version to the server-bot version"
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "a normal run goes back to main" lacks "$ROOT/opt/tbot/app/server/main.mjs" "// branch"
check "and tracks origin/main again" test "$(git -C "$ROOT/opt/tbot/app" rev-parse --abbrev-ref '@{u}')" = origin/main

echo "3b. A version that needs add-ons (package.json dependencies)"
restarts=$(wc -l <"$ST/restarts-tbot")
sed -i 's/"devDependencies"/"dependencies": { "left-pad": "1.3.0" }, "devDependencies"/' "$W/package.json"
git -C "$W" -c user.email=t@t -c user.name=t commit -qam "needs a dependency"
git -C "$W" push -q "$REMOTE" main
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "run succeeds (rc=$RC)" test "$RC" = 0
check "npm ran in the app folder" test -f "$ROOT/opt/tbot/app/.npm-called"
check "npm cache was inside /opt/tbot (reachable by tbot)" has "$ROOT/opt/tbot/app/.npm-called" "cache=$ROOT/opt/tbot/.npm-cache."
check "npm cache removed afterwards" bash -c "! ls -d '$ROOT'/opt/tbot/.npm-cache.* 2>/dev/null"
check "bot restarted" test "$(wc -l <"$ST/restarts-tbot")" -gt "$restarts"
check "no lockfile: npm install without writing one" has "$ROOT/opt/tbot/app/.npm-called" "npm install --no-package-lock --omit=dev"
echo '{"lockfileVersion":3}' >"$W/package-lock.json"
git -C "$W" add package-lock.json
git -C "$W" -c user.email=t@t -c user.name=t commit -qm "add lockfile"
git -C "$W" push -q "$REMOTE" main
run setup
check "with a lockfile: npm ci" has "$ROOT/opt/tbot/app/.npm-called" "npm ci --omit=dev --no-audit --no-fund"
# Back to an app without add-ons for the scenarios below.
git -C "$W" rm -q package-lock.json
sed -i 's/"dependencies": { "left-pad": "1.3.0" }, //' "$W/package.json"
git -C "$W" -c user.email=t@t -c user.name=t commit -qam "no dependencies again"
git -C "$W" push -q "$REMOTE" main

echo "4. Uninstall --purge on that server"
run uninstall --purge
check "uninstall succeeds (rc=$RC)" test "$RC" = 0
check "service disabled" has "$ST/calls.log" "systemctl disable --now tbot"
check "unit removed" test ! -e "$ROOT/etc/systemd/system/tbot.service"
check "/opt/tbot removed" test ! -e "$ROOT/opt/tbot"
check "/etc/tbot.env removed" test ! -e "$ROOT/etc/tbot.env"
check "data removed with --purge" test ! -e "$ROOT/var/lib/tbot"
check "caddy purged (we installed it, it served only us)" has "$ST/calls.log" "purge -y caddy"
check "caddy repo removed" test ! -e "$ROOT/etc/apt/sources.list.d/caddy-stable.list"
check "ufw rules removed" has "$ST/calls.log" "ufw --force delete allow 443/tcp"
check "tbot user removed" has "$ST/calls.log" "userdel tbot"
check "setup log removed" test ! -e "$ROOT/var/log/tbot-setup.log"

echo "5. Caddy already serves another site and imports a sites folder"
new_box caddy-dropin
mkdir -p "$ROOT/etc/caddy/sites"
printf '{\n\temail me@example.com\n}\n\nexample.com {\n\troot * /srv/www\n\tfile_server\n\timport snippets/*\n}\n\nimport sites/*\n' >"$ROOT/etc/caddy/Caddyfile"
printf 'shop.example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n' >"$ROOT/etc/caddy/sites/shop"
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy" "$ST/active-caddy" "$ST/enabled-caddy"
echo 5151 >"$ST/pid-caddy"
echo caddy >>"$ST/pkgs"
cat >>"$ST/listen" <<'EOF'
LISTEN 0      4096               *:80              *:*    users:(("caddy",pid=5151,fd=7))
LISTEN 0      4096               *:443             *:*    users:(("caddy",pid=5151,fd=8))
LISTEN 0      511          0.0.0.0:8080      0.0.0.0:*    users:(("java",pid=300,fd=9))
EOF
before=$(sha256sum <"$ROOT/etc/caddy/Caddyfile")
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "picked 8081 because 8080 is taken" has "$ROOT/etc/tbot.env" "TBOT_PORT=8081"
check "their Caddyfile untouched" test "$(sha256sum <"$ROOT/etc/caddy/Caddyfile")" = "$before"
check "our site dropped into sites/" has "$ROOT/etc/caddy/sites/tbot" "reverse_proxy 127.0.0.1:8081"
check "their site file untouched" lacks "$ROOT/etc/caddy/sites/shop" "tbot"
check "caddy reloaded, not restarted" bash -c "grep -q 'systemctl reload caddy' '$ST/calls.log' && ! grep -q 'systemctl restart caddy' '$ST/calls.log'"
check "caddy not installed" lacks "$ST/calls.log" "install -y --no-install-recommends caddy"
check "https works" has "$OUT" "All done"
echo '{"appId":"1","token":"pat_secret"}' >"$ROOT/var/lib/tbot/secret.json"
run uninstall --keep-data
check "uninstall succeeds (rc=$RC)" test "$RC" = 0
check "our site file removed" test ! -e "$ROOT/etc/caddy/sites/tbot"
check "their site file kept" test -f "$ROOT/etc/caddy/sites/shop"
check "Caddy kept" lacks "$ST/calls.log" "purge"
check "their Caddyfile still untouched" test "$(sha256sum <"$ROOT/etc/caddy/Caddyfile")" = "$before"
check "data kept with --keep-data" test -f "$ROOT/var/lib/tbot/auth.json"
check "the Deriv token is not kept" test ! -e "$ROOT/var/lib/tbot/secret.json"
check "kept data given to root before the tbot user goes" has "$ST/calls.log" "chown -R root:root $ROOT/var/lib/tbot"
check "says the token was removed" has "$OUT" "Your Deriv token was removed from this server."

echo "6. Caddy serves another site, Caddyfile imports nothing"
new_box caddy-manual
mkdir -p "$ROOT/etc/caddy/common"
printf 'example.com {\n\treverse_proxy 127.0.0.1:3000\n\timport common/*\n}\n' >"$ROOT/etc/caddy/Caddyfile"
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy" "$ST/active-caddy"
echo 5151 >"$ST/pid-caddy"
printf '%s\n' 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=5151,fd=7))' 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=5151,fd=8))' >>"$ST/listen"
before=$(sha256sum <"$ROOT/etc/caddy/Caddyfile")
m=$(mark)
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "their Caddyfile untouched" test "$(sha256sum <"$ROOT/etc/caddy/Caddyfile")" = "$before"
check "import inside a site block is not used as a sites folder" test ! -e "$ROOT/etc/caddy/common/tbot"
check "our site written to its own file" has "$ROOT/etc/caddy/tbot.caddy" "$HOSTN {"
check "prints the import line" has "$OUT" "import /etc/caddy/tbot.caddy"
check "prints the reload command" has "$OUT" "sudo systemctl reload caddy"
check "caddy not reloaded by us" bash -c "! tail -n +$m '$ST/calls.log' | grep -q 'systemctl reload caddy'"
echo 'import /etc/caddy/tbot.caddy' >>"$ROOT/etc/caddy/Caddyfile"
run uninstall --keep-data
check "file kept as a harmless comment while the Caddyfile imports it" bash -c "test -f '$ROOT/etc/caddy/tbot.caddy' && ! grep -q reverse_proxy '$ROOT/etc/caddy/tbot.caddy'"

echo "7. nginx holds ports 80 and 443"
new_box nginx
mkdir -p "$ROOT/etc/nginx"
echo "server { listen 80; }" >"$ROOT/etc/nginx/nginx.conf"
cat >>"$ST/listen" <<'EOF'
LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=1234,fd=6),("nginx",pid=1233,fd=6))
LISTEN 0      511             [::]:80           [::]:*    users:(("nginx",pid=1234,fd=7))
LISTEN 0      511          0.0.0.0:443       0.0.0.0:*    users:(("nginx",pid=1234,fd=8))
LISTEN 0      4096   127.0.0.53%lo:53        0.0.0.0:*    users:(("systemd-resolve",pid=600,fd=14))
EOF
before=$(sum_dir "$ROOT/etc/nginx")
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "names nginx" has "$OUT" "Port 80 is used by: nginx"
check "says the bot runs privately" has "$OUT" "only inside this server for now (127.0.0.1:8080)"
check "asks to send us the details" has "$OUT" "send it to us"
check "details printed inline for copying" has "$OUT" "Bot service: tbot, listening on 127.0.0.1:8080"
check "result file names nginx" has "$ROOT/root/tbot-setup-result.txt" "Port 443 is used by: nginx"
check "no caddy installed" lacks "$ST/calls.log" "caddy"
check "no firewall change" lacks "$ST/calls.log" "ufw allow"
check "nginx config untouched" test "$(sum_dir "$ROOT/etc/nginx")" = "$before"
check "bot still running" test -f "$ST/active-tbot"
check "ready nginx site file written in /opt/tbot" has "$ROOT/opt/tbot/web/nginx-tbot.conf" "proxy_pass http://127.0.0.1:8080;"
# shellcheck disable=SC2016 # literal nginx variables
check "it passes the site name on" has "$ROOT/opt/tbot/web/nginx-tbot.conf" 'proxy_set_header Host $host;'
# shellcheck disable=SC2016
check "it passes the visitor address on" has "$ROOT/opt/tbot/web/nginx-tbot.conf" 'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;'
check "it names the address" has "$ROOT/opt/tbot/web/nginx-tbot.conf" "server_name $HOSTN;"
check "prints the copy step" has "$OUT" "sudo cp /opt/tbot/web/nginx-tbot.conf /etc/nginx/conf.d/tbot.conf"
check "prints the certificate step" has "$OUT" "sudo certbot --nginx -d $HOSTN"
check "no Apache steps for nginx" lacks "$OUT" "a2ensite"

echo "7b. Apache holds ports 80 and 443"
new_box apache
printf '%s\n' 'LISTEN 0 511 *:80 *:* users:(("apache2",pid=777,fd=4))' 'LISTEN 0 511 *:443 *:* users:(("apache2",pid=777,fd=6))' >>"$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "names Apache" has "$OUT" "Port 80 is used by: Apache"
check "ready Apache site file" has "$ROOT/opt/tbot/web/apache-tbot.conf" "ProxyPass / http://127.0.0.1:8080/"
check "prints the Apache steps" bash -c "grep -q 'sudo a2ensite tbot' '$OUT' && grep -q 'sudo certbot --apache -d $HOSTN' '$OUT'"
check "no nginx steps for Apache" lacks "$OUT" "nginx -t"

echo "7c. Caddy installed with its own Caddyfile, but turned off"
new_box caddy-stopped
mkdir -p "$ROOT/etc/caddy"
printf 'example.com {\n\treverse_proxy 127.0.0.1:3000\n}\n' >"$ROOT/etc/caddy/Caddyfile"
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy"
echo caddy >>"$ST/pkgs"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "prints the import line" has "$OUT" "import /etc/caddy/tbot.caddy"
check "says to turn Caddy on, not reload it" bash -c "grep -q 'sudo systemctl start caddy' '$OUT' && ! grep -q 'sudo systemctl reload caddy' '$OUT'"
check "Caddy not started by us" lacks "$ST/calls.log" "systemctl start caddy"

echo "7d. Caddy serves other sites without a Caddyfile"
new_box caddy-nofile
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy" "$ST/active-caddy"
echo 5151 >"$ST/pid-caddy"
echo caddy >>"$ST/pkgs"
printf '%s\n' 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=5151,fd=7))' 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=5151,fd=8))' >>"$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "no import advice for a Caddyfile Caddy doesn't use" lacks "$OUT" "import /etc/caddy/tbot.caddy"
check "explains and asks for the details" bash -c "grep -q 'runs without a Caddyfile' '$OUT' && grep -q 'send it to us' '$OUT'"
check "no Caddyfile created" test ! -e "$ROOT/etc/caddy/Caddyfile"
check "caddy not reloaded" lacks "$ST/calls.log" "systemctl reload caddy"

echo "8. Caddy package with its welcome page on port 80 (installed before, not by us)"
new_box caddy-stock
mkdir -p "$ROOT/etc/caddy"
cp "$T/stubopt/Caddyfile.stock" "$ROOT/etc/caddy/Caddyfile"
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy" "$ST/active-caddy"
echo 5151 >"$ST/pid-caddy"
echo 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=5151,fd=7))' >>"$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "welcome page replaced by our site" has "$ROOT/etc/caddy/Caddyfile" "$HOSTN {"
check "welcome page backed up" cmp -s "$T/stubopt/Caddyfile.stock" "$ROOT/etc/caddy/Caddyfile.before-tbot"
check "state says Caddy was not installed by us" has "$ROOT/opt/tbot/setup-state" "CADDY_INSTALLED_BY_TBOT=0"
run uninstall --purge
check "welcome page put back" cmp -s "$T/stubopt/Caddyfile.stock" "$ROOT/etc/caddy/Caddyfile"
check "Caddy kept (it was there before)" lacks "$ST/calls.log" "purge -y caddy"

echo "9. Oracle Cloud style iptables (REJECT rule), ufw inactive"
new_box oracle
printf '%s\n' "-m state --state RELATED,ESTABLISHED -j ACCEPT" "-p icmp -j ACCEPT" "-i lo -j ACCEPT" \
  "-p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT" "-j REJECT --reject-with icmp-host-prohibited" >"$ST/iptables"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "80 and 443 accepted before the REJECT rule" test "$(awk '/--dport 80 /{a=NR} /--dport 443 /{b=NR} /REJECT/{r=NR} END{print (a<r && b<r && a && b)}' "$ST/iptables")" = 1
check "rules saved with netfilter-persistent" has "$ST/calls.log" "netfilter-persistent save"
run setup
check "re-run adds no duplicate rules" test "$(grep -c -- '--dport 80 ' "$ST/iptables")" = 1
run uninstall --purge
check "uninstall removes our iptables rules" test "$(grep -c -- '--dport 80 \|--dport 443 ' "$ST/iptables")" = 0
check "SSH rule untouched" has "$ST/iptables" "--dport 22 -j ACCEPT"

echo "9b. ufw already allowed port 80: uninstall closes only 443"
new_box ufw-own80
printf '%-26s ALLOW       Anywhere\n' 80/tcp >"$ST/ufw-rules"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "only 443 opened" bash -c "grep -q 'ufw allow 443/tcp' '$ST/calls.log' && ! grep -q 'ufw allow 80/tcp' '$ST/calls.log'"
check "state remembers just 443" has "$ROOT/opt/tbot/setup-state" "UFW_PORTS_ADDED=443"
run setup
check "a re-run keeps the list" has "$ROOT/opt/tbot/setup-state" "UFW_PORTS_ADDED=443"
run uninstall --purge
check "uninstall succeeds (rc=$RC)" test "$RC" = 0
check "443 closed again" has "$ST/calls.log" "ufw --force delete allow 443/tcp"
check "their own 80 rule kept" bash -c "! grep -q 'delete allow 80/tcp' '$ST/calls.log' && grep -q '^80/tcp ' '$ST/ufw-rules'"

echo "9c. iptables already accepted port 80: uninstall removes only our 443 rule"
new_box iptables-own80
printf '%s\n' "-m state --state RELATED,ESTABLISHED -j ACCEPT" "-p tcp -m state --state NEW -m tcp --dport 22 -j ACCEPT" \
  "-p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT" "-j REJECT --reject-with icmp-host-prohibited" >"$ST/iptables"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "state remembers just 443" has "$ROOT/opt/tbot/setup-state" "IPTABLES_PORTS_ADDED=443"
run uninstall --purge
check "our 443 rule removed" test "$(grep -c -- '--dport 443 ' "$ST/iptables")" = 0
check "their own 80 rule kept" test "$(grep -c -- '--dport 80 ' "$ST/iptables")" = 1

echo "10. No password given, no terminal (cloud-init without TBOT_PASSWORD)"
new_box nopw
SCENARIO_ENV=(STUB_IP_A="$IP")
run setup
check "setup still succeeds (rc=$RC)" test "$RC" = 0
check "no auth.json" test ! -e "$ROOT/var/lib/tbot/auth.json"
check "summary says no password yet" has "$OUT" "No password is set yet"
check "service running anyway" test -f "$ST/active-tbot"

echo "11. Password too short"
new_box shortpw
SCENARIO_ENV=(TBOT_PASSWORD="short" STUB_IP_A="$IP")
run setup
check "setup stops (rc=$RC)" test "$RC" != 0
check "explains the 10 character rule" has "$OUT" "at least 10 characters"
check "nothing installed before stopping" test ! -e "$ROOT/opt/tbot"
check "short password not printed" nopw "short"

echo "12. Node.js download damaged"
new_box badnode
cp -r "$DIST" "$BOX/dist"
printf 'garbage' >>"$BOX/dist/$FAKE_V/node-$FAKE_V-linux-x64.tar.xz"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_NODE_DIST="$BOX/dist")
run setup
check "setup stops (rc=$RC)" test "$RC" != 0
check "says the download is damaged" has "$OUT" "checksum does not match"
check "no node installed" test ! -e "$ROOT/opt/tbot/node"

echo "13. nodejs.org release list unreadable: pinned fallback version"
new_box fallback
mkdir -p "$BOX/dist-empty"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_NODE_DIST="$BOX/dist-empty")
run setup
check "falls back to the pinned version" has "$OUT" "Using v22."
check "and stops cleanly when that can't be downloaded either (rc=$RC)" has "$OUT" "Could not download Node.js"

echo "14. Caddy rejects the new settings"
new_box caddy-invalid
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_CADDY_VALIDATE_FAIL=1)
run setup
check "setup finishes (rc=$RC)" test "$RC" = 0
check "Caddyfile change undone (back to the welcome page)" cmp -s "$T/stubopt/Caddyfile.stock" "$ROOT/etc/caddy/Caddyfile"
check "explains" has "$OUT" "undid them"

echo "15. Caddy reload fails while serving another site"
new_box caddy-reloadfail
mkdir -p "$ROOT/etc/caddy/conf.d"
printf 'example.com {\n\tfile_server\n}\nimport conf.d/*.caddy\n' >"$ROOT/etc/caddy/Caddyfile"
cp "$T/stubopt/caddy" "$BIN/caddy"
touch "$ST/unit-caddy" "$ST/active-caddy"
echo 5151 >"$ST/pid-caddy"
printf '%s\n' 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=5151,fd=7))' 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=5151,fd=8))' >>"$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_CADDY_RELOAD_FAIL=1)
run setup
check "setup finishes (rc=$RC)" test "$RC" = 0
check "file name follows the import pattern, then removed again" test ! -e "$ROOT/etc/caddy/conf.d/tbot.caddy"
check "explains" has "$OUT" "could not load the new settings"

echo "16. Caddy listens on 80/443 but is not the caddy service (e.g. in a container)"
new_box caddy-foreign
printf '%s\n' 'LISTEN 0 4096 *:80 *:* users:(("caddy",pid=999,fd=7))' 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=999,fd=8))' >>"$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "treated as someone else's program" has "$OUT" "Port 80 is used by: Caddy"
check "no Caddy installed" lacks "$ST/calls.log" "install -y --no-install-recommends caddy"

echo "17. Public IP detection"
new_box ipfallback
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_B="10.0.0.5" STUB_IP_C="$IP")
run setup
check "skips a failed and a private answer, uses the public one" has "$ROOT/etc/caddy/Caddyfile" "$HOSTN {"
new_box noip
SCENARIO_ENV=(TBOT_PASSWORD="$PW1")
run setup
check "no public IP: still succeeds (rc=$RC)" test "$RC" = 0
check "no public IP: explains TBOT_DOMAIN" has "$OUT" "TBOT_DOMAIN=bot.example.com"
check "no public IP: no Caddy installed" lacks "$ST/calls.log" "install -y --no-install-recommends caddy"

echo "18. Certificate not ready (for example the provider firewall blocks 80/443)"
new_box nocert
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_CERT_FAIL=1)
run setup
check "setup finishes (rc=$RC)" test "$RC" = 0
check "says almost done and mentions the provider firewall" bash -c "grep -q 'Almost done' '$OUT' && grep -q 'provider' '$OUT'"

echo "19. Other systems"
new_box debian12
printf 'ID=debian\nVERSION_ID="12"\n' >"$ROOT/etc/os-release"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "Debian 12 works (rc=$RC)" test "$RC" = 0
new_box centos
printf 'ID="centos"\nVERSION_ID="9"\nID_LIKE="rhel fedora"\n' >"$ROOT/etc/os-release"
run setup
check "CentOS refused (rc=$RC)" bash -c "test $RC != 0 && grep -q 'works on Ubuntu' '$OUT'"
new_box nosystemd
rm -rf "$ROOT/run/systemd"
run setup
check "no systemd refused" has "$OUT" "does not use systemd"

echo "20. Interactive password prompt through a terminal"
if command -v script >/dev/null; then
  new_box tty
  OUT=$BOX/out.tty
  # Type only after the prompt shows, like a person: input sent earlier is echoed by
  # the terminal itself before the script can hide it.
  (sleep 2; printf '%s\n' "$PW2"; sleep 1; printf '%s\n' "$PW2") | env -i PATH="$BIN:$SAFE" HOME=/root TMPDIR="$T" LANG=C.UTF-8 \
    TBOT_SETUP_ROOT="$ROOT" TBOT_REPO_URL="$REMOTE" TBOT_SETUP_HTTPS_TRIES=1 \
    STUB_STATE="$ST" STUB_BIN="$BIN" STUB_OPT="$T/stubopt" STUB_NODE_DIST="$DIST" ROOT="$ROOT" REAL_CURL="$REAL_CURL" STUB_IP_A="$IP" \
    "$(command -v script)" -qec "bash '$SETUP'" /dev/null >"$OUT" 2>&1 || true
  check "asked for the password" has "$OUT" "Choose a password"
  check "typed password saved exactly" test "$(auth_sha)" = "$(sha "$PW2")"
  check "typed password not echoed or logged" nopw "$PW2"
  (sleep 2; printf '\n') | env -i PATH="$BIN:$SAFE" HOME=/root TMPDIR="$T" LANG=C.UTF-8 \
    TBOT_SETUP_ROOT="$ROOT" TBOT_REPO_URL="$REMOTE" TBOT_SETUP_HTTPS_TRIES=1 \
    STUB_STATE="$ST" STUB_BIN="$BIN" STUB_OPT="$T/stubopt" STUB_NODE_DIST="$DIST" ROOT="$ROOT" REAL_CURL="$REAL_CURL" STUB_IP_A="$IP" \
    "$(command -v script)" -qec "bash '$SETUP'" /dev/null >"$OUT" 2>&1 || true
  check "re-run: Enter keeps the password" bash -c "grep -q 'just press Enter' '$OUT' && test '$(auth_sha)' = '$(sha "$PW2")'"
  (sleep 1; printf 'n\n') | env -i PATH="$BIN:$SAFE" HOME=/root TMPDIR="$T" TBOT_SETUP_ROOT="$ROOT" STUB_STATE="$ST" STUB_BIN="$BIN" ROOT="$ROOT" \
    "$(command -v script)" -qec "bash '$UNINSTALL'" /dev/null >"$OUT" 2>&1 || true
  check "uninstall asks about the data and keeps it on no" bash -c "grep -q 'Type yes to delete' '$OUT' && test -d '$ROOT/var/lib/tbot'"
else
  echo "  (skipped: the script command is not installed)"
fi

# ============================================================ Caddy in Docker (docker-caddy.sh)
NET_ID=4f6a1c2b9d8e7f00112233445566778899aabbccddeeff001122334455667788
BR=br-${NET_ID:0:12}
SITE_CF='{
	email admin@example.com
}

api.example.com {
	reverse_proxy api:3000
}

www.example.com, example.com {
	root * /srv
	file_server
}'
dc_box() { # dc_box name file|dir|baked: a server like the one with the Docker Compose website
  new_box "$1"
  printf '%s\n' "# Settings for the Tbot service, written by the Tbot setup script." "TBOT_DATA_DIR=/var/lib/tbot" \
    "TBOT_HOST=127.0.0.1" "TBOT_PORT=8080" "TBOT_TRUST_PROXY=1" "MY_OWN_SETTING=keep" >"$ROOT/etc/tbot.env"
  mkdir -p "$ROOT/opt/tbot/app" "$ROOT/var/lib/tbot"
  touch "$ST/active-tbot" "$ST/unit-tbot"
  echo 4242 >"$ST/pid-tbot"
  echo 'LISTEN 0 511 127.0.0.1:8080 0.0.0.0:* users:(("node",pid=4242,fd=21))' >>"$ST/listen"
  printf '%s\n' 'LISTEN 0 4096 0.0.0.0:80 0.0.0.0:* users:(("docker-proxy",pid=3100,fd=7))' \
    'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=3101,fd=7))' >>"$ST/listen"
  local D=$ST/docker C=$ST/docker/c-server-caddy-1
  mkdir -p "$C"
  printf 'server-api-1\tserver-api\nserver-caddy-1\tcaddy:2-alpine\nserver-db-1\ttimescale/timescaledb:latest-pg16\n' >"$D/containers"
  printf '%s\n' caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >"$C/args"
  echo "server_default|$NET_ID|172.18.0.1|172.18.0.3|16" >"$C/networks"
  echo "bridge||172.18.0.0/16 " >"$D/n-$NET_ID"
  local data="volume|/var/lib/docker/volumes/server_caddy_data/_data|/data"
  case $2 in
    file)
      CF=$ROOT/root/server/Caddyfile
      printf '%s\n' "bind|/root/server/Caddyfile|/etc/caddy/Caddyfile" "$data" >"$C/mounts" ;;
    dir)
      CF=$ROOT/root/server/caddy/Caddyfile
      printf '%s\n' "$data" "bind|/root/server/caddy|/etc/caddy" >"$C/mounts" ;;
    baked)
      CF=$ROOT/root/server/Caddyfile
      printf '%s\n' "$data" >"$C/mounts" ;;
  esac
  mkdir -p "$(dirname "$CF")"
  printf '%s\n' "$SITE_CF" >"$CF"
  cp "$CF" "$BOX/Caddyfile.orig"
  echo "200 200" >"$ST/site-api.example.com"
  echo "301 301" >"$ST/site-www.example.com"
  echo "308 308" >"$ST/site-example.com"
}
inode() { stat -c %i "$1"; }
restarts() { if [[ -f $ST/restarts-tbot ]]; then wc -l <"$ST/restarts-tbot"; else echo 0; fi; }
no_dash() { ! grep -q $'—' "$1"; }
DC_BLOCK=$'# >>> tbot (added by the Tbot setup) >>>\n'"$HOSTN"$' {\n\treverse_proxy 172.18.0.1:8080\n}\n# <<< tbot <<<'

echo "D1. Caddy in Docker, Caddyfile shared as a single file, ufw active"
dc_box dc-file file
ino=$(inode "$CF")
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run dc
check "succeeds (rc=$RC)" test "$RC" = 0
check "names the container" has "$OUT" "Found the Caddy container: server-caddy-1"
check "finds the Caddyfile on this server" has "$OUT" "which is /root/server/Caddyfile on this server"
check "ends with the address" has "$OUT" "https://$HOSTN"
check "says log in with the bot password" has "$OUT" "log in with your bot password"
check "says connect the Deriv token" has "$OUT" "Deriv token"
check "says demo first" has "$OUT" "Start on a demo account"
check "says all done (certificate answered)" has "$OUT" "All done"
check "no em-dashes in the output" no_dash "$OUT"
check "same file (inode kept for the bind mount)" test "$(inode "$CF")" = "$ino"
check "website's own lines unchanged at the top" bash -c "head -n $(wc -l <"$BOX/Caddyfile.orig") '$CF' | cmp -s - '$BOX/Caddyfile.orig'"
check "block appended" test "$(tail -n 5 "$CF")" = "$DC_BLOCK"
check "dated backup equals the old file" bash -c "ls '$ROOT/root/server/'Caddyfile.tbot-backup-[0-9]* >/dev/null && cmp -s '$BOX/Caddyfile.orig' \$(ls '$ROOT/root/server/'Caddyfile.tbot-backup-* | head -n 1)"
check "validated inside the container" has "$ST/calls.log" "docker exec server-caddy-1 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
check "reloaded inside the container" has "$ST/calls.log" "docker exec server-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile"
check "never restarts or recreates the container" bash -c "! grep -qE 'docker (restart|stop|rm|compose|run|kill)' '$ST/calls.log'"
check "env: extra host is the gateway" has "$ROOT/etc/tbot.env" "TBOT_EXTRA_HOST=172.18.0.1"
check "env: trusts the network's range" has "$ROOT/etc/tbot.env" "TBOT_PROXY_IPS=172.18.0.0/16"
check "env: other lines kept" bash -c "grep -qx MY_OWN_SETTING=keep '$ROOT/etc/tbot.env' && grep -qx TBOT_PORT=8080 '$ROOT/etc/tbot.env' && grep -qx TBOT_TRUST_PROXY=1 '$ROOT/etc/tbot.env'"
check "env: records the container and Caddyfile" has "$ROOT/etc/tbot.env" "# tbot-docker-caddy: server-caddy-1|/root/server/Caddyfile|/etc/caddy/Caddyfile"
check "ufw: one narrow rule for the bridge" test "$(cat "$ST/ufw-in")" = "in on $BR to 172.18.0.1 port 8080 proto tcp"
check "env: records the ufw rule" has "$ROOT/etc/tbot.env" "# tbot-docker-caddy-firewall: ufw in on $BR to 172.18.0.1 port 8080 proto tcp"
check "bot restarted once" test "$(restarts)" = 1
check "probed from inside the container" has "$ST/calls.log" "docker exec server-caddy-1 wget -qO- -T 5 http://172.18.0.1:8080/healthz"
check "website checked before and after" bash -c "test \$(grep -c 'curl https://api.example.com:443/ resolve=api.example.com:443:127.0.0.1' '$ST/calls.log') -ge 2"
check "https checked through the container's Caddy" has "$ST/calls.log" "curl https://$HOSTN/healthz resolve=$HOSTN:443:127.0.0.1"
check "log written" test -s "$ROOT/var/log/tbot-docker-caddy.log"
check "a copy kept for the uninstall" test -f "$ROOT/opt/tbot/docker-caddy.sh"

echo "D2. Run again: nothing changes"
sum1=$(sha256sum <"$CF")
nb=$(find "$ROOT/root/server/" -name "*tbot-backup*" | wc -l)
r1=$(restarts)
run dc
check "succeeds (rc=$RC)" test "$RC" = 0
check "Caddyfile unchanged" test "$(sha256sum <"$CF")" = "$sum1"
check "one block only" test "$(count "$CF" '# >>> tbot')" = 1
check "no new backup" test "$(find "$ROOT/root/server/" -name "*tbot-backup*" | wc -l)" = "$nb"
check "bot not restarted" test "$(restarts)" = "$r1"
check "says nothing to change" has "$OUT" "already has the bot's block"
check "ufw rule still recorded (it was ours)" has "$ROOT/etc/tbot.env" "# tbot-docker-caddy-firewall: ufw in"
check "env lines not doubled" test "$(count "$ROOT/etc/tbot.env" TBOT_EXTRA_HOST=)" = 1

echo "D2b. Port changed by the setup: run again updates the block in place"
sed -i 's/^TBOT_PORT=8080/TBOT_PORT=8081/' "$ROOT/etc/tbot.env"
sed -i 's/127.0.0.1:8080/127.0.0.1:8081/' "$ST/listen"
run dc
check "succeeds (rc=$RC)" test "$RC" = 0
check "block replaced, not added" bash -c "test \$(grep -c '# >>> tbot' '$CF') = 1 && grep -q 'reverse_proxy 172.18.0.1:8081' '$CF' && ! grep -q ':8080' '$CF'"
check "old ufw rule removed, new one added" test "$(cat "$ST/ufw-in")" = "in on $BR to 172.18.0.1 port 8081 proto tcp"
sed -i 's/^TBOT_PORT=8081/TBOT_PORT=8080/' "$ROOT/etc/tbot.env"
sed -i 's/127.0.0.1:8081/127.0.0.1:8080/' "$ST/listen"
run dc
check "and back (rc=$RC)" test "$RC" = 0

echo "D3. --remove"
r1=$(restarts)
rl=$(wc -l <"$ST/reloads-docker")
run dc --remove
check "succeeds (rc=$RC)" test "$RC" = 0
check "Caddyfile back to the website's own" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "same file (inode kept)" test "$(inode "$CF")" = "$ino"
check "Caddy reloaded" test "$(wc -l <"$ST/reloads-docker")" -gt "$rl"
check "env lines removed" bash -c "! grep -qE 'TBOT_EXTRA_HOST|TBOT_PROXY_IPS|tbot-docker-caddy' '$ROOT/etc/tbot.env'"
check "env: other lines kept" bash -c "grep -qx MY_OWN_SETTING=keep '$ROOT/etc/tbot.env' && grep -qx TBOT_PORT=8080 '$ROOT/etc/tbot.env'"
check "ufw rule removed" test ! -s "$ST/ufw-in"
check "bot restarted" test "$(restarts)" -gt "$r1"
check "says the website was not changed" has "$OUT" "Your website was not changed"
run dc --remove
check "--remove again is harmless (rc=$RC)" test "$RC" = 0

echo "D4. Caddyfile folder shared, iptables DROP policy, then uninstall"
dc_box dc-dir dir
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_IPT_POLICY=DROP)
run dc
check "succeeds (rc=$RC)" test "$RC" = 0
check "edits the Caddyfile in the shared folder" has "$CF" "reverse_proxy 172.18.0.1:8080"
check "iptables: narrow rule inserted first" test "$(head -n 1 "$ST/iptables")" = "-i $BR -d 172.18.0.1 -p tcp --dport 8080 -j ACCEPT"
check "env: records the iptables rule" has "$ROOT/etc/tbot.env" "# tbot-docker-caddy-firewall: iptables -i $BR -d 172.18.0.1"
check "no ufw used" lacks "$ST/calls.log" "ufw allow"
run uninstall --purge
check "uninstall succeeds (rc=$RC)" test "$RC" = 0
check "uninstall took the block out" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "uninstall removed the iptables rule" test ! -s "$ST/iptables"
check "uninstall reloaded the container's Caddy" test "$(wc -l <"$ST/reloads-docker")" = 2
check "uninstall did not restart the bot it removes" bash -c "test \$(wc -l <'$ST/restarts-tbot') = 1"
check "uninstall removed the env file" test ! -e "$ROOT/etc/tbot.env"
check "uninstall removed the docker-caddy log" test ! -e "$ROOT/var/log/tbot-docker-caddy.log"

echo "D5. Caddyfile built into the image: refused, nothing changed"
dc_box dc-baked baked
cp "$ROOT/etc/tbot.env" "$BOX/env.orig"
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_UFW_ACTIVE=1)
run dc
check "refused (rc=$RC)" test "$RC" != 0
check "explains" has "$OUT" "probably built into the container's image"
check "prints what to send" bash -c "grep -q 'Container: server-caddy-1' '$OUT' && grep -q 'Image: caddy:2-alpine' '$OUT' && grep -q 'server_caddy_data' '$OUT'"
check "env unchanged" cmp -s "$ROOT/etc/tbot.env" "$BOX/env.orig"
check "bot not restarted" test "$(restarts)" = 0
check "Caddy not touched" lacks "$ST/calls.log" "caddy reload"
check "no firewall change" test ! -s "$ST/ufw-in"

echo "D6. Two Caddy containers: refused unless one is named"
dc_box dc-two file
printf 'other-caddy\tcaddy:2\n' >>"$ST/docker/containers"
cp -r "$ST/docker/c-server-caddy-1" "$ST/docker/c-other-caddy"
SCENARIO_ENV=(STUB_IP_A="$IP")
run dc
check "refused (rc=$RC)" test "$RC" != 0
check "names both and how to choose" bash -c "grep -q 'More than one running container has Caddy' '$OUT' && grep -q 'TBOT_CADDY_CONTAINER=' '$OUT'"
check "Caddyfile unchanged" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "env unchanged" lacks "$ROOT/etc/tbot.env" "TBOT_EXTRA_HOST"
SCENARIO_ENV=(STUB_IP_A="$IP" TBOT_CADDY_CONTAINER=server-caddy-1)
run dc
check "TBOT_CADDY_CONTAINER picks one (rc=$RC)" test "$RC" = 0
SCENARIO_ENV=(STUB_IP_A="$IP" TBOT_CADDY_CONTAINER=nope)
run dc --remove
check "a wrong name is reported" has "$OUT" 'no running container called "nope"'

echo "D7. Caddy rejects the new Caddyfile: put back"
dc_box dc-invalid file
ino=$(inode "$CF")
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_CADDY_VALIDATE_FAIL=1)
run dc
check "stops (rc=$RC)" test "$RC" != 0
check "Caddyfile put back" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "same file (inode kept)" test "$(inode "$CF")" = "$ino"
check "never reloaded" lacks "$ST/calls.log" "caddy reload"
check "explains and shows Caddy's message" bash -c "grep -q 'did not accept' '$OUT' && grep -q 'fake validation failure' '$OUT'"

echo "D7b. Caddy reload fails: put back and loaded again"
dc_box dc-reloadfail file
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_CADDY_RELOAD_FAIL=1)
run dc
check "stops (rc=$RC)" test "$RC" != 0
check "Caddyfile put back" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "reload tried again with the old file" test "$(count "$ST/calls.log" "caddy reload")" = 2

echo "D8. A website stops answering after the reload: put back"
dc_box dc-regress file
echo "200 502" >"$ST/site-api.example.com"
SCENARIO_ENV=(STUB_IP_A="$IP")
run dc
check "stops (rc=$RC)" test "$RC" != 0
check "Caddyfile put back" cmp -s "$CF" "$BOX/Caddyfile.orig"
check "Caddy loaded the old file again" bash -c "test \$(wc -l <'$ST/reloads-docker') = 2 && cmp -s '$ST/caddy-loaded' '$BOX/Caddyfile.orig'"
check "names the site" has "$OUT" "https://api.example.com (answered 200 before, now 502)"
dc_box dc-down-before file
echo "000 000" >"$ST/site-api.example.com"
echo "502 000" >"$ST/site-example.com"
run dc
check "sites already down before don't count (rc=$RC)" test "$RC" = 0

echo "D9. The Caddyfile already has a site for the bot's address"
dc_box dc-taken file
printf '\n%s {\n\trespond "hi"\n}\n' "$HOSTN" >>"$CF"
cp "$CF" "$BOX/Caddyfile.orig"
run dc
check "stops (rc=$RC)" test "$RC" != 0
check "explains" has "$OUT" "already has a site for $HOSTN"
check "nothing changed" bash -c "cmp -s '$CF' '$BOX/Caddyfile.orig' && ! grep -q TBOT_EXTRA_HOST '$ROOT/etc/tbot.env'"

echo "D10. The container can't reach the bot: website untouched"
dc_box dc-unreach file
SCENARIO_ENV=(STUB_IP_A="$IP" STUB_DOCKER_UNREACHABLE=1)
run dc
check "stops (rc=$RC)" test "$RC" != 0
check "explains" has "$OUT" "can't reach the bot at 172.18.0.1:8080"
check "Caddyfile untouched" bash -c "cmp -s '$CF' '$BOX/Caddyfile.orig' && ! ls '$ROOT/root/server/' | grep -q tbot-backup"

echo "D11. Other refusals"
dc_box dc-nodocker file
rm -rf "$ST/docker"
SCENARIO_ENV=(STUB_IP_A="$IP")
run dc
check "no Docker: refused (rc=$RC)" bash -c "test $RC != 0 && grep -q 'Docker is not running' '$OUT'"
dc_box dc-nobot file
rm -f "$ROOT/etc/tbot.env"
run dc
check "bot not installed: points to the setup (rc=$RC)" bash -c "test $RC != 0 && grep -q 'not installed yet' '$OUT'"
dc_box dc-json file
printf '%s\n' caddy run --config /etc/caddy/caddy.json >"$ST/docker/c-server-caddy-1/args"
run dc
check "JSON config: refused, nothing changed (rc=$RC)" bash -c "test $RC != 0 && cmp -s '$CF' '$BOX/Caddyfile.orig'"
dc_box dc-domain file
SCENARIO_ENV=(TBOT_DOMAIN=Bot.Example.ORG)
run dc
check "TBOT_DOMAIN is used (rc=$RC)" has "$CF" "bot.example.org {"

echo "D12. The setup on that server points to this script"
dc_box dc-setup file
rm -f "$ROOT/etc/tbot.env" "$ST/active-tbot" "$ST/pid-tbot"
rm -rf "$ROOT/opt/tbot" "$ROOT/var/lib/tbot"
sed -i '/pid=4242/d' "$ST/listen"
SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP")
run setup
check "setup succeeds (rc=$RC)" test "$RC" = 0
check "prints the one-line command" has "$OUT" "curl -fsSL https://tbot-mauve-eta.vercel.app/docker-caddy.sh -o tbot-docker-caddy.sh && sudo bash tbot-docker-caddy.sh"
check "says it is Caddy in Docker" has "$OUT" "Caddy running in a Docker container"
check "no Caddy installed" lacks "$ST/calls.log" "install -y --no-install-recommends caddy"
run dc
check "then docker-caddy works (rc=$RC)" test "$RC" = 0
run setup
check "setup again keeps the extra lines" has "$ROOT/etc/tbot.env" "TBOT_EXTRA_HOST=172.18.0.1"
check "and reports the working address" bash -c "grep -q 'All done' '$OUT' && grep -q 'https://$HOSTN' '$OUT'"

if ((REAL_NODE_RUN)); then
  echo "21. Real Node.js from nodejs.org"
  new_box realnode
  SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" STUB_REAL_NODE=1)
  run setup
  check "setup with real Node.js succeeds (rc=$RC)" test "$RC" = 0
  v=$("$ROOT/opt/tbot/node/bin/node" --version 2>/dev/null || true)
  check "real private Node.js $v runs" bash -c "[[ '$v' == v22.* ]]"
  check "checksum verified" has "$OUT" "Checksum OK"
  check "password set by the real Node.js" test "$(auth_sha)" = "$(sha "$PW1")"
fi

if ((REAL_APP_RUN)); then
  echo "22. This checkout's real server, installed by the setup and started like systemd would"
  RA=$T/realapp
  mkdir -p "$RA"
  (cd "$HERE" && git ls-files -co --exclude-standard -z | grep -zv '^node_modules' | xargs -0 -I{} cp --parents {} "$RA/")
  git init -q -b main "$RA"
  git -C "$RA" add -A
  git -C "$RA" -c user.email=t@t -c user.name=t commit -qm snapshot
  git init -q --bare -b main "$T/realremote.git"
  git -C "$RA" -c push.negotiate=false push -q "$T/realremote.git" main
  new_box realapp
  SCENARIO_ENV=(TBOT_PASSWORD="$PW1" STUB_IP_A="$IP" TBOT_REPO_URL="$T/realremote.git")
  run setup
  check "setup with the real app succeeds (rc=$RC)" test "$RC" = 0
  check "real set-password wrote auth.json" test -s "$ROOT/var/lib/tbot/auth.json"
  check "auth.json is 0600" test "$(stat -c %a "$ROOT/var/lib/tbot/auth.json")" = 600
  check "setup reports the password saved" has "$ROOT/var/log/tbot-setup.log" "Password saved."
  check "password never printed or logged" nopw "$PW1"
  port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  # Start it the way the unit does: WorkingDirectory, EnvironmentFile, ExecStart.
  (
    cd "$ROOT/opt/tbot/app"
    set -a
    # shellcheck disable=SC1091
    . "$ROOT/etc/tbot.env"
    set +a
    export TBOT_DATA_DIR="$ROOT/var/lib/tbot" TBOT_PORT="$port" DERIV_PUBLIC_WS="ws://127.0.0.1:9/" DERIV_API_URL="http://127.0.0.1:9"
    exec "$ROOT/opt/tbot/node/bin/node" server/main.mjs
  ) >"$BOX/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 50); do "$REAL_CURL" -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break; command sleep 0.2; done
  check "real /healthz answers ok" test "$("$REAL_CURL" -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null)" = ok
  code=$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$port" \
    --data "{\"password\":\"$PW1\"}" "http://127.0.0.1:$port/api/login")
  check "real login with the setup password works (HTTP $code)" test "$code" = 200
  code=$("$REAL_CURL" -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$port" \
    --data '{"password":"wrong password 123"}' "http://127.0.0.1:$port/api/login")
  check "real login with a wrong password is refused (HTTP $code)" test "$code" = 401
  hdr=$("$REAL_CURL" -s -D - -o /dev/null -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$port" \
    --data "{\"password\":\"$PW1\"}" "http://127.0.0.1:$port/api/login" | tr -d '\r' | grep -i '^set-cookie' || true)
  check "session cookie is Secure (no TBOT_DEV in the env file)" bash -c "[[ '$hdr' == *Secure* ]]"
  kill "$SRV" 2>/dev/null || true
  wait "$SRV" 2>/dev/null || true
  check "server log has no password" lacks "$BOX/server.log" "$PW1"
fi

echo
echo "passed: $PASS, failed: $FAIL"
((FAIL == 0))

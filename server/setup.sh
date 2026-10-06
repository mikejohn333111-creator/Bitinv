#!/usr/bin/env bash
# Tbot server setup
#
# Installs the Tbot trading bot as a background service on a Linux server, next to
# whatever already runs there. Run it again at any time to update the bot or to
# change its password.
#
#   curl -fsSL https://tbot-mauve-eta.vercel.app/setup.sh -o tbot-setup.sh && sudo bash tbot-setup.sh
#
# Works on Ubuntu 20.04, 22.04, 24.04 and Debian 11, 12 (amd64 or arm64).
#
# What it adds:
#   /opt/tbot                         the bot's files and its own private Node.js
#   /var/lib/tbot                     the bot's saved settings (only the "tbot" user can read them)
#   /etc/tbot.env                     a few settings for the service
#   /etc/systemd/system/tbot.service  the background service
#   Caddy, for the secure https address, only when ports 80 and 443 are free or
#   already used by Caddy.
# What it never does: upgrade the system, change the system's Node.js, npm or nvm,
# change other programs' settings, or take ports 80/443 from another program.
# Log: /var/log/tbot-setup.log (the password is never written anywhere but the
# bot's own password file, and only as a scrypt hash).
#
# Optional settings, as environment variables (sudo env NAME=value bash tbot-setup.sh):
#   TBOT_PASSWORD  the bot password, for setups nobody can type into (cloud-init).
#                  Never put it on a command line others can see.
#   TBOT_DOMAIN    your own domain name for the bot (it is remembered), or "auto"
#                  to go back to the free sslip.io address.
#   TBOT_BRANCH    the version to install (default: main).
set -euo pipefail
set -E

# ==============================================================================
# FOR A BRAND-NEW SERVER ONLY (cloud-init / "user data"):
# Put the bot password between the quotes (at least 10 characters), or set
# TBOT_PASSWORD in the environment instead. Leave it empty to be asked for it.
PRESET_PASSWORD=""
# Optional: your own domain name, already pointing at this server's IP address.
# Leave it empty to get a free address like https://1-2-3-4.sslip.io
PRESET_DOMAIN=""
# ==============================================================================

REPO_URL="${TBOT_REPO_URL:-https://github.com/mikejohn333111-creator/Bitinv.git}"
BRANCH="${TBOT_BRANCH:-main}"
SITE_URL="https://tbot-mauve-eta.vercel.app"
NODE_MAJOR=22
NODE_FALLBACK_VERSION="v22.23.3" # only used when nodejs.org's release list can't be read
NODE_DIST="https://nodejs.org/dist"
CADDY_REPO="https://dl.cloudsmith.io/public/caddy/stable"
PORT_FIRST=8080
PORT_LAST=8099
MARK_BEGIN="# BEGIN tbot-managed"
MARK_END="# END tbot-managed"
MARK_FILE="# tbot-managed:"

# TBOT_SETUP_ROOT is for automated tests only: every file this script writes goes
# under that folder instead of /. Leave it unset on a real server.
R="${TBOT_SETUP_ROOT:-}"

# Paths as the running service sees them.
OPT_REAL=/opt/tbot
APP_REAL=$OPT_REAL/app
NODE_REAL=$OPT_REAL/node
DATA_REAL=/var/lib/tbot
ENV_REAL=/etc/tbot.env
# Paths this script reads and writes.
OPT=$R$OPT_REAL
APP=$R$APP_REAL
NODE_LINK=$R$NODE_REAL
DATA=$R$DATA_REAL
ENV_FILE=$R$ENV_REAL
UNIT_FILE=$R/etc/systemd/system/tbot.service
STATE_FILE=$OPT/setup-state
LOG_FILE=$R/var/log/tbot-setup.log
RESULT_FILE=$R/root/tbot-setup-result.txt
CADDY_DIR=$R/etc/caddy
CADDYFILE=$CADDY_DIR/Caddyfile
CADDY_LIST=$R/etc/apt/sources.list.d/caddy-stable.list
CADDY_KEY_REAL=/etc/apt/keyrings/caddy-stable.asc
CADDY_KEY=$R$CADDY_KEY_REAL

CURRENT_STEP="getting started"
CHANGED=0
RESTARTED=0
FRESH=0
TMP_DIR=""
TTY_USED=0

# ------------------------------------------------------------------------------
# Output. The person running this sees short messages; all details go to the log.
say() {
  printf '%s\n' "$*" >&3
  printf '%s\n' "$*"
}
step() {
  CURRENT_STEP=$1
  say ""
  say "==> $1"
  printf '[%s]\n' "$(date -u '+%F %T UTC')"
}
note() { say "    $*"; }
die() {
  say ""
  say "Stopped: $*"
  say "Details are in /var/log/tbot-setup.log"
  exit 1
}
on_error() {
  local line=$1
  [[ $BASHPID == "$$" ]] || return 0
  trap - ERR
  say ""
  say "Something went wrong while ${CURRENT_STEP} (line ${line})."
  say "Nothing else was changed after that point. Running the setup again is safe."
  say "If it keeps failing, send us the lines below:"
  tail -n 15 "$LOG_FILE" >&3 2>/dev/null || true
  exit 1
}
cleanup() {
  [[ -n $TMP_DIR && -d $TMP_DIR ]] && rm -rf "$TMP_DIR"
  if [[ $TTY_USED == 1 ]]; then stty echo </dev/tty 2>/dev/null || true; fi
  return 0
}

start_log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec 3>&1
  exec >>"$LOG_FILE" 2>&1
  printf '\n===== Tbot setup started %s =====\n' "$(date -u '+%F %T UTC')"
}

# ------------------------------------------------------------------------------
# Small helpers.
have_tty() {
  [[ -z ${TBOT_SETUP_NO_TTY:-} ]] || return 1
  { : </dev/tty; } 2>/dev/null
}
tty_say() { printf '%s\n' "$*" >/dev/tty; }
REPLY_PW=""
read_hidden() {
  local v=""
  TTY_USED=1
  printf '%s' "$1" >/dev/tty
  IFS= read -r -s v </dev/tty || v=""
  printf '\n' >/dev/tty
  REPLY_PW=$v
}

pkg_ok() {
  # shellcheck disable=SC2016 # ${Status} is dpkg-query's own field name
  [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null) == *"ok installed"* ]]
}

APT_UPDATED=0
apt_install() {
  export DEBIAN_FRONTEND=noninteractive
  if [[ $APT_UPDATED == 0 ]]; then
    apt-get update || note "Some package lists could not be refreshed. Trying anyway."
    APT_UPDATED=1
  fi
  apt-get -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    install -y --no-install-recommends "$@"
}

# Moves a new file into place only when its content changed. Sets FILE_CHANGED.
FILE_CHANGED=0
put_file() {
  local src=$1 dst=$2 mode=$3
  FILE_CHANGED=0
  if [[ -f $dst ]] && cmp -s "$src" "$dst"; then
    rm -f "$src"
    chmod "$mode" "$dst"
    return 0
  fi
  chmod "$mode" "$src"
  mv -f "$src" "$dst"
  FILE_CHANGED=1
}
new_tmp() { mktemp "$1.tbot-new.XXXXXX"; }

as_tbot() {
  # Runs a command as the tbot user from the app folder, with a small clean
  # environment (nothing of root's leaks in, and git never waits for a login prompt).
  local keep=() v
  for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    if [[ -n ${!v:-} ]]; then keep+=("$v=${!v}"); fi
  done
  (
    cd "$APP" 2>/dev/null || cd /
    runuser -u tbot -- env -i PATH="$PATH" HOME="$OPT_REAL" LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0 "${keep[@]}" "$@"
  )
}

service_pid() {
  local pid
  pid=$(systemctl show -p MainPID --value "$1" 2>/dev/null || true)
  [[ $pid =~ ^[0-9]+$ ]] || pid=0
  printf '%s\n' "$pid"
}

state_get() {
  [[ -f $STATE_FILE ]] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1
}
env_get() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}
save_state() {
  local tmp
  mkdir -p "$OPT"
  tmp=$(new_tmp "$STATE_FILE")
  {
    echo "# Tbot setup state. uninstall.sh reads it. Please don't edit."
    echo "CADDY_INSTALLED_BY_TBOT=$CADDY_INSTALLED_BY_TBOT"
    echo "CADDY_REPO_ADDED_BY_TBOT=$CADDY_REPO_ADDED_BY_TBOT"
    echo "CADDY_SITE_FILE=$CADDY_SITE_FILE"
    echo "CADDYFILE_BACKUP=$CADDYFILE_BACKUP"
    echo "UFW_RULES_ADDED=$UFW_RULES_ADDED"
    echo "IPTABLES_RULES_ADDED=$IPTABLES_RULES_ADDED"
    # Only these ports were opened by the setup; uninstall closes only these.
    echo "UFW_PORTS_ADDED=$UFW_PORTS_ADDED"
    echo "IPTABLES_PORTS_ADDED=$IPTABLES_PORTS_ADDED"
    echo "CUSTOM_DOMAIN=$CUSTOM_DOMAIN"
  } >"$tmp"
  put_file "$tmp" "$STATE_FILE" 0644
}

# Lists listening TCP ports as "port program pid" (program "?" and pid 0 when unknown).
listeners() {
  ss -Hltnp 2>/dev/null | awk '
    {
      port = $4; sub(/.*:/, "", port)
      name = "?"; pid = 0
      if (match($0, /users:\(\("[^"]*",pid=[0-9]+/)) {
        s = substr($0, RSTART, RLENGTH)
        name = s; sub(/^users:\(\("/, "", name); sub(/".*/, "", name)
        pid = s; sub(/.*pid=/, "", pid)
      }
      print port, name, pid
    }' || true
}

friendly_name() {
  case $1 in
    caddy) echo "Caddy" ;;
    nginx) echo "nginx" ;;
    apache2 | httpd) echo "Apache" ;;
    docker-proxy) echo "Docker (a program running in a container)" ;;
    lighttpd) echo "lighttpd" ;;
    haproxy) echo "HAProxy" ;;
    traefik) echo "Traefik" ;;
    "?") echo "a program we could not identify" ;;
    *) echo "$1" ;;
  esac
}

PUBLIC_IP=""
is_public_ipv4() {
  local a b c d
  PUBLIC_IP=""
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]})) b=$((10#${BASH_REMATCH[2]}))
  c=$((10#${BASH_REMATCH[3]})) d=$((10#${BASH_REMATCH[4]}))
  ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 1
  ((a == 100 && b >= 64 && b <= 127)) && return 1 # shared address space (carrier NAT)
  ((a == 169 && b == 254)) && return 1
  ((a == 172 && b >= 16 && b <= 31)) && return 1
  ((a == 192 && b == 168)) && return 1
  ((a == 192 && b == 0 && (c == 0 || c == 2))) && return 1
  ((a == 198 && (b == 18 || b == 19))) && return 1
  ((a == 198 && b == 51 && c == 100)) && return 1
  ((a == 203 && b == 0 && c == 113)) && return 1
  PUBLIC_IP="$a.$b.$c.$d"
}
detect_public_ipv4() {
  local u ip
  for u in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip=$(curl -4 -fsS --max-time 8 "$u" 2>/dev/null | tr -d '[:space:]') || continue
    if is_public_ipv4 "$ip"; then return 0; fi
  done
  return 1
}
valid_domain() {
  [[ ${#1} -le 253 && $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]]
}

# Replaces (or appends) the tbot-managed block of a file and prints the result.
with_block() {
  local file=$1
  [[ -f $file ]] || file=/dev/null
  TBOT_BLOCK=$2 TBOT_B=$MARK_BEGIN TBOT_E=$MARK_END awk '
    BEGIN { nb = ENVIRON["TBOT_BLOCK"]; b = ENVIRON["TBOT_B"]; e = ENVIRON["TBOT_E"] }
    index($0, b) == 1 { if (!done) { print nb; done = 1 }; skip = 1; next }
    skip && index($0, e) == 1 { skip = 0; next }
    skip { next }
    { print; n++ }
    END { if (!done) { if (n > 0) print ""; print nb } }' "$file"
}

# ------------------------------------------------------------------------------
# Steps.
OS_NAME=""
NODE_ARCH=""
preflight() {
  [[ $EUID -eq 0 ]] || {
    echo "Please run this with sudo:  sudo bash $0" >&2
    exit 1
  }
  cd /
  umask 022
  start_log

  step "Checking this server"
  local osr=$R/etc/os-release id ver like
  [[ -f $osr ]] || osr=/etc/os-release
  id=$(sed -n 's/^ID=//p' "$osr" | tr -d '"')
  ver=$(sed -n 's/^VERSION_ID=//p' "$osr" | tr -d '"')
  like=$(sed -n 's/^ID_LIKE=//p' "$osr" | tr -d '"')
  OS_NAME="$id $ver"
  case "$id:$ver" in
    ubuntu:20.04 | ubuntu:22.04 | ubuntu:24.04 | debian:11 | debian:12) ;;
    *)
      if [[ " $id $like " == *" debian "* || " $id $like " == *" ubuntu "* ]]; then
        note "This system ($OS_NAME) is not one we tested, but it is close. Trying anyway."
      else
        die "This setup works on Ubuntu (20.04 to 24.04) or Debian (11 or 12). This server runs $OS_NAME."
      fi
      ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) NODE_ARCH=x64 ;;
    aarch64 | arm64) NODE_ARCH=arm64 ;;
    *) die "This kind of processor ($(uname -m)) is not supported. Tbot needs a 64-bit Intel/AMD or ARM server." ;;
  esac
  command -v apt-get >/dev/null || die "This server has no apt-get. Tbot needs Ubuntu or Debian."
  [[ -d $R/run/systemd/system ]] || die "This server does not use systemd, which Tbot needs to run in the background."
  exec 9>"$R/run/tbot-setup.lock"
  if command -v flock >/dev/null && ! flock -n 9; then
    die "The setup is already running in another window. Wait for it to finish."
  fi
  note "$OS_NAME, ${NODE_ARCH}."
}

CADDY_INSTALLED_BY_TBOT=0
CADDY_REPO_ADDED_BY_TBOT=0
CADDY_SITE_FILE=""
CADDYFILE_BACKUP=""
UFW_RULES_ADDED=0
IPTABLES_RULES_ADDED=0
UFW_PORTS_ADDED=""
IPTABLES_PORTS_ADDED=""
CUSTOM_DOMAIN=""
load_state() {
  CADDY_INSTALLED_BY_TBOT=$(state_get CADDY_INSTALLED_BY_TBOT)
  CADDY_REPO_ADDED_BY_TBOT=$(state_get CADDY_REPO_ADDED_BY_TBOT)
  CADDY_SITE_FILE=$(state_get CADDY_SITE_FILE)
  CADDYFILE_BACKUP=$(state_get CADDYFILE_BACKUP)
  UFW_RULES_ADDED=$(state_get UFW_RULES_ADDED)
  IPTABLES_RULES_ADDED=$(state_get IPTABLES_RULES_ADDED)
  UFW_PORTS_ADDED=$(state_get UFW_PORTS_ADDED)
  IPTABLES_PORTS_ADDED=$(state_get IPTABLES_PORTS_ADDED)
  CUSTOM_DOMAIN=$(state_get CUSTOM_DOMAIN)
  : "${CADDY_INSTALLED_BY_TBOT:=0}" "${CADDY_REPO_ADDED_BY_TBOT:=0}" "${UFW_RULES_ADDED:=0}" "${IPTABLES_RULES_ADDED:=0}"
  # Older setups saved only a yes/no flag; then both ports count as opened by the setup.
  if [[ $UFW_RULES_ADDED == 1 && -z $UFW_PORTS_ADDED ]] && ! grep -qs "^UFW_PORTS_ADDED=" "$STATE_FILE"; then UFW_PORTS_ADDED="80 443"; fi
  if [[ $IPTABLES_RULES_ADDED == 1 && -z $IPTABLES_PORTS_ADDED ]] && ! grep -qs "^IPTABLES_PORTS_ADDED=" "$STATE_FILE"; then IPTABLES_PORTS_ADDED="80 443"; fi
}

BOT_PW=""
NEED_PW=0
pw_problem() {
  if ((${#1} < 10)); then
    echo "The password needs at least 10 characters."
    return 0
  fi
  if [[ $1 == *$'\n'* || $1 == *$'\r'* ]]; then
    echo "The password can't contain line breaks."
    return 0
  fi
  return 1
}
ask_new_password() {
  local prompt=$1 allow_keep=$2 why a tries=0
  while ((tries < 5)); do
    tries=$((tries + 1))
    read_hidden "$prompt"
    a=$REPLY_PW
    if [[ -z $a && $allow_keep == 1 ]]; then
      BOT_PW=""
      return 0
    fi
    if why=$(pw_problem "$a"); then
      tty_say "$why Please try again."
      prompt="Password (at least 10 characters): "
      continue
    fi
    read_hidden "Type it again: "
    if [[ $a != "$REPLY_PW" ]]; then
      tty_say "The two passwords don't match. Please try again."
      prompt="Password (at least 10 characters): "
      continue
    fi
    BOT_PW=$a
    return 0
  done
  return 1
}
get_password() {
  local has_auth=0 why
  BOT_PW="${TBOT_PASSWORD:-$PRESET_PASSWORD}"
  unset TBOT_PASSWORD
  [[ -s $DATA/auth.json ]] && has_auth=1
  step "Bot password"
  if [[ -n $BOT_PW ]]; then
    if why=$(pw_problem "$BOT_PW"); then
      BOT_PW=""
      die "$why (It came from TBOT_PASSWORD or the top of this script.)"
    fi
    note "Using the password given to the setup."
    return 0
  fi
  if have_tty; then
    if ((has_auth)); then
      tty_say "A password for your bot page is already set."
      ask_new_password "To keep it, just press Enter. To change it, type a new one: " 1 ||
        die "No new password was set. Your old password still works."
      if [[ -z $BOT_PW ]]; then note "Keeping the current password."; else note "A new password will be saved."; fi
    else
      tty_say "Choose a password for your bot page. You will type it to open the page."
      tty_say "Use at least 10 characters. Nothing shows while you type, that is normal."
      ask_new_password "Password: " 0 || die "No password was set. Run the setup again to try once more."
      note "Got it."
    fi
  elif ((has_auth)); then
    note "Keeping the current password."
  else
    NEED_PW=1
    note "No password was given. The page will ask you to set one by running the setup again."
  fi
}

install_basics() {
  step "Installing the basic tools (only the missing ones)"
  local need=() p
  for p in git curl ca-certificates xz-utils iproute2; do
    pkg_ok "$p" || need+=("$p")
  done
  if ((${#need[@]})); then
    note "Installing: ${need[*]}"
    apt_install "${need[@]}"
  else
    note "All there already."
  fi
}

node_version_of() {
  local v
  v=$("$1/bin/node" --version 2>/dev/null) || return 1
  [[ $v =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  printf '%s\n' "$v"
}
# Newest v22 release named in nodejs.org's index.json (read from stdin).
pick_node_version() {
  grep -oE '"version":"v'"$NODE_MAJOR"'\.[0-9]+\.[0-9]+"' | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | sort -V | tail -n 1
}
# Expected sha256 of a file, from a SHASUMS256.txt (path in $1).
expected_sha() {
  awk -v f="$2" '$2 == f && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { print $1 }' "$1" | tail -n 1
}
NODE_VERSION=""
install_node() {
  step "Installing the bot's own Node.js ${NODE_MAJOR} (the system's Node.js is not touched)"
  local want current file want_sha got_sha dir
  want=$(curl -fsSL --retry 3 --max-time 60 "$NODE_DIST/index.json" | pick_node_version) || want=""
  if [[ ! $want =~ ^v${NODE_MAJOR}\.[0-9]+\.[0-9]+$ ]]; then
    note "Could not read the list of Node.js releases. Using ${NODE_FALLBACK_VERSION}."
    want=$NODE_FALLBACK_VERSION
  fi
  current=$(node_version_of "$NODE_LINK" || true)
  if [[ -n $current && $current == v${NODE_MAJOR}.* ]]; then
    if [[ $(printf '%s\n%s\n' "$current" "$want" | sort -V | tail -n 1) == "$current" ]]; then
      NODE_VERSION=$current
      note "Node.js $current is already installed and up to date."
      return 0
    fi
  fi
  file="node-${want}-linux-${NODE_ARCH}.tar.xz"
  note "Downloading Node.js $want for ${NODE_ARCH}..."
  curl -fsSL --retry 3 --max-time 600 -o "$TMP_DIR/$file" "$NODE_DIST/$want/$file" ||
    die "Could not download Node.js from nodejs.org. Check the server's internet connection and run the setup again."
  curl -fsSL --retry 3 --max-time 60 -o "$TMP_DIR/SHASUMS256.txt" "$NODE_DIST/$want/SHASUMS256.txt" ||
    die "Could not download the Node.js checksum list from nodejs.org."
  want_sha=$(expected_sha "$TMP_DIR/SHASUMS256.txt" "$file")
  [[ -n $want_sha ]] || die "The Node.js checksum list does not mention $file."
  got_sha=$(sha256sum "$TMP_DIR/$file" | awk '{print $1}')
  if [[ $got_sha != "$want_sha" ]]; then
    die "The Node.js download is damaged (its checksum does not match). Nothing was installed. Run the setup again."
  fi
  note "Checksum OK."
  mkdir -p "$OPT"
  chown root:root "$OPT"
  chmod 755 "$OPT"
  dir="$OPT/node-$want"
  rm -rf "$dir.partial"
  mkdir -p "$dir.partial"
  tar -xJf "$TMP_DIR/$file" -C "$dir.partial" --strip-components=1 --no-same-owner
  chown -R root:root "$dir.partial"
  chmod -R go-w "$dir.partial"
  [[ $(node_version_of "$dir.partial" || true) == "$want" ]] || die "The new Node.js did not run on this server."
  rm -rf "$dir"
  mv "$dir.partial" "$dir"
  if [[ -e $NODE_LINK && ! -L $NODE_LINK ]]; then rm -rf "$NODE_LINK"; fi
  ln -sfn "node-$want" "$OPT/node.tbot-new"
  mv -Tf "$OPT/node.tbot-new" "$NODE_LINK"
  find "$OPT" -maxdepth 1 -name 'node-v*' ! -name "node-$want" -exec rm -rf {} +
  NODE_VERSION=$want
  CHANGED=1
  note "Node.js $want installed in $OPT_REAL/node."
}

ensure_user() {
  step "Creating the tbot user and folders"
  if getent passwd tbot >/dev/null; then
    note "The tbot user already exists."
  else
    if getent group tbot >/dev/null; then
      useradd --system --gid tbot --home-dir "$OPT_REAL" --no-create-home --shell /usr/sbin/nologin tbot
    else
      useradd --system --user-group --home-dir "$OPT_REAL" --no-create-home --shell /usr/sbin/nologin tbot
    fi
    note "Created the tbot user (it can't log in)."
  fi
  mkdir -p "$OPT" "$DATA"
  chown root:root "$OPT"
  chmod 755 "$OPT"
  chown -R tbot:tbot "$DATA"
  chmod 700 "$DATA"
}

APP_VERSION=""
get_app() {
  step "Getting the bot's files"
  local before="" after
  if [[ -d $APP/.git ]]; then
    chown -R tbot:tbot "$APP"
    before=$(as_tbot git -C "$APP" rev-parse HEAD 2>/dev/null || true)
    local cur
    cur=$(as_tbot git -C "$APP" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
    if [[ -n $cur && $cur != "$BRANCH" ]]; then
      # Switch to the wanted branch (main unless TBOT_BRANCH says otherwise).
      if as_tbot git -C "$APP" fetch --quiet origin "$BRANCH" &&
        as_tbot git -C "$APP" checkout --quiet -B "$BRANCH" "origin/$BRANCH" &&
        as_tbot git -C "$APP" branch --quiet --set-upstream-to="origin/$BRANCH" "$BRANCH"; then
        note "Switched from the $cur version to the $BRANCH version."
      else
        note "Could not switch to the $BRANCH version. Keeping $cur."
      fi
    fi
    if as_tbot git -C "$APP" pull --ff-only; then
      if [[ $(as_tbot git -C "$APP" rev-parse HEAD) == "$before" ]]; then
        note "Already the newest version."
      else
        note "Updated to the newest version."
      fi
    else
      note "Could not download the newest version. Keeping the current one."
    fi
  else
    if [[ -e $APP ]] && ! rmdir "$APP" 2>/dev/null; then
      local old
      old="$APP.old-$(date +%Y%m%d%H%M%S)"
      mv "$APP" "$old"
      note "Moved an unfinished copy out of the way to $old"
    fi
    mkdir -p "$APP"
    chown tbot:tbot "$APP"
    chmod 755 "$APP"
    as_tbot git clone --quiet --branch "$BRANCH" "$REPO_URL" "$APP" ||
      die "Could not download the bot's files from GitHub. Check that this server can reach github.com, then run the setup again."
    note "Downloaded."
  fi
  after=$(as_tbot git -C "$APP" rev-parse HEAD)
  [[ $before == "$after" ]] || CHANGED=1
  APP_VERSION=$(as_tbot git -C "$APP" log -1 --format='%h from %cs' 2>/dev/null || echo "$after")
  note "Version: $APP_VERSION"
  [[ -f $APP/server/main.mjs ]] ||
    die "This version of the bot does not include the server part yet (server/main.mjs is missing). Please tell us."
}

install_deps() {
  local has
  has=$("$NODE_LINK/bin/node" -e '
    const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(Object.keys(p.dependencies || {}).length ? "yes" : "no");' "$APP/package.json" 2>/dev/null || echo no)
  [[ $has == yes ]] || return 0
  step "Installing the bot's add-ons"
  local cache rc=0
  # The cache must be somewhere the tbot user can reach (the script's own temp folder is root-only).
  cache=$(mktemp -d "$OPT/.npm-cache.XXXXXX")
  chown tbot:tbot "$cache"
  local how=(ci)
  # Without a lockfile, install without writing one, so later "git pull" stays clean.
  [[ -f $APP/package-lock.json ]] || how=(install --no-package-lock)
  as_tbot PATH="$NODE_LINK/bin:$PATH" npm_config_cache="$cache" \
    "$NODE_LINK/bin/npm" "${how[@]}" --omit=dev --no-audit --no-fund || rc=$?
  rm -rf "$cache"
  [[ $rc == 0 ]] || die "Could not install the bot's add-ons."
  CHANGED=1
}

set_password() {
  [[ -n $BOT_PW ]] || return 0
  step "Saving the password"
  local out rc=0
  out=$(printf '%s' "$BOT_PW" |
    as_tbot TBOT_DATA_DIR="$DATA" "$NODE_LINK/bin/node" "$APP/server/main.mjs" set-password 2>&1) || rc=$?
  out=${out//"$BOT_PW"/(hidden)}
  BOT_PW=""
  [[ $rc == 0 ]] || die "The password could not be saved: $(printf '%s' "$out" | tail -n 2)"
  NEED_PW=0
  note "Password saved."
}

PORT=""
LISTEN_NOW=""
choose_port() {
  step "Choosing a private port for the bot"
  local old lines mainpid p
  LISTEN_NOW=$(listeners)
  old=$(env_get TBOT_PORT)
  if [[ $old =~ ^[0-9]{4,5}$ ]] && ((old >= 1024 && old <= 65535)); then
    lines=$(awk -v p="$old" '$1 == p' <<<"$LISTEN_NOW")
    if [[ -z $lines ]]; then
      PORT=$old
    else
      mainpid=$(service_pid tbot)
      if [[ $mainpid != 0 && -z $(awk -v pid="$mainpid" '$3 != pid' <<<"$lines") ]]; then PORT=$old; fi
    fi
  fi
  if [[ -z $PORT ]]; then
    for ((p = PORT_FIRST; p <= PORT_LAST; p++)); do
      if [[ -z $(awk -v p="$p" '$1 == p' <<<"$LISTEN_NOW") ]]; then
        PORT=$p
        break
      fi
    done
  fi
  [[ -n $PORT ]] || die "Ports $PORT_FIRST to $PORT_LAST are all in use on this server. Please tell us."
  note "The bot listens on 127.0.0.1:$PORT (only reachable from this server)."
}

write_service() {
  step "Setting up the background service"
  local tmp
  tmp=$(new_tmp "$ENV_FILE")
  {
    echo "# Settings for the Tbot service, written by the Tbot setup script."
    echo "# The setup rewrites the four TBOT_ lines below. Other lines you add are kept."
    echo "TBOT_DATA_DIR=$DATA_REAL"
    echo "TBOT_HOST=127.0.0.1"
    echo "TBOT_PORT=$PORT"
    echo "TBOT_TRUST_PROXY=1"
    if [[ -f $ENV_FILE ]]; then
      grep -vE '^(# Settings for the Tbot service|# The setup rewrites|TBOT_DATA_DIR=|TBOT_HOST=|TBOT_PORT=|TBOT_TRUST_PROXY=)' "$ENV_FILE" || true
    fi
  } >"$tmp"
  put_file "$tmp" "$ENV_FILE" 0644
  ((FILE_CHANGED)) && CHANGED=1

  mkdir -p "$(dirname "$UNIT_FILE")"
  tmp=$(new_tmp "$UNIT_FILE")
  cat >"$tmp" <<EOF
# Written by the Tbot setup script. Running the setup again rewrites it.
[Unit]
Description=Tbot trading bot
Documentation=https://github.com/mikejohn333111-creator/Bitinv/blob/main/docs/server-setup.md
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=tbot
Group=tbot
WorkingDirectory=$APP_REAL
EnvironmentFile=$ENV_REAL
ExecStart=$NODE_REAL/bin/node server/main.mjs
Restart=always
RestartSec=5
# Hardening. The bot can still update itself (git pull in $APP_REAL)
# and save its data in $DATA_REAL, and nothing else.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA_REAL $APP_REAL
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
UMask=0077
MemoryMax=400M

[Install]
WantedBy=multi-user.target
EOF
  put_file "$tmp" "$UNIT_FILE" 0644
  ((FILE_CHANGED)) && CHANGED=1

  systemctl daemon-reload
  systemctl enable tbot
  if [[ $CHANGED == 1 ]] || ! systemctl is-active --quiet tbot; then
    systemctl restart tbot
    RESTARTED=1
    note "Service started."
  else
    note "Nothing changed, so the running bot was left alone."
  fi
  local i
  for ((i = 0; i < 45; i++)); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
      note "The bot answers on 127.0.0.1:$PORT."
      return 0
    fi
    sleep 1
  done
  journalctl -u tbot -n 40 --no-pager || true
  die "The bot did not start. Send us the end of /var/log/tbot-setup.log."
}

# ---------------------------------------------------------------- https address
HOST=""
WEB_MODE=""
WEB_USERS=""
HTTPS_STATE=""
pick_host() {
  local d="${TBOT_DOMAIN:-$PRESET_DOMAIN}"
  [[ -n $d ]] || d=$CUSTOM_DOMAIN
  d=$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  if [[ $d == auto ]]; then d=""; fi
  if [[ -n $d ]]; then
    valid_domain "$d" || die "\"$d\" does not look like a domain name (TBOT_DOMAIN)."
    HOST=$d
    CUSTOM_DOMAIN=$d
    return 0
  fi
  CUSTOM_DOMAIN=""
  if detect_public_ipv4; then
    HOST="${PUBLIC_IP//./-}.sslip.io"
  else
    HOST=""
  fi
}

classify_web_ports() {
  local web cpid name p users
  web=$(awk '$1 == 80 || $1 == 443' <<<"$(listeners)")
  WEB_USERS=""
  if [[ -z $web ]]; then
    WEB_MODE=free
    return 0
  fi
  for p in 80 443; do
    users=""
    while IFS= read -r name; do
      if [[ -n $name ]]; then users+="${users:+, }$(friendly_name "$name")"; fi
    done < <(awk -v p="$p" '$1 == p { print $2 }' <<<"$web" | sort -u)
    [[ -n $users ]] && WEB_USERS+="Port $p is used by: $users"$'\n'
  done
  if [[ -z $(awk '$2 != "caddy"' <<<"$web") ]]; then
    cpid=$(service_pid caddy)
    if [[ $cpid != 0 && -z $(awk -v pid="$cpid" '$3 != pid' <<<"$web") ]]; then
      WEB_MODE=caddy
      return 0
    fi
  fi
  WEB_MODE=other
}

# none | ours | stock | custom
caddyfile_kind() {
  if [[ ! -s $CADDYFILE ]]; then
    echo none
    return 0
  fi
  if grep -qF -e "$MARK_FILE" -e "$MARK_BEGIN" "$CADDYFILE"; then
    echo ours
    return 0
  fi
  # The welcome-page Caddyfile that comes with the Caddy package serves nothing of yours.
  local flat
  flat=$(sed -e 's/\(^\|[[:space:]]\)#.*$//' "$CADDYFILE" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')
  if [[ -z $flat || $flat == ":80 { root * /usr/share/caddy file_server }" ]]; then
    echo stock
    return 0
  fi
  echo custom
}

# Finds a folder the Caddyfile already imports with a pattern like "sites/*" or
# "conf.d/*.caddy" (outside any site block) and prints the file name to use there.
caddy_dropin_target() {
  local pat dir base target
  while IFS= read -r pat; do
    pat=${pat//\"/}
    [[ $pat == /* ]] || pat="$CADDY_DIR/$pat"
    [[ -n $R && $pat != "$R"/* ]] && pat="$R$pat"
    dir=$(dirname "$pat")
    base=$(basename "$pat")
    [[ $dir == *[\*\?\[\{]* ]] && continue
    [[ $base == *\** ]] || continue
    [[ ${base#*\*} == *[\*\?\[\{]* ]] && continue
    [[ -d $dir ]] || continue
    target="$dir/${base/\*/tbot}"
    if [[ -e $target ]] && ! grep -qF "$MARK_BEGIN" "$target"; then continue; fi
    printf '%s\n' "$target"
    return 0
  done < <(awk '
    { line = $0; sub(/(^|[ \t])#.*/, "", line) }
    depth == 0 && line ~ /^[ \t]*import[ \t]+[^ \t]*\*/ {
      l = line; sub(/^[ \t]*import[ \t]+/, "", l); sub(/[ \t].*/, "", l); print l
    }
    { o = gsub(/[{]/, "{", line); c = gsub(/[}]/, "}", line); depth += o - c }' "$CADDYFILE")
  return 1
}

caddy_block() {
  cat <<EOF
$MARK_BEGIN (Tbot bot page. The Tbot setup and uninstall scripts manage this block.)
$HOST {
	reverse_proxy 127.0.0.1:$PORT
}
$MARK_END
EOF
}

caddy_validate() {
  caddy validate --adapter caddyfile --config "$CADDYFILE"
}

install_caddy() {
  note "Installing Caddy (it gets and renews the https certificate by itself)..."
  if grep -rqsF "dl.cloudsmith.io/public/caddy" "$R/etc/apt/sources.list" "$R/etc/apt/sources.list.d"; then
    note "Caddy's package source is already set up."
  else
    mkdir -p "$(dirname "$CADDY_KEY")" "$(dirname "$CADDY_LIST")"
    curl -fsSL --retry 3 --max-time 60 -o "$TMP_DIR/caddy.asc" "$CADDY_REPO/gpg.key" ||
      die "Could not download Caddy's signing key."
    grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$TMP_DIR/caddy.asc" || die "Caddy's signing key looks wrong."
    install -m 0644 "$TMP_DIR/caddy.asc" "$CADDY_KEY"
    printf '# Added by the Tbot setup script (official Caddy packages).\ndeb [signed-by=%s] %s/deb/debian any-version main\n' \
      "$CADDY_KEY_REAL" "$CADDY_REPO" >"$CADDY_LIST"
    chmod 0644 "$CADDY_LIST"
    CADDY_REPO_ADDED_BY_TBOT=1
    save_state
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -o Dir::Etc::sourcelist="sources.list.d/caddy-stable.list" \
    -o Dir::Etc::sourceparts="-" -o APT::Get::List-Cleanup="0" ||
    note "Could not refresh Caddy's package list. Trying anyway."
  apt_install caddy || die "Could not install Caddy."
  CADDY_INSTALLED_BY_TBOT=1
  save_state
}

port_rule_spec() { echo "-p tcp -m state --state NEW -m tcp --dport $1 -j ACCEPT"; }
# Adds a port to a space-separated list variable (named by $1), once.
add_port() {
  local -n list=$1
  [[ " $list " == *" $2 "* ]] || list=${list:+$list }$2
}
open_firewall() {
  local p st n added=0 rules
  if command -v ufw >/dev/null 2>&1 && [[ $(ufw status 2>/dev/null || true) == *"Status: active"* ]]; then
    for p in 80 443; do
      st=$(ufw status 2>/dev/null || true)
      if ! grep -qE "^$p/tcp[[:space:]]+ALLOW" <<<"$st"; then
        ufw allow "$p/tcp"
        UFW_RULES_ADDED=1
        add_port UFW_PORTS_ADDED "$p"
        added=1
      fi
    done
    ((added)) && note "Opened ports 80 and 443 in the ufw firewall."
    save_state
    return 0
  fi
  command -v iptables >/dev/null 2>&1 || return 0
  rules=$(iptables -S INPUT 2>/dev/null || true)
  # Oracle Cloud images block everything but SSH with a REJECT rule at the end.
  grep -qE -- '-j REJECT' <<<"$rules" || return 0
  for p in 80 443; do
    # shellcheck disable=SC2046 # the rule spec is meant to split into words
    if iptables -C INPUT $(port_rule_spec "$p") 2>/dev/null; then continue; fi
    n=$(iptables -L INPUT --line-numbers -n 2>/dev/null | awk '$2 == "REJECT" && !f { print $1; f = 1 }' || true)
    [[ $n =~ ^[0-9]+$ ]] || continue
    # shellcheck disable=SC2046
    iptables -I INPUT "$n" $(port_rule_spec "$p")
    IPTABLES_RULES_ADDED=1
    add_port IPTABLES_PORTS_ADDED "$p"
    added=1
  done
  if ((added)); then
    note "Opened ports 80 and 443 in this server's iptables firewall."
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save || note "Could not save the firewall rules for the next restart."
    else
      note "These firewall rules last until the server restarts. Run the setup again after a restart."
    fi
  fi
  save_state
}

write_result() {
  mkdir -p "$(dirname "$RESULT_FILE")"
  {
    echo "Tbot setup result, $(date -u '+%F %T UTC')"
    echo "Server: $OS_NAME (${NODE_ARCH}), Node.js ${NODE_VERSION:-?}, bot version ${APP_VERSION:-?}"
    echo "Bot service: tbot, listening on 127.0.0.1:$PORT"
    if [[ -n $HOST ]]; then echo "Web address: https://$HOST"; else echo "Web address: (none yet)"; fi
    echo "HTTPS: $HTTPS_STATE"
    printf '%s' "$WEB_USERS"
    echo "Caddy site file: ${CADDY_SITE_FILE:-(none)}"
    echo "Password set: $([[ -s $DATA/auth.json ]] && echo yes || echo no)"
  } >"$RESULT_FILE"
  chmod 600 "$RESULT_FILE"
}

manual_caddy() {
  # Caddy runs other sites from a Caddyfile we must not change. Put our site in its
  # own file and tell the person the two lines that would switch it on.
  local kind=${1:-custom}
  local f=$CADDY_DIR/tbot.caddy
  local tmp
  say ""
  say "Caddy is already set up on this server for something else, so we did not change its settings."
  say "The bot is installed and running privately on 127.0.0.1:$PORT."
  if [[ $kind == none ]]; then
    # Caddy runs without a Caddyfile (its settings came another way). An import line
    # would do nothing, and a reload from the file could drop the other sites.
    HTTPS_STATE="Caddy runs without a Caddyfile, not changed"
    say "Caddy here runs without a Caddyfile, so we can't safely add the bot to it."
    say "Please send us the details printed at the end. We will tell you what to do."
    return 0
  fi
  tmp=$(new_tmp "$f")
  with_block "$f" "$(caddy_block)" >"$tmp"
  put_file "$tmp" "$f" 0644
  CADDY_SITE_FILE=${f#"$R"}
  save_state
  HTTPS_STATE="waiting for one change to the Caddyfile"
  say "To put it on https://$HOST, add this line at the end of /etc/caddy/Caddyfile:"
  say "    import /etc/caddy/tbot.caddy"
  if systemctl is-active --quiet caddy; then
    say "then run:"
    say "    sudo systemctl reload caddy"
  else
    say "Caddy is turned off right now. After adding the line, turn it on with:"
    say "    sudo systemctl start caddy"
  fi
  say "If you are not sure, send us the details printed at the end."
}

configure_caddy() {
  local kind target tmp backup="" rc=0
  kind=$(caddyfile_kind)
  target=""
  case $kind in
    # Only our own block, or the package's welcome page: safe to manage.
    ours | stock) target=$CADDYFILE ;;
    # No Caddyfile: only safe when Caddy serves nothing (it might be using other settings).
    none) [[ $WEB_MODE == free ]] && target=$CADDYFILE ;;
    # Someone's own Caddyfile: only drop our file into a folder it already imports,
    # and only while Caddy is running it (never start a Caddy that was stopped on purpose).
    custom) [[ $WEB_MODE == caddy ]] && target=$(caddy_dropin_target || true) ;;
  esac
  if [[ -z $target ]]; then
    manual_caddy "$kind"
    return 0
  fi
  if ! systemctl cat caddy >/dev/null 2>&1; then
    HTTPS_STATE="Caddy is installed without its usual service"
    note "Caddy is installed here without its usual service, so we left it alone."
    return 0
  fi

  # Keep a copy so a bad change can be undone.
  if [[ -f $target ]]; then
    backup="$TMP_DIR/caddy-before"
    cp -p "$target" "$backup"
  fi
  tmp=$(new_tmp "$target")
  if [[ $target == "$CADDYFILE" && $kind != ours ]]; then
    if [[ $kind == stock && -f $CADDYFILE ]]; then
      if [[ ! -f $CADDYFILE.before-tbot ]]; then cp -p "$CADDYFILE" "$CADDYFILE.before-tbot"; fi
      CADDYFILE_BACKUP=${CADDYFILE#"$R"}.before-tbot
    fi
    {
      echo "$MARK_FILE this Caddyfile was written by the Tbot setup script."
      echo "# You can add your own sites below. Running the setup again only changes the Tbot block."
      echo ""
      caddy_block
    } >"$tmp"
  else
    with_block "$target" "$(caddy_block)" >"$tmp"
  fi
  put_file "$tmp" "$target" 0644
  CADDY_SITE_FILE=${target#"$R"}
  save_state
  if [[ $FILE_CHANGED == 0 ]] && systemctl is-active --quiet caddy; then
    HTTPS_STATE="configured"
    note "Caddy already sends https://$HOST to the bot."
    return 0
  fi

  undo_caddy() {
    if [[ -n $backup ]]; then cp -p "$backup" "$target"; else rm -f "$target"; fi
  }
  # A Caddyfile with only our block is checked before use. When our file joins
  # someone's own Caddyfile, the reload itself is the check: Caddy keeps running its
  # old settings if the new ones fail, and we undo our file.
  if [[ $kind != custom ]] && ! caddy_validate; then
    undo_caddy
    HTTPS_STATE="Caddy did not accept the new settings, so they were undone"
    note "Caddy did not accept the new settings, so we undid them."
    return 0
  fi
  systemctl enable caddy || true
  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || rc=$?
  else
    systemctl restart caddy || rc=$?
  fi
  if [[ $rc != 0 ]]; then
    undo_caddy
    systemctl reload caddy || true
    HTTPS_STATE="Caddy could not load the new settings, so they were undone"
    note "Caddy could not load the new settings, so we undid them."
    return 0
  fi
  HTTPS_STATE="configured"
  note "Caddy now sends https://$HOST to the bot."
}

wait_https() {
  local i tries=${TBOT_SETUP_HTTPS_TRIES:-30}
  note "Waiting for the https certificate (this can take a minute)..."
  for ((i = 0; i < tries; i++)); do
    if curl -fsS --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/healthz" >/dev/null 2>&1; then
      HTTPS_STATE="working"
      return 0
    fi
    sleep 3
  done
  HTTPS_STATE="configured, certificate not ready yet"
}

# Ready-made site files for nginx and Apache, kept in /opt/tbot/web. The setup never
# copies them into the other program's folders: the person does that with the steps shown.
write_proxy_examples() {
  local dir=$OPT/web tmp
  mkdir -p "$dir"
  tmp=$(new_tmp "$dir/nginx-tbot.conf")
  cat >"$tmp" <<EOF
# Tbot: sends https://$HOST to the bot on 127.0.0.1:$PORT. Made by the Tbot setup.
server {
    listen 80;
    listen [::]:80;
    server_name $HOST;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
    }
}
EOF
  put_file "$tmp" "$dir/nginx-tbot.conf" 0644
  tmp=$(new_tmp "$dir/apache-tbot.conf")
  cat >"$tmp" <<EOF
# Tbot: sends https://$HOST to the bot on 127.0.0.1:$PORT. Made by the Tbot setup.
<VirtualHost *:80>
    ServerName $HOST
    ProxyPreserveHost On
    ProxyPass / http://127.0.0.1:$PORT/
    ProxyPassReverse / http://127.0.0.1:$PORT/
    RequestHeader set X-Forwarded-Proto "expr=%{REQUEST_SCHEME}"
</VirtualHost>
EOF
  put_file "$tmp" "$dir/apache-tbot.conf" 0644
}

report_busy() {
  HTTPS_STATE="ports 80/443 are used by another program, not changed"
  say ""
  say "The bot is installed and running, but only inside this server for now (127.0.0.1:$PORT)."
  local line kind="" users=${WEB_USERS%$'\n'}
  while IFS= read -r line; do say "    $line"; done <<<"$users"
  say "Those are the ports for web addresses. We did not touch that program or its settings."
  # Ready steps when it is only nginx, or only Apache (the usual cases).
  if ! grep -qv ': nginx$' <<<"$users"; then kind=nginx; fi
  if ! grep -qv ': Apache$' <<<"$users"; then kind=apache; fi
  if [[ -n $kind && -z $HOST ]]; then
    say "We could not find this server's public address. If you have a domain name pointing"
    say "at this server, run the setup again with it: sudo env TBOT_DOMAIN=bot.example.com bash tbot-setup.sh"
    kind=""
  fi
  if [[ -n $kind ]]; then
    write_proxy_examples
    HTTPS_STATE="ports 80/443 are used by $kind, steps printed, not changed"
    say ""
    say "To put the bot on https://$HOST, paste these lines one at a time."
    say "They add one new file just for the bot. Your other sites are not changed."
    if [[ $kind == nginx ]]; then
      say "    sudo cp /opt/tbot/web/nginx-tbot.conf /etc/nginx/conf.d/tbot.conf"
      say "    sudo nginx -t && sudo systemctl reload nginx"
      say "    sudo apt-get install -y certbot python3-certbot-nginx"
      say "    sudo certbot --nginx -d $HOST"
    else
      say "    sudo a2enmod proxy proxy_http headers"
      say "    sudo cp /opt/tbot/web/apache-tbot.conf /etc/apache2/sites-available/tbot.conf"
      say "    sudo a2ensite tbot"
      say "    sudo apache2ctl configtest && sudo systemctl reload apache2"
      say "    sudo apt-get install -y certbot python3-certbot-apache"
      say "    sudo certbot --apache -d $HOST"
    fi
    say "If a line shows an error, stop there and send us the details printed at the end."
    say "When all lines worked, open https://$HOST on your phone."
  else
    say "The last step, putting the bot on a secure web address, needs a small change to it."
    say "Please send us the details printed at the end. We will tell you exactly what to do."
  fi
  say "(The details are also saved in /root/tbot-setup-result.txt)"
}

https_setup() {
  step "Setting up the secure web address"
  pick_host
  save_state
  classify_web_ports
  if [[ $WEB_MODE == other ]]; then
    report_busy
    return 0
  fi
  if [[ -z $HOST ]]; then
    HTTPS_STATE="no public IPv4 address found"
    say "Could not find this server's public IPv4 address, so there is no web address yet."
    say "If you have a domain name pointing at this server, run the setup again with it, like this:"
    say "    sudo env TBOT_DOMAIN=bot.example.com bash tbot-setup.sh"
    return 0
  fi
  note "Address: https://$HOST"
  if ! command -v caddy >/dev/null 2>&1; then
    install_caddy
  fi
  configure_caddy
  open_firewall
  if [[ $HTTPS_STATE == configured ]]; then wait_https; fi
}

summary() {
  write_result
  say ""
  say "=============================================================="
  case $HTTPS_STATE in
    working)
      say "All done. Open your bot here:"
      say "    https://$HOST"
      ;;
    "configured, certificate not ready yet")
      say "Almost done. Your bot will be here in a minute or two:"
      say "    https://$HOST"
      say "If it still does not open after 5 minutes, your provider's firewall"
      say "probably blocks ports 80 and 443. The guide shows how to open them."
      ;;
    *)
      say "The bot is installed and running on this server (127.0.0.1:$PORT)."
      say "It has no web address yet. See the message above."
      say "If you need help, copy everything between the two lines below and send it to us:"
      say "--------------------------------------------------------------"
      local line
      while IFS= read -r line; do say "$line"; done <"$RESULT_FILE"
      say "--------------------------------------------------------------"
      ;;
  esac
  say ""
  if ((NEED_PW)); then
    say "No password is set yet. Run the setup again from an SSH window to choose one."
  else
    say "Log in with your bot password."
  fi
  if ((FRESH)); then
    say "The bot starts stopped. It only trades after you connect your Deriv account and press Start."
  elif ((RESTARTED)); then
    say "The bot was restarted. If it was trading before, it carries on by itself."
  else
    say "The bot was left running as it was."
  fi
  say "Start on a demo account. No bot can guarantee profits."
  say ""
  say "To update the bot or change the password, run the same line again:"
  say "    curl -fsSL $SITE_URL/setup.sh -o tbot-setup.sh && sudo bash tbot-setup.sh"
  say "To remove it:"
  say "    curl -fsSL $SITE_URL/uninstall.sh -o tbot-uninstall.sh && sudo bash tbot-uninstall.sh"
  say "=============================================================="
}

main() {
  trap 'on_error $LINENO' ERR
  trap cleanup EXIT
  preflight
  TMP_DIR=$(mktemp -d)
  if [[ ! -e $UNIT_FILE && -z $(ls -A "$DATA" 2>/dev/null) ]]; then FRESH=1; fi
  load_state
  get_password
  install_basics
  install_node
  ensure_user
  get_app
  install_deps
  set_password
  choose_port
  write_service
  https_setup
  summary
}

# TBOT_SETUP_SOURCE_ONLY=1 loads the functions without running anything (for tests).
if [[ -z ${TBOT_SETUP_SOURCE_ONLY:-} ]]; then
  main "$@"
fi

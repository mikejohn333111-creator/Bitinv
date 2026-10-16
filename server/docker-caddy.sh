#!/usr/bin/env bash
# Tbot behind a Caddy that runs in Docker
#
# For servers where ports 80 and 443 belong to a Caddy container (for example a
# website started with Docker Compose). Run it after the Tbot setup has installed
# the bot. It adds one small site block for the bot to that Caddy, and nothing else:
#
#   curl -fsSL https://tbot-mauve-eta.vercel.app/docker-caddy.sh -o tbot-docker-caddy.sh && sudo bash tbot-docker-caddy.sh
#
# What it does:
#   1. Finds the running Caddy container and the Caddyfile it reads (it must be a
#      file on this server, shared into the container).
#   2. Lets the bot also listen on the container network's gateway address, so Caddy
#      can reach it (TBOT_EXTRA_HOST and TBOT_PROXY_IPS in /etc/tbot.env), and opens
#      that one port for that network only if a firewall blocks it.
#   3. Adds a marked block for the bot's address to the end of the Caddyfile (after a
#      dated backup), checks it with Caddy, and reloads Caddy. If Caddy rejects it,
#      or one of your sites stops answering, the old Caddyfile is put back.
# Running it again is safe. To undo everything it did:  sudo bash tbot-docker-caddy.sh --remove
# Log: /var/log/tbot-docker-caddy.log
#
# Optional settings (sudo env NAME=value bash tbot-docker-caddy.sh):
#   TBOT_CADDY_CONTAINER  the container's name, when more than one runs Caddy
#   TBOT_DOMAIN           your own domain name for the bot, already pointing at this server
set -euo pipefail
set -E

SITE_URL="https://tbot-mauve-eta.vercel.app"
MARK_BEGIN="# >>> tbot (added by the Tbot setup) >>>"
MARK_END="# <<< tbot <<<"
ENV_MARK="# tbot-docker-caddy:"
FW_MARK="# tbot-docker-caddy-firewall:"

# TBOT_SETUP_ROOT is for automated tests only (see setup.sh): files go under that folder.
R="${TBOT_SETUP_ROOT:-}"
ENV_FILE=$R/etc/tbot.env
STATE_FILE=$R/opt/tbot/setup-state
SELF_COPY=$R/opt/tbot/docker-caddy.sh
LOG_FILE=$R/var/log/tbot-docker-caddy.log
HTTPS_TRIES=${TBOT_SETUP_HTTPS_TRIES:-30} # 3 seconds apart: 90 seconds

MODE=install
UNINSTALLING=0
TMP_DIR=""
CURRENT_STEP="getting started"
# Set while the Caddyfile holds a change that isn't checked yet: an error puts the backup back.
CF_DIRTY=0

# ------------------------------------------------------------------------------
# Output. Short messages on screen; everything, with details, in the log.
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
  say "Details are in /var/log/tbot-docker-caddy.log"
  exit 1
}
on_error() {
  local line=$1
  [[ $BASHPID == "$$" ]] || return 0
  trap - ERR
  say ""
  say "Something went wrong while ${CURRENT_STEP} (line ${line})."
  if ((CF_DIRTY)); then
    restore_caddyfile
    reload_caddy >/dev/null 2>&1 || true
    say "The Caddyfile was put back as it was, so your website is not changed."
  fi
  say "Running this again is safe. If it keeps failing, send us the lines below:"
  tail -n 15 "$LOG_FILE" >&3 2>/dev/null || true
  exit 1
}
cleanup() {
  [[ -n $TMP_DIR && -d $TMP_DIR ]] && rm -rf "$TMP_DIR"
  return 0
}
start_log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  touch "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  exec 3>&1
  exec >>"$LOG_FILE" 2>&1
  printf '\n===== Tbot docker-caddy %s started %s =====\n' "$MODE" "$(date -u '+%F %T UTC')"
}

env_get() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}
state_get() {
  [[ -f $STATE_FILE ]] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1
}
# What an earlier run recorded: "container|Caddyfile on this server|Caddyfile in the container".
recorded() {
  [[ -f $ENV_FILE ]] || return 0
  sed -n "s/^$ENV_MARK //p" "$ENV_FILE" | tail -n 1
}

# ------------------------------------------------------------------------------
# The web address (same rules as setup.sh).
PUBLIC_IP=""
is_public_ipv4() {
  local a b c d
  PUBLIC_IP=""
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  a=$((10#${BASH_REMATCH[1]})) b=$((10#${BASH_REMATCH[2]}))
  c=$((10#${BASH_REMATCH[3]})) d=$((10#${BASH_REMATCH[4]}))
  ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
  ((a == 0 || a == 10 || a == 127 || a >= 224)) && return 1
  ((a == 100 && b >= 64 && b <= 127)) && return 1
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
HOST=""
pick_host() {
  local d="${TBOT_DOMAIN:-}"
  [[ -n $d ]] || d=$(state_get CUSTOM_DOMAIN)
  d=$(printf '%s' "$d" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')
  if [[ $d == auto ]]; then d=""; fi
  if [[ -n $d ]]; then
    valid_domain "$d" || die "\"$d\" does not look like a domain name (TBOT_DOMAIN)."
    HOST=$d
    return 0
  fi
  detect_public_ipv4 || die "Could not find this server's public IPv4 address. If you have a domain name pointing at this server, run this again with it: sudo env TBOT_DOMAIN=bot.example.com bash $0"
  HOST="${PUBLIC_IP//./-}.sslip.io"
}

# ------------------------------------------------------------------------------
# Docker.
C="" # the Caddy container
CF_IN="" # the Caddyfile as the container sees it
CF_HOST="" # the same file on this server
G="" # the container network's gateway: the bot's extra address
S="" # that network's IPv4 range: trusted to send X-Forwarded-* headers
IFACE="" # that network's interface on this server
PORT=""

docker_ready() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1
}

is_caddy_image() {
  local img=$1
  img=${img#docker.io/}
  img=${img#library/}
  [[ $img == caddy* ]]
}

# Sets C, or sets FIND_ERR to why not and returns 1.
FIND_ERR=""
find_container() {
  local name img running
  local -a found=()
  if [[ -n ${TBOT_CADDY_CONTAINER:-} ]]; then
    running=$(docker inspect -f '{{.State.Running}}' "$TBOT_CADDY_CONTAINER" 2>/dev/null || true)
    if [[ $running != true ]]; then
      FIND_ERR="There is no running container called \"$TBOT_CADDY_CONTAINER\" (TBOT_CADDY_CONTAINER)."
      return 1
    fi
    C=$TBOT_CADDY_CONTAINER
    return 0
  fi
  while IFS=$'\t' read -r name img; do
    [[ -n $name ]] || continue
    if is_caddy_image "$img"; then found+=("$name"); fi
  done < <(docker ps --format '{{.Names}}{{"\t"}}{{.Image}}' 2>/dev/null || true)
  if ((${#found[@]} == 0)); then
    FIND_ERR="We could not find a running Docker container with Caddy in it. Nothing was changed."
    return 1
  fi
  if ((${#found[@]} > 1)); then
    FIND_ERR="More than one running container has Caddy in it (${found[*]}), so nothing was changed. Run this again with the one that serves your website, like this: sudo env TBOT_CADDY_CONTAINER=${found[0]} bash tbot-docker-caddy.sh"
    return 1
  fi
  C=${found[0]}
}

# Sets CF_IN and CF_HOST from the container's command and its mounts.
find_caddyfile() {
  local -a args=()
  local a i adapter="" type src dst best="" best_src="" mounts
  mapfile -t args < <(docker inspect -f '{{.Path}}{{range .Args}}{{"\n"}}{{.}}{{end}}' "$C")
  CF_IN=""
  for ((i = 0; i < ${#args[@]}; i++)); do
    a=${args[i]}
    case $a in
      --config | -config) CF_IN=${args[i + 1]:-} ;;
      --config=*) CF_IN=${a#--config=} ;;
      --adapter | -adapter) adapter=${args[i + 1]:-} ;;
      --adapter=*) adapter=${a#--adapter=} ;;
    esac
  done
  [[ -n $CF_IN ]] || CF_IN=/etc/caddy/Caddyfile
  if [[ -n $adapter && $adapter != caddyfile ]] || [[ $CF_IN == *.json ]]; then
    MOUNTS_SEEN="(Caddy runs with ${CF_IN} and the \"${adapter:-json}\" adapter, not a Caddyfile)"
    return 1
  fi
  mounts=$(docker inspect -f '{{range .Mounts}}{{.Type}}|{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$C")
  MOUNTS_SEEN=$mounts
  while IFS='|' read -r type src dst; do
    [[ $type == bind || $type == volume ]] || continue
    [[ -n $src && -n $dst ]] || continue
    dst=${dst%/}
    if [[ $CF_IN == "$dst" || $CF_IN == "$dst"/* ]] && ((${#dst} > ${#best})); then
      best=$dst
      best_src=$src
    fi
  done <<<"$mounts"
  [[ -n $best ]] || return 1
  CF_HOST="$R${best_src%/}${CF_IN#"$best"}"
  [[ -f $CF_HOST ]]
}

# Sets G, S and IFACE from the network the container is on.
find_network() {
  local mode name id gw ip len info driver bridge subnets sn pick="" fallback=""
  mode=$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$C")
  if [[ $mode == host ]]; then
    die "The Caddy container uses the server's own network (network_mode: host). Please send us this message; the bot needs a different setup for that."
  fi
  while IFS='|' read -r name id gw ip len; do
    [[ -n $name && -n $id ]] || continue
    info=$(docker network inspect -f '{{.Driver}}|{{with .Options}}{{index . "com.docker.network.bridge.name"}}{{end}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$id" 2>/dev/null || true)
    IFS='|' read -r driver bridge subnets <<<"$info"
    [[ $driver == bridge ]] || continue
    [[ $gw =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || continue
    sn=""
    for s in $subnets; do
      if [[ $s =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]]; then
        sn=$s
        break
      fi
    done
    if [[ -z $sn && $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ && $len =~ ^[0-9]+$ ]]; then sn="$ip/$len"; fi
    [[ -n $sn ]] || continue
    if [[ -z $bridge ]]; then
      if [[ $name == bridge ]]; then bridge=docker0; else bridge="br-${id:0:12}"; fi
    fi
    if [[ $name == bridge ]]; then
      [[ -n $fallback ]] || fallback="$gw|$sn|$bridge|$name"
    elif [[ -z $pick ]]; then
      pick="$gw|$sn|$bridge|$name"
    fi
  done < <(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}|{{$v.NetworkID}}|{{$v.Gateway}}|{{$v.IPAddress}}|{{$v.IPPrefixLen}}{{"\n"}}{{end}}' "$C")
  [[ -n $pick ]] || pick=$fallback
  [[ -n $pick ]] || die "Could not find the Docker network of the Caddy container ($C). Please send us this message."
  IFS='|' read -r G S IFACE NET_NAME <<<"$pick"
}

in_container() { docker exec "$C" "$@"; }
# The error lines of Caddy's output, as plain text (Caddy logs JSON: only its "msg" is shown).
caddy_error() {
  grep -iE 'error|invalid|unrecognized' <<<"$1" | tail -n 3 |
    sed -e 's/^{.*"msg":"\(\([^"\\]\|\\.\)*\)".*$/\1/' -e 's/\\n/ /g' -e 's/\\"/"/g' | cut -c1-300
}
validate_caddy() { in_container caddy validate --config "$CF_IN" --adapter caddyfile; }
reload_caddy() { in_container caddy reload --config "$CF_IN" --adapter caddyfile; }

# ------------------------------------------------------------------------------
# The Caddyfile. It is always written in place (never moved or replaced), so a
# single file shared into the container keeps working.
BACKUP=""
make_backup() {
  BACKUP="$CF_HOST.tbot-backup-$(date +%Y%m%d%H%M%S)"
  cp -p "$CF_HOST" "$BACKUP"
}
restore_caddyfile() {
  [[ -n $BACKUP && -f $BACKUP ]] || return 0
  cat "$BACKUP" >"$CF_HOST"
  CF_DIRTY=0
  note "Put back the Caddyfile from $(basename "$BACKUP")"
}

our_block() {
  printf '%s\n%s {\n\treverse_proxy %s:%s\n}\n%s\n' "$MARK_BEGIN" "$HOST" "$G" "$PORT" "$MARK_END"
}
has_block() { grep -qF -- "$MARK_BEGIN" "$1" 2>/dev/null; }
# Prints the file with our block replaced by $1 (or added at the end; or removed when $1 is empty).
with_block() {
  # Blank lines are held back, so removing the block also removes the blank line added before it.
  TBOT_BLOCK=$2 TBOT_B=$MARK_BEGIN TBOT_E=$MARK_END awk '
    BEGIN { nb = ENVIRON["TBOT_BLOCK"]; b = ENVIRON["TBOT_B"]; e = ENVIRON["TBOT_E"] }
    function flush(k) { for (; k > 0; k--) print ""; blanks = 0 }
    index($0, b) == 1 {
      if (nb == "") flush(blanks - 1); else flush(blanks)
      if (!done && nb != "") print nb
      done = 1; skip = 1; next
    }
    skip && index($0, e) == 1 { skip = 0; next }
    skip { next }
    $0 == "" { blanks++; n++; next }
    { flush(blanks); print; n++ }
    END {
      if (!done && nb != "") {
        flush(blanks)
        if (n > 0) print ""
        print nb
      } else flush(blanks)
    }' "$1"
}

# Prints the site addresses of a Caddyfile outside our block, one per line, as
# "scheme host port" (best effort: only plain names and IP addresses).
site_addresses() {
  TBOT_B=$MARK_BEGIN TBOT_E=$MARK_END awk '
    BEGIN { b = ENVIRON["TBOT_B"]; e = ENVIRON["TBOT_E"] }
    index($0, b) == 1 { skip = 1; next }
    skip && index($0, e) == 1 { skip = 0; next }
    skip { next }
    { line = $0; sub(/(^|[ \t])#.*/, "", line) }
    depth == 0 && line ~ /\{[ \t]*$/ {
      a = line; sub(/\{[ \t]*$/, "", a); gsub(/,/, " ", a)
      n = split(a, parts, /[ \t]+/)
      for (i = 1; i <= n; i++) if (parts[i] != "") print parts[i]
    }
    { o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line); depth += o - c }' "$1" |
    while IFS= read -r a; do
      local scheme=https port="" h
      case $a in \(* | *\{* | *\** | :* | /* | \[*) continue ;; esac
      case $a in
        http://*) scheme=http a=${a#http://} ;;
        https://*) a=${a#https://} ;;
      esac
      h=${a%%/*}
      if [[ $h == *:* ]]; then
        port=${h##*:}
        h=${h%:*}
      fi
      h=$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')
      [[ $h =~ ^[a-z0-9.-]+$ ]] || continue
      if [[ -z $port ]]; then
        if [[ $scheme == http ]]; then port=80; else port=443; fi
      fi
      [[ $port =~ ^[0-9]+$ ]] || continue
      [[ $port == 80 ]] && scheme=http
      printf '%s %s %s\n' "$scheme" "$h" "$port"
    done | sort -u
}

site_status() { # scheme host port
  local code
  code=$(curl -sk --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$2:$3:127.0.0.1" "$1://$2:$3/" 2>/dev/null) || true
  [[ $code =~ ^[0-9]{3}$ ]] || code=000
  printf '%s\n' "$code"
}

declare -A BEFORE=()
SITES=""
record_sites() {
  local scheme h port n=0
  SITES=$(site_addresses "$CF_HOST" | head -n 20)
  while read -r scheme h port; do
    [[ -n $h ]] || continue
    BEFORE["$scheme $h $port"]=$(site_status "$scheme" "$h" "$port")
    printf 'before: %s://%s:%s -> %s\n' "$scheme" "$h" "$port" "${BEFORE["$scheme $h $port"]}"
    n=$((n + 1))
  done <<<"$SITES"
  if ((n)); then note "Checked how your $n existing site address(es) answer now, to compare after the change."; fi
}
# Prints the sites that answered before and now give an error or no answer.
broken_sites() {
  local scheme h port was now i
  while read -r scheme h port; do
    [[ -n $h ]] || continue
    was=${BEFORE["$scheme $h $port"]:-000}
    if [[ $was == 000 ]] || ((10#$was >= 500)); then continue; fi
    for ((i = 0; i < 3; i++)); do
      now=$(site_status "$scheme" "$h" "$port")
      printf 'after: %s://%s:%s -> %s (was %s)\n' "$scheme" "$h" "$port" "$now" "$was"  >&2
      [[ $now != 000 ]] && ((10#$now < 500)) && break
      sleep 2
    done
    if [[ $now == 000 ]] || ((10#$now >= 500)); then printf '%s://%s (answered %s before, now %s)\n' "$scheme" "$h" "$was" "$now"; fi
  done <<<"$SITES"
}

# ------------------------------------------------------------------------------
# The firewall: only when one blocks the bot's port for the container network.
FW_NEW=()
fw_spec_ufw() { echo "ufw in on $IFACE to $G port $PORT proto tcp"; }
fw_spec_ipt() { echo "iptables -i $IFACE -d $G -p tcp --dport $PORT -j ACCEPT"; }
ufw_active() { command -v ufw >/dev/null 2>&1 && [[ $(ufw status 2>/dev/null || true) == *"Status: active"* ]]; }
iptables_blocks() {
  local rules
  command -v iptables >/dev/null 2>&1 || return 1
  rules=$(iptables -S INPUT 2>/dev/null || true)
  grep -qE -- '^-P INPUT (DROP|REJECT)' <<<"$rules" && return 0
  grep -qE -- '^-A INPUT -j (DROP|REJECT)' <<<"$rules"
}
fw_remove() { # one recorded rule
  local spec=$1 kind
  local -a w
  kind=${spec%% *}
  read -ra w <<<"${spec#* }"
  case $kind in
    ufw)
      ufw --force delete allow "${w[@]}" || note "Could not remove the ufw rule: ${w[*]}"
      ;;
    iptables)
      if iptables -C INPUT "${w[@]}" 2>/dev/null; then iptables -D INPUT "${w[@]}"; fi
      if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save || true; fi
      ;;
  esac
}
open_bridge_port() {
  local old spec out line
  local -a w
  old=$(sed -n "s/^$FW_MARK //p" "$ENV_FILE" 2>/dev/null || true)
  FW_NEW=()
  if ufw_active; then
    spec=$(fw_spec_ufw)
    read -ra w <<<"${spec#ufw }"
    out=$(ufw allow "${w[@]}" 2>&1) || die "ufw did not accept the rule for the bot's port: $out"
    printf '%s\n' "$out"
    if grep -qxF -- "$spec" <<<"$old" || [[ $out != *Skipping* ]]; then
      FW_NEW+=("$spec")
      [[ $out == *Skipping* ]] || note "Opened port $PORT in the ufw firewall, only for the Caddy container's network ($IFACE)."
    fi
  elif iptables_blocks; then
    spec=$(fw_spec_ipt)
    read -ra w <<<"${spec#iptables }"
    if iptables -C INPUT "${w[@]}" 2>/dev/null; then
      if grep -qxF -- "$spec" <<<"$old"; then FW_NEW+=("$spec"); fi
    else
      iptables -I INPUT 1 "${w[@]}"
      FW_NEW+=("$spec")
      note "Opened port $PORT in this server's iptables firewall, only for the Caddy container's network ($IFACE)."
      if command -v netfilter-persistent >/dev/null 2>&1; then
        netfilter-persistent save || note "Could not save the firewall rule for the next restart."
      else
        note "This firewall rule lasts until the server restarts. Run this again after a restart."
      fi
    fi
  fi
  # Rules from an earlier run that are not needed any more (say, the network changed).
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    if ! printf '%s\n' "${FW_NEW[@]}" | grep -qxF -- "$line"; then fw_remove "$line"; fi
  done <<<"$old"
}

# ------------------------------------------------------------------------------
# /etc/tbot.env: our lines are replaced, every other line is kept.
ENV_CHANGED=0
write_env() { # write_env add|remove
  local tmp f
  tmp=$(mktemp "$ENV_FILE.tbot-new.XXXXXX")
  {
    grep -vE "^(TBOT_EXTRA_HOST=|TBOT_PROXY_IPS=|$ENV_MARK|$FW_MARK)" "$ENV_FILE" || true
    if [[ $1 == add ]]; then
      echo "$ENV_MARK $C|${CF_HOST#"$R"}|$CF_IN"
      for f in "${FW_NEW[@]}"; do echo "$FW_MARK $f"; done
      echo "TBOT_EXTRA_HOST=$G"
      echo "TBOT_PROXY_IPS=$S"
    fi
  } >"$tmp"
  ENV_CHANGED=0
  if cmp -s "$tmp" "$ENV_FILE"; then
    rm -f "$tmp"
    return 0
  fi
  chmod 0644 "$tmp"
  mv -f "$tmp" "$ENV_FILE"
  ENV_CHANGED=1
}

bot_answers() { curl -fsS --noproxy '*' --max-time 3 "http://$1:$PORT/healthz" 2>/dev/null | grep -qx ok; }
wait_bot() { # address, seconds
  local i
  for ((i = 0; i < $2; i++)); do
    bot_answers "$1" && return 0
    sleep 1
  done
  return 1
}

# ==============================================================================
# Install.
preflight() {
  [[ $EUID -eq 0 ]] || {
    echo "Please run this with sudo:  sudo bash $0" >&2
    exit 1
  }
  if [[ $UNINSTALLING == 0 && -d $R/run ]]; then
    exec 9>"$R/run/tbot-setup.lock"
    if command -v flock >/dev/null && ! flock -n 9; then
      echo "The Tbot setup is running in another window. Wait for it to finish first." >&2
      exit 1
    fi
  fi
  TMP_DIR=$(mktemp -d)
  start_log
}

need_bot() {
  [[ -f $ENV_FILE ]] || die "The bot is not installed yet. Run the Tbot setup first: curl -fsSL $SITE_URL/setup.sh -o tbot-setup.sh && sudo bash tbot-setup.sh"
  PORT=$(env_get TBOT_PORT)
  [[ $PORT =~ ^[0-9]{2,5}$ ]] || die "Could not read the bot's port (TBOT_PORT) from /etc/tbot.env. Run the Tbot setup again first."
  local main=$R/opt/tbot/app/server/main.mjs
  if [[ -f $main ]] && ! grep -q TBOT_EXTRA_HOST "$main"; then
    die "The bot on this server is an older version. Update it first by running the setup line again: curl -fsSL $SITE_URL/setup.sh -o tbot-setup.sh && sudo bash tbot-setup.sh"
  fi
}

caddyfile_missing() {
  say ""
  say "The Caddy container ($C) reads its settings from $CF_IN, but that file is not"
  say "shared from this server (it is probably built into the container's image)."
  say "We can't change it safely from here, so nothing was changed."
  say ""
  say "Please send us everything between the two lines below:"
  say "--------------------------------------------------------------"
  say "Container: $C"
  say "Image: $(docker inspect -f '{{.Config.Image}}' "$C" 2>/dev/null || echo '?')"
  say "Caddyfile in the container: $CF_IN"
  say "Shared folders and files (type|on this server|in the container):"
  local line
  while IFS= read -r line; do [[ -n $line ]] && say "    $line"; done <<<"${MOUNTS_SEEN:-(none)}"
  say "Networks: $(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$C" 2>/dev/null || echo '?')"
  say "--------------------------------------------------------------"
  exit 1
}

do_install() {
  local line probe broken new out i
  step "Looking for Caddy in Docker"
  need_bot
  docker_ready || die "Docker is not running here, or this is not the right server. This script is only for a Caddy that runs in a Docker container."
  find_container || die "$FIND_ERR"
  note "Found the Caddy container: $C"
  MOUNTS_SEEN=""
  find_caddyfile || caddyfile_missing
  note "Its Caddyfile is $CF_IN, which is ${CF_HOST#"$R"} on this server."
  find_network
  note "It is on the Docker network \"$NET_NAME\" ($S). The bot will also listen on $G:$PORT."
  pick_host
  note "The bot's address will be https://$HOST"
  if site_addresses "$CF_HOST" | awk '{ print $2 }' | grep -qxF -- "$HOST"; then
    die "The Caddyfile already has a site for $HOST that the Tbot setup did not add. Nothing was changed. Please remove that site, or tell us about it."
  fi
  if [[ $(env_get TBOT_TRUST_PROXY) != 1 ]]; then
    note "Note: TBOT_TRUST_PROXY=1 is missing from /etc/tbot.env. Run the Tbot setup again to put it back."
  fi

  step "Letting the Caddy container reach the bot"
  open_bridge_port
  write_env add
  if ((ENV_CHANGED)) || ! bot_answers "$G"; then
    systemctl restart tbot 9>&-
    note "Restarted the bot so it also listens on $G:$PORT. If it was trading, it carries on by itself."
  fi
  wait_bot 127.0.0.1 45 || {
    journalctl -u tbot -n 40 --no-pager || true
    die "The bot did not start again. Send us the end of /var/log/tbot-docker-caddy.log."
  }
  wait_bot "$G" 20 || {
    journalctl -u tbot -n 40 --no-pager || true
    die "The bot does not answer on $G:$PORT. Send us the end of /var/log/tbot-docker-caddy.log."
  }
  if in_container sh -c 'command -v wget' >/dev/null 2>&1; then
    probe=""
    for ((i = 0; i < 5; i++)); do
      probe=$(in_container wget -qO- -T 5 "http://$G:$PORT/healthz" 2>&1) || true
      [[ $probe == ok ]] && break
      sleep 2
    done
    printf 'probe from %s: %s\n' "$C" "$probe"
    [[ $probe == ok ]] || die "The Caddy container can't reach the bot at $G:$PORT (a firewall may be blocking it). Your website was not changed. Send us the end of /var/log/tbot-docker-caddy.log."
    note "The Caddy container can reach the bot."
  else
    note "Could not test from inside the container (it has no wget). Going on; the last check will tell."
  fi

  step "Adding the bot's address to Caddy"
  record_sites
  new="$TMP_DIR/Caddyfile.new"
  with_block "$CF_HOST" "$(our_block)" >"$new"
  if cmp -s "$new" "$CF_HOST"; then
    note "The Caddyfile already has the bot's block. Nothing to change there."
  else
    make_backup
    note "Saved a copy of the Caddyfile: ${BACKUP#"$R"}"
    CF_DIRTY=1
    cat "$new" >"$CF_HOST"
    if ! out=$(validate_caddy 2>&1); then
      printf '%s\n' "$out"
      restore_caddyfile
      say ""
      say "Caddy did not accept the new settings. This is what it said:"
      while IFS= read -r line; do say "    $line"; done < <(caddy_error "$out")
      die "The Caddyfile was put back as it was. Your website was not changed. Please send us the message above."
    fi
    if ! out=$(reload_caddy 2>&1); then
      printf '%s\n' "$out"
      restore_caddyfile
      reload_caddy || true
      die "Caddy could not load the new settings, so the old Caddyfile was put back and loaded again. Please send us the end of /var/log/tbot-docker-caddy.log."
    fi
    note "Caddy accepted the new settings and reloaded."
    broken=$(broken_sites)
    if [[ -n $broken ]]; then
      restore_caddyfile
      reload_caddy || true
      say ""
      say "After the change, these sites stopped answering properly:"
      while IFS= read -r line; do say "    $line"; done <<<"$broken"
      die "To be safe, the old Caddyfile was put back and loaded again. Please send us this message."
    fi
    CF_DIRTY=0
    [[ -z $SITES ]] || note "Your other sites still answer as before."
  fi
  save_copy

  step "Waiting for the https certificate"
  HTTPS_OK=0
  for ((i = 0; i < HTTPS_TRIES; i++)); do
    if [[ $(curl -fsS --noproxy '*' --max-time 5 --resolve "$HOST:443:127.0.0.1" "https://$HOST/healthz" 2>/dev/null || true) == ok ]]; then
      HTTPS_OK=1
      break
    fi
    sleep 3
  done
  summary
}

# A copy for the uninstall script, which uses it to undo these changes.
save_copy() {
  [[ -f $0 ]] && grep -qF "$ENV_MARK" "$0" 2>/dev/null || return 0
  [[ $(realpath "$0" 2>/dev/null) == $(realpath "$SELF_COPY" 2>/dev/null) ]] && return 0
  mkdir -p "$(dirname "$SELF_COPY")"
  install -m 0755 "$0" "$SELF_COPY" || true
}

summary() {
  say ""
  say "=============================================================="
  if ((HTTPS_OK)); then
    say "All done. Open your bot here:"
    say "    https://$HOST"
  else
    say "Almost done. Your bot will be here in a minute or two:"
    say "    https://$HOST"
    say "Caddy is getting its https certificate. If it still does not open after"
    say "5 minutes, send us the end of /var/log/tbot-docker-caddy.log."
  fi
  say ""
  say "What to do next:"
  say "  1. Open the address on your phone and log in with your bot password."
  say "  2. Under Deriv connection, paste your App ID and Deriv token."
  say "  3. Start on a demo account. No bot can guarantee profits."
  say ""
  say "Your website was not changed. Only a marked Tbot block was added at the end of"
  say "${CF_HOST#"$R"} (copy of the old file next to it, ending in .tbot-backup-...)."
  say "To undo this:  sudo bash tbot-docker-caddy.sh --remove"
  say "=============================================================="
}

# ==============================================================================
# Remove.
do_remove() {
  local rec rc_name="" rc_host="" rc_in="" spec out
  step "Removing the bot's address from the Caddy container"
  rec=$(recorded)
  if [[ -n $rec ]]; then IFS='|' read -r rc_name rc_host rc_in <<<"$rec"; fi
  PORT=$(env_get TBOT_PORT)
  if docker_ready; then
    if [[ -z ${TBOT_CADDY_CONTAINER:-} && -n $rc_name ]] &&
      [[ $(docker inspect -f '{{.State.Running}}' "$rc_name" 2>/dev/null || true) == true ]]; then
      C=$rc_name
    else
      find_container || note "$FIND_ERR"
    fi
  fi
  if [[ -n $C ]] && find_caddyfile; then
    :
  elif [[ -n $rc_host ]]; then
    CF_HOST=$R$rc_host
    CF_IN=$rc_in
  fi
  if [[ -n $CF_HOST && -f $CF_HOST ]] && has_block "$CF_HOST"; then
    make_backup
    CF_DIRTY=1
    with_block "$CF_HOST" "" >"$TMP_DIR/Caddyfile.new"
    cat "$TMP_DIR/Caddyfile.new" >"$CF_HOST"
    note "Removed the Tbot block from ${CF_HOST#"$R"} (copy of the old file: $(basename "$BACKUP"))."
    if [[ -n $C ]]; then
      if out=$(reload_caddy 2>&1); then
        note "Caddy reloaded."
      else
        printf '%s\n' "$out"
        restore_caddyfile
        reload_caddy || true
        die "Caddy could not load the Caddyfile without the Tbot block, so it was put back. Please send us the end of /var/log/tbot-docker-caddy.log."
      fi
    else
      note "The Caddy container is not running, so it reads the change when it starts."
    fi
    CF_DIRTY=0
  else
    note "The Caddyfile has no Tbot block. Nothing to remove there."
  fi

  if [[ -f $ENV_FILE ]]; then
    while IFS= read -r spec; do
      [[ -n $spec ]] || continue
      fw_remove "$spec"
      note "Removed the firewall rule the Tbot setup added: ${spec#* }"
    done < <(sed -n "s/^$FW_MARK //p" "$ENV_FILE")
    if ((UNINSTALLING == 0)); then
      write_env remove
      if ((ENV_CHANGED)); then
        systemctl restart tbot 9>&- || true
        note "The bot listens only on 127.0.0.1:${PORT:-?} again (restarted)."
      fi
    fi
  fi
  say ""
  say "Done. The bot's address was removed from Caddy. Your website was not changed."
  if ((UNINSTALLING == 0)); then
    say "The bot itself is still installed. To remove it too:"
    say "    curl -fsSL $SITE_URL/uninstall.sh -o tbot-uninstall.sh && sudo bash tbot-uninstall.sh"
  fi
}

main() {
  local arg
  for arg in "$@"; do
    case $arg in
      --remove) MODE=remove ;;
      --uninstalling) MODE=remove UNINSTALLING=1 ;;
      -h | --help)
        sed -n '2,26p' "$0"
        exit 0
        ;;
      *)
        echo "Unknown option: $arg (use --remove to undo)" >&2
        exit 2
        ;;
    esac
  done
  trap 'on_error $LINENO' ERR
  trap cleanup EXIT
  preflight
  if [[ $MODE == remove ]]; then do_remove; else do_install; fi
}

# TBOT_SETUP_SOURCE_ONLY=1 loads the functions without running anything (for tests).
if [[ -z ${TBOT_SETUP_SOURCE_ONLY:-} ]]; then
  main "$@"
fi

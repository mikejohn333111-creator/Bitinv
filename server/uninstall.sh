#!/usr/bin/env bash
# Tbot server uninstall
#
# Removes what server/setup.sh added, and nothing else:
#   the tbot service, /opt/tbot, /etc/tbot.env, the tbot user, and the bot's
#   Caddy site. Caddy itself is removed only if the setup installed it and it
#   served nothing but the bot. Other programs and their settings are never touched.
#
#   curl -fsSL https://tbot-mauve-eta.vercel.app/uninstall.sh -o tbot-uninstall.sh && sudo bash tbot-uninstall.sh
#
# Options:
#   --purge      also delete the bot's saved data in /var/lib/tbot, without asking
#   --keep-data  keep /var/lib/tbot, without asking
# Without an option it asks, and keeps the data when nobody can answer.
set -euo pipefail

MARK_BEGIN="# BEGIN tbot-managed"
MARK_END="# END tbot-managed"
MARK_FILE="# tbot-managed:"

# TBOT_SETUP_ROOT is for automated tests only (see setup.sh).
R="${TBOT_SETUP_ROOT:-}"
OPT=$R/opt/tbot
DATA=$R/var/lib/tbot
ENV_FILE=$R/etc/tbot.env
UNIT_FILE=$R/etc/systemd/system/tbot.service
STATE_FILE=$OPT/setup-state
CADDY_DIR=$R/etc/caddy
CADDYFILE=$CADDY_DIR/Caddyfile
CADDY_LIST=$R/etc/apt/sources.list.d/caddy-stable.list
CADDY_KEY=$R/etc/apt/keyrings/caddy-stable.asc

say() { printf '%s\n' "$*"; }
note() { say "    $*"; }

state_get() {
  [[ -f $STATE_FILE ]] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1
}

# Prints a file without the tbot-managed block.
without_block() {
  TBOT_B=$MARK_BEGIN TBOT_E=$MARK_END awk '
    BEGIN { b = ENVIRON["TBOT_B"]; e = ENVIRON["TBOT_E"] }
    index($0, b) == 1 { skip = 1; next }
    skip && index($0, e) == 1 { skip = 0; next }
    skip { next }
    { print }' "$1"
}
# True when a Caddyfile text (stdin) has nothing left but comments and blank lines.
only_comments() {
  [[ -z $(sed -e 's/\(^\|[[:space:]]\)#.*$//' | tr -d '[:space:]') ]]
}

port_rule_spec() { echo "-p tcp -m state --state NEW -m tcp --dport $1 -j ACCEPT"; }

PURGE_CADDY=0
remove_caddy_site() {
  local site_file f rest reload=0
  local -a files=()
  site_file=$(state_get CADDY_SITE_FILE)
  [[ -n $site_file ]] && files+=("$R$site_file")
  if [[ -d $CADDY_DIR ]]; then
    while IFS= read -r f; do files+=("$f"); done < <(grep -rlsF "$MARK_BEGIN" "$CADDY_DIR" || true)
  fi
  ((${#files[@]})) || return 0
  say "==> Removing the bot's web address from Caddy"
  local seen=" "
  for f in "${files[@]}"; do
    [[ $seen == *" $f "* ]] && continue
    seen+="$f "
    if [[ ! -f $f ]] || ! grep -qF "$MARK_BEGIN" "$f"; then continue; fi
    rest=$(without_block "$f")
    if [[ $f == "$CADDYFILE" ]]; then
      if only_comments <<<"$rest"; then
        local backup
        backup=$(state_get CADDYFILE_BACKUP)
        if [[ $(state_get CADDY_INSTALLED_BY_TBOT) == 1 ]]; then
          # The setup installed Caddy just for the bot, and it serves nothing else.
          PURGE_CADDY=1
          printf '%s\n' "$rest" >"$f"
        elif [[ -n $backup && -f $R$backup ]]; then
          cp -p "$R$backup" "$f"
          rm -f "$R$backup"
          note "Put back the Caddyfile that was there before."
        else
          printf '%s\n' "$rest" >"$f"
        fi
      else
        # Other sites were added to it later: keep them, drop only the bot's block.
        printf '%s\n' "$rest" | sed -e "/^$MARK_FILE/d" >"$f"
      fi
    elif only_comments <<<"$rest"; then
      if grep -qE "^[[:space:]]*import[[:space:]]+\"?(/etc/caddy/)?$(basename "$f" | sed 's/\./\\./g')\"?([[:space:]]|$)" "$CADDYFILE" 2>/dev/null; then
        # The Caddyfile still names this file, so leave it empty rather than missing.
        printf '# The Tbot bot was removed. You can delete this file and the line\n# "import %s" in /etc/caddy/Caddyfile.\n' "${f#"$R"}" >"$f"
      else
        rm -f "$f"
      fi
    else
      printf '%s\n' "$rest" >"$f"
    fi
    reload=1
    note "Removed the bot's site from ${f#"$R"}"
  done
  if ((PURGE_CADDY)); then
    return 0
  fi
  if ((reload)) && systemctl is-active --quiet caddy; then
    systemctl reload caddy || note "Caddy could not reload. Check it with: sudo systemctl status caddy"
  fi
}

purge_caddy() {
  say "==> Removing Caddy (the setup installed it only for the bot)"
  systemctl disable --now caddy || true
  DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=300 purge -y caddy || note "Could not remove the Caddy package."
  rm -rf "$R/var/lib/caddy"
  if [[ $(state_get CADDY_REPO_ADDED_BY_TBOT) == 1 ]] && grep -qs "Tbot setup" "$CADDY_LIST"; then
    rm -f "$CADDY_LIST" "$CADDY_KEY"
  fi
  # Close the web ports again, but only the ones the setup opened. A rule that was
  # there before (say, the person's own port 80) stays.
  local p ports
  if [[ $(state_get UFW_RULES_ADDED) == 1 ]] && command -v ufw >/dev/null 2>&1; then
    ports=$(added_ports UFW_PORTS_ADDED)
    for p in $ports; do ufw --force delete allow "$p/tcp" || true; done
    [[ -n $ports ]] && note "Closed port ${ports// / and } in ufw again."
  fi
  if [[ $(state_get IPTABLES_RULES_ADDED) == 1 ]] && command -v iptables >/dev/null 2>&1; then
    ports=$(added_ports IPTABLES_PORTS_ADDED)
    for p in $ports; do
      # One rule each: an identical rule someone added themselves is left alone.
      # shellcheck disable=SC2046 # the rule spec is meant to split into words
      if iptables -C INPUT $(port_rule_spec "$p") 2>/dev/null; then
        # shellcheck disable=SC2046
        iptables -D INPUT $(port_rule_spec "$p")
      fi
    done
    if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save || true; fi
    [[ -n $ports ]] && note "Closed port ${ports// / and } in iptables again."
  fi
}

# The ports the setup opened. Older setups saved only a yes/no flag: then both.
added_ports() {
  local list
  list=$(state_get "$1")
  if [[ -z $list ]] && ! grep -qs "^$1=" "$STATE_FILE"; then list="80 443"; fi
  printf '%s' "$list"
}

main() {
  local mode=ask arg
  for arg in "$@"; do
    case $arg in
      --purge) mode=purge ;;
      --keep-data) mode=keep ;;
      -h | --help)
        sed -n '2,15p' "$0"
        exit 0
        ;;
      *)
        echo "Unknown option: $arg (use --purge or --keep-data)" >&2
        exit 2
        ;;
    esac
  done
  [[ $EUID -eq 0 ]] || {
    echo "Please run this with sudo:  sudo bash $0" >&2
    exit 1
  }
  cd /
  if [[ -d $R/run ]]; then
    exec 9>"$R/run/tbot-setup.lock"
    if command -v flock >/dev/null && ! flock -n 9; then
      echo "The setup is running in another window. Wait for it to finish first." >&2
      exit 1
    fi
  fi

  say "Removing Tbot from this server."
  say "==> Stopping the bot"
  systemctl disable --now tbot 2>/dev/null || true
  rm -f "$UNIT_FILE"
  systemctl daemon-reload || true
  systemctl reset-failed tbot 2>/dev/null || true
  note "Stopped. Trades that are still open stay open on Deriv, with their stop loss and take profit."

  remove_caddy_site
  if ((PURGE_CADDY)); then purge_caddy; fi

  say "==> Removing the bot's files"
  rm -rf "$OPT" "$ENV_FILE" "$R/root/tbot-setup-result.txt" "$R/var/log/tbot-setup.log"
  note "Removed /opt/tbot and /etc/tbot.env"

  if [[ -d $DATA ]]; then
    if [[ $mode == ask ]] && { : </dev/tty; } 2>/dev/null; then
      local answer=""
      printf 'Also delete the bot'"'"'s saved settings and history in /var/lib/tbot? Type yes to delete, or press Enter to keep them: ' >/dev/tty
      IFS= read -r answer </dev/tty || answer=""
      case ${answer,,} in yes | y) mode=purge ;; *) mode=keep ;; esac
    fi
    if [[ $mode == purge ]]; then
      rm -rf "$DATA"
      note "Deleted /var/lib/tbot"
    else
      # Keep settings and history, but not the Deriv token. The folder goes to root, because
      # the tbot user is removed below and the next new system user may get the same number.
      rm -f "$DATA/secret.json"
      chown -R root:root "$DATA" || true
      chmod 700 "$DATA" || true
      note "Kept the bot's saved settings and history in /var/lib/tbot. Only root can read them."
      note "Your Deriv token was removed from this server."
      note "To delete the rest later: sudo rm -rf /var/lib/tbot"
    fi
  fi

  if getent passwd tbot >/dev/null; then
    userdel tbot || note "Could not remove the tbot user."
  fi
  if getent group tbot >/dev/null; then groupdel tbot 2>/dev/null || true; fi

  say ""
  say "Tbot is removed. Nothing else on this server was changed."
  say "Your Deriv account is not affected. You can also delete the bot's"
  say "personal access token in your Deriv account settings."
}

main "$@"

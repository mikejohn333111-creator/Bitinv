# Run Tbot on your own server

This guide puts Tbot on a Linux server, so it keeps trading after you close the page.
You can do every step from your phone.

## What this is

- The bot runs on your server all day and night. It keeps trading after you close the page, until you press **Stop the bot**.
- You open it from a private web page with a password you choose.
- Every trade has its stop loss and take profit set at Deriv. So open trades stay protected even if the server stops.
- It can share a server you already use for something else. It gets its own user, its own copy of Node.js and its own folders. It never changes your other programs or their settings. It uses at most 400 MB of memory.

**Please read this first.** No bot can guarantee profits. In our tests these strategies roughly broke even before costs, and lost money after Deriv's commission. Stay on a demo account.

## Before you start

You need:

1. **A Linux server** with Ubuntu (20.04, 22.04 or 24.04) or Debian (11 or 12). Intel/AMD or ARM both work. About 500 MB of free disk space.
2. **A login that can use `sudo`**, or the root login.
3. **A way to type commands on it.** On a phone, use an SSH app such as **Termius** (iPhone and Android) or **JuiceSSH** (Android). Or use the web console in your server provider's dashboard.

## Install

1. Log in to your server.
2. Copy this whole line, paste it, and press Enter:

   ```
   curl -fsSL https://tbot-mauve-eta.vercel.app/setup.sh -o tbot-setup.sh && sudo bash tbot-setup.sh
   ```

   If you see `sudo: command not found` and you are logged in as root, run the same line without the word `sudo`.
   If you see `curl: command not found`, run `sudo apt-get install -y curl` first.

3. It may ask for your server password first. That is the normal `sudo` check.
4. Then it asks you to **choose a password for your bot page**, twice. Use at least 10 characters. Nothing shows while you type. That is normal. This is not your Deriv password.
5. Wait 2 to 5 minutes. It prints short steps as it goes.

When it worked, the end looks like this:

```
All done. Open your bot here:
    https://1-2-3-4.sslip.io
```

Open that address on your phone and log in with your bot password. Bookmark it.

The numbers are your server's IP address. sslip.io is a free service that turns it into a web address, so the page can have a real https lock.

If you own a domain name and it already points at this server, you can use it instead:

```
sudo env TBOT_DOMAIN=bot.yourdomain.com bash tbot-setup.sh
```

## If the setup says ports 80 and 443 are busy

Ports 80 and 443 are the doors for websites. If another program on your server already uses them (for example nginx or Apache), the setup does **not** touch it.

The bot is still installed and running. It just has no web address yet. You can give it one yourself in a few minutes. You add one new file for the bot. Your other sites stay as they are.

**If the setup named nginx**, it printed four lines like these, with your own address. Paste them one at a time:

```
sudo cp /opt/tbot/web/nginx-tbot.conf /etc/nginx/conf.d/tbot.conf
sudo nginx -t && sudo systemctl reload nginx
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 1-2-3-4.sslip.io
```

**If the setup named Apache**, paste these instead:

```
sudo a2enmod proxy proxy_http headers
sudo cp /opt/tbot/web/apache-tbot.conf /etc/apache2/sites-available/tbot.conf
sudo a2ensite tbot
sudo apache2ctl configtest && sudo systemctl reload apache2
sudo apt-get install -y certbot python3-certbot-apache
sudo certbot --apache -d 1-2-3-4.sslip.io
```

Use the address the setup printed, not `1-2-3-4.sslip.io`. When certbot asks for an email, give yours. It is only for certificate notices. Then open `https://` and your address on your phone.

If a line shows an error, stop there. Nothing else changes.

If you write the nginx part by hand, keep the line `proxy_set_header Host $host;` next to `proxy_pass`. Without it, the login page says the request "came from another site". Also keep `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`, so the limit on wrong passwords counts each visitor on their own.

To take it away later, delete `/etc/nginx/conf.d/tbot.conf` and reload nginx (for Apache: `sudo a2dissite tbot`, then reload Apache).

**For anything else** (Docker, Traefik, HAProxy, or a program the setup could not name), the setup prints a short block of details at the end, between two lines. Copy that block and send it to us. We will tell you the change to make. You can show the same details again any time with:

```
sudo cat /root/tbot-setup-result.txt
```

That file never contains your password or your Deriv token.

## Connect your Deriv account

The bot needs two things from Deriv: an **App ID** and a **Personal Access Token**. The names on Deriv's site may be a little different. Look for "token" or "API token".

1. Open **developers.deriv.com** and log in with your Deriv account.
2. Open the **Dashboard**. If you have no app yet, register one. Copy its **App ID**.
3. Create a **Personal Access Token** and tick the **Trade** permission. Copy the token.
4. On your bot page, open **Settings**, then **Deriv connection**.
5. Paste the App ID and the token, then tap **Save and connect**.

**Paste the token only into your own bot page.** Never paste it into a chat, an email, or a message to us. Anyone with the token can trade on your account. If you shared it by mistake, delete it on Deriv and make a new one.

The token is kept only on your server, in a private file. The page never shows it again.

## First run: use the demo account

1. Under **Account**, pick your **Demo** account.
2. Leave **Trading mode** on **Auto trade**. (Signals only trades nothing and just lists setups.)
3. Pick a market and a strategy. Check the **Risk limits**.
4. Tap **Start the bot**.
5. Close the page. The bot keeps going. Come back later and look at **Activity**.
6. Tap **Stop the bot** to stop it. Open trades keep their stop loss and take profit at Deriv.

Real money is off. The bot refuses real accounts until you type REAL under **Allow real money**. We suggest you leave it off. No strategy here has a proven edge.

## Update

Either:

- On the bot page: **Settings**, **Update the bot**, **Check for updates**, then **Update now**. Or:
- Run the install line again. This also updates the bot's Node.js and settings.

The bot checks that the new version can start before it restarts. If it can't, the bot goes back to the version it had, keeps running, and tells you on the page. After an update it restarts. If it was trading before, it carries on by itself. Open trades keep their stop loss and take profit.

## Remove

Paste this line:

```
curl -fsSL https://tbot-mauve-eta.vercel.app/uninstall.sh -o tbot-uninstall.sh && sudo bash tbot-uninstall.sh
```

It stops the bot and removes what the setup added. It asks before deleting the bot's saved settings and history. Your Deriv token is always removed from the server, even when you keep the rest. Your other programs are not touched. If you added the bot's file to nginx or Apache yourself, delete it as shown above.

Trades that are still open stay open at Deriv, with their stop loss and take profit. Close them first on the bot page if you want.

Afterwards, delete the bot's token on Deriv too.

## Troubleshooting

**The page does not open.**

1. Wait 2 minutes. The https certificate can take a minute the first time.
2. Check your provider's firewall. It must let in **TCP ports 80 and 443** from anywhere (`0.0.0.0/0`). The setup opens the firewall inside the server, but it can't change the one in your provider's dashboard.
   - **Oracle Cloud:** Menu, **Networking**, **Virtual cloud networks**, your network, **Security Lists**, **Default Security List**, **Add Ingress Rules**. Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range `80`. Add it. Do the same for `443`.
   - **Hetzner:** only if you made a firewall: open it and add inbound rules for TCP 80 and 443.
   - **DigitalOcean:** only if you use a Cloud Firewall: **Networking**, **Firewalls**, your firewall, add inbound **HTTP** and **HTTPS**.
   - **AWS Lightsail:** your instance, **Networking**, add **HTTP** and **HTTPS** to the IPv4 firewall.
3. Run the install line again. The end of its message says what is still missing.
4. If you use the free sslip.io address and it still fails after 10 minutes, the certificate service may be busy. Try again later, or use your own domain name (see Install). You can send us what this prints:

   ```
   sudo journalctl -u caddy -n 50 --no-pager
   ```

**"No password is set yet."** Run the install line again and choose a password.

**I forgot the bot password.** Run the install line again. When it says "To keep it, just press Enter. To change it, type a new one", type a new one.

**"Can't reach the bot."** The bot may be restarting. Wait a minute. If it stays, run these two lines and send us what they print:

```
sudo systemctl status tbot --no-pager
sudo journalctl -u tbot -n 50 --no-pager
```

**The setup stopped with an error.** Run it again. That is safe. If it stops again, send us the last lines it printed.

## What the setup adds to your server

| Where | What |
|---|---|
| `/opt/tbot` | The bot's files and its own Node.js. Your system's Node.js is not touched. |
| `/var/lib/tbot` | The bot's saved settings, password hash and token. Only the bot can read it. |
| `/etc/tbot.env` | A few settings, like the private port the bot uses. |
| `tbot` service | Starts the bot when the server starts, and restarts it if it stops. |
| Caddy | The web server that gives the bot its https address. Installed only when ports 80 and 443 were free. |

The bot itself only listens inside the server (127.0.0.1). Caddy passes the web page to it.

## Appendix: a brand-new server, set up while it is created

Most providers let you paste a script that runs once when a new server starts. It is called **user data** or **cloud-init**. Paste this, with your own password between the quotes:

```
#!/bin/bash
export TBOT_PASSWORD='choose-a-long-password'
curl -fsSL https://tbot-mauve-eta.vercel.app/setup.sh -o /root/tbot-setup.sh && bash /root/tbot-setup.sh
```

Where to paste it:

- **Oracle Cloud:** Create instance, pick an Ubuntu image, **Show advanced options**, **Management**, **Paste cloud-init script**.
- **Hetzner:** Create server, pick Ubuntu, then paste it in **Cloud config**.
- **DigitalOcean:** Create Droplet, pick Ubuntu, **Advanced options**, **Add initialization scripts**.

When the server is ready, wait about 5 minutes. Then open `https://` followed by your server's IP address with dashes instead of dots, then `.sslip.io`. For the IP 1.2.3.4 that is `https://1-2-3-4.sslip.io`.

On Oracle Cloud, also add the two firewall rules from Troubleshooting.

The password in user data stays visible in your provider's dashboard. So change it once the bot works: log in to the server and run the install line again, or use **Settings**, **Password** on the bot page.

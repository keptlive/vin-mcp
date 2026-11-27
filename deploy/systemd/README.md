# NHTSA data refresh: timers (not installed)

mcp.vin serves seven NHTSA-derived SQLite files from `data/`. They are **built on the build server** (storage,
104.37.188.237) and **pulled by the web server** (192.210.135.200) over WireGuard, so the web server never
downloads or builds anything large. `docs/nhtsa-local-data.md` ("Refresh") explains the chain; this file is the
install sheet. Nothing here is installed until the owner says "deploy".

| Dataset (data/…) | NHTSA source | NHTSA changes it | Built (build server) | Installed (web) | Mail when |
|---|---|---|---|---|---|
| nhtsa-recalls.db | FLAT_RCL_PRE/POST_2010.zip + campaign API crawl | daily | daily 12:30 UTC, when a file changed | hourly :35 | not confirmed for 48 h; source unchanged 3 d |
| recall-labels.db | FLAT_RCL_PRE/POST_2010.zip | daily | with recalls | hourly | 48 h; 3 d |
| nhtsa-complaints.db | FLAT_CMPL.zip | daily | daily 12:30 UTC | hourly | 48 h; 3 d |
| investigations.db | FLAT_INV.zip | daily | daily 12:30 UTC | hourly | 48 h; 3 d |
| communications.db | TSBS_RECEIVED_*.zip (7 archives, ~88 MB) | daily (all 7 regenerated; the newest gains rows) | daily 12:30 UTC | hourly | 48 h; 3 d |
| nhtsa-ratings.db | SafetyRatings API crawl (current + next model year) | a few new ratings a month | Sundays 05:00 UTC | hourly | crawl older than 15 d |
| vpic.db | vPICList_lite_YYYY_MM.plain.zip | monthly (mid-month) | release check daily 06:10 UTC; build + parity on a new release | hourly | not confirmed for 48 h; release older than 63 d; parity not exact |

Every problem also mails at once: a failed download, build or gate (`builder-status.json`), a file the web server
refuses, pulls failing for 6 h, or no build report for 36 h. Each problem mails at most once per 20 h
(`/opt/host-alert/notify.py --topic nhtsa-… --cooldown 72000`).

## Build server (storage 104.37.188.237)

    # 1. code: the same release the web server runs (copy lib/ scripts/ package*.json like a deploy), then
    cd /opt/vin-mcp-builder && npm ci --omit=dev          # better-sqlite3 for the known-answer checks
    # 2. work dir; seed the crawl states from the research runs so nothing starts from zero
    mkdir -p /srv/nhtsa-build/state /srv/nhtsa-build/publish && chmod 755 /srv/nhtsa-build /srv/nhtsa-build/publish
    cp /root/nhtsa-local/state/recall-campaigns.db /srv/nhtsa-build/state/recall-campaigns.db
    cp /root/nhtsa-local/ratings/harvest.db /srv/nhtsa-build/state/ratings-crawl.db
    mkdir -p /srv/nhtsa-build/vpic && cp -al /root/vpic-local/dryrun/2026_11 /srv/nhtsa-build/vpic/2026_11   # the parity-checked
    #   November build the site runs now: the first vpic run publishes it instead of rebuilding it
    # 3. read-only pull account for the web server (like mcpvin's write-only one)
    useradd --system --create-home --home-dir /home/nhtsapub --shell /bin/sh nhtsapub
    install -d -m 700 -o nhtsapub -g nhtsapub /home/nhtsapub/.ssh
    echo 'command="/usr/bin/rrsync -ro /srv/nhtsa-build/publish",restrict,from="10.77.0.6" <web server key from below>' \
      > /home/nhtsapub/.ssh/authorized_keys && chown nhtsapub: /home/nhtsapub/.ssh/authorized_keys && chmod 600 /home/nhtsapub/.ssh/authorized_keys
    # 4. timers; the first ODI run by hand (about an hour with the campaign crawl)
    cp deploy/systemd/build-server/* /etc/systemd/system/ && systemctl daemon-reload
    systemctl start nhtsa-build-odi.service; journalctl -u nhtsa-build-odi -n 50
    systemctl enable --now nhtsa-build-odi.timer nhtsa-build-ratings.timer nhtsa-build-vpic.timer

A new vPIC release takes hours (PostgreSQL restore + 20,000-VIN parity against NHTSA's own decoder); a release
whose parity is not exact or whose rule fixes need review is held back and mailed. Each release leaves a
PostgreSQL database `vpic_YYYY_MM` (several GB); drop old ones by hand.

## Web server (192.210.135.200)

    ssh-keygen -t ed25519 -N '' -C nhtsa-pull@web -f /root/.ssh/nhtsa_pull     # public key -> nhtsapub above
    ssh-keyscan 10.77.0.1 >> /root/.ssh/known_hosts                            # compare with storage's host key
    rsync -e 'ssh -i /root/.ssh/nhtsa_pull' --list-only nhtsapub@10.77.0.1:    # lists the published files
    mkdir -p /var/lib/vin-mcp-nhtsa
    cp deploy/systemd/web-server/* /etc/systemd/system/ && systemctl daemon-reload
    systemctl start vin-mcp-nhtsa-install.service      # first pull ~2.5 GB over WireGuard; later only changed parts
    systemctl enable --now vin-mcp-nhtsa-install.timer vin-mcp-nhtsa-check.timer

The site code that reads these files must be deployed first: the web server's gate runs the deployed
`scripts/nhtsa-known-answers.mjs` and `lib/` against each new file, so a file the running code cannot read is refused.

## Daily use

    cat /var/lib/vin-mcp-nhtsa/status.jsonl                          # one line per dataset: source date, built, rows, confirmed
    python3 /opt/vin-mcp/scripts/nhtsa_datasets.py check --dry-run   # what would be mailed now
    python3 /opt/vin-mcp/scripts/nhtsa-install.py rollback nhtsa-complaints   # put data/<file>.prev back (that build is never re-installed)
    journalctl -u vin-mcp-nhtsa-install --since -1d                  # web side
    cat /srv/nhtsa-build/publish/builder-status.json                 # build side (storage); logs in /srv/nhtsa-build/logs
    touch /srv/nhtsa-build/STOP-ratings /srv/nhtsa-build/STOP-campaigns   # a running crawl stops cleanly and builds what it has

Disk: the web server keeps each file, its `.prev` and, during a pull, one incoming copy (about 7 GB at most today).

## Stop or remove

    # storage
    systemctl disable --now nhtsa-build-odi.timer nhtsa-build-ratings.timer nhtsa-build-vpic.timer
    rm /etc/systemd/system/nhtsa-build-*.{service,timer} && systemctl daemon-reload
    # web server (the data files stay and keep serving; after 7 days recalls and complaints ask NHTSA live first)
    systemctl disable --now vin-mcp-nhtsa-install.timer vin-mcp-nhtsa-check.timer
    rm /etc/systemd/system/vin-mcp-nhtsa-*.{service,timer} && systemctl daemon-reload

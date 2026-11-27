# Refresh timers for the local NHTSA data (not installed)

`scripts/nhtsa-refresh.sh` keeps mcp.vin's local copies of NHTSA's recalls, complaints and 5-Star Safety Ratings
current (docs/nhtsa-local-data.md). These units run it on the web server. Nothing here is installed by default.

| Unit | When | What | Typical run |
| --- | --- | --- | --- |
| `vin-mcp-nhtsa-flat.timer` | daily 11:40 UTC (+ up to 20 min) | recall + complaint flat files, recall campaign crawl (at most 2,500 campaigns) | 5-10 min; up to about an hour while the campaign crawl fills |
| `vin-mcp-nhtsa-ratings.timer` | Sundays 05:00 UTC (+ up to 30 min) | 5-Star Safety Ratings crawl: recent model years weekly, every model year every 90 days | about 2 h; about 11 h every 90 days |

NHTSA republishes the recall files around 08:00 UTC and the complaint file around 10:15 UTC (Last-Modified headers,
November 2026). Requests to api.nhtsa.gov go one at a time, 1 s apart. Both services run at the lowest CPU and disk
priority with a memory cap; the complaint build peaked at 720 MB and stages about 4 GB of temporary files next to
`data/` (the script refuses to start with less than 8 GB free).

## Install (only with the owner's go)

    cp deploy/systemd/vin-mcp-nhtsa-*.service deploy/systemd/vin-mcp-nhtsa-*.timer /etc/systemd/system/
    systemctl daemon-reload
    # optional: seed the crawl state from the storage server so the first runs do not crawl from scratch
    #   /var/lib/vin-mcp-nhtsa/recall-campaigns.db  (from the storage server's state/recall-campaigns.db)
    #   /var/lib/vin-mcp-nhtsa/ratings-crawl.db     (from the storage server's ratings/harvest.db)
    #   echo <unix time of that full crawl> > /var/lib/vin-mcp-nhtsa/ratings-last-full-crawl
    systemctl start vin-mcp-nhtsa-flat.service      # first run by hand; watch: journalctl -fu vin-mcp-nhtsa-flat
    systemctl enable --now vin-mcp-nhtsa-flat.timer vin-mcp-nhtsa-ratings.timer

## Check and stop

    systemctl list-timers 'vin-mcp-nhtsa-*'
    cat /var/lib/vin-mcp-nhtsa/status.json           # last outcome per dataset
    journalctl -u vin-mcp-nhtsa-flat -u vin-mcp-nhtsa-ratings --since -2d
    touch /var/lib/vin-mcp-nhtsa/STOP-ratings         # a running ratings crawl stops cleanly and builds what it has
    touch /var/lib/vin-mcp-nhtsa/STOP-campaigns       # the same for the recall campaign crawl

A failed run leaves the previous files in place (every build is written beside the old file and renamed over it,
and a build that lost over 1% of its rows is refused). The server keeps answering from the old files; once they are
older than 7 days (recalls, complaints) or 45 days (ratings) it asks NHTSA's live API first again.

## Remove

    systemctl disable --now vin-mcp-nhtsa-flat.timer vin-mcp-nhtsa-ratings.timer
    rm /etc/systemd/system/vin-mcp-nhtsa-*.service /etc/systemd/system/vin-mcp-nhtsa-*.timer
    systemctl daemon-reload

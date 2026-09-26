# TURN usage monitoring

Peerovo can count peer tickets, ICE configuration responses, signaling admissions, and connected peers by project. It cannot see relayed media bytes: when coturn is used, audio and video travel through the separate coturn host.

## What to monitor

- Use the VPS provider's network traffic view for total inbound and outbound traffic on the coturn server.
- Use coturn allocation statistics when per-allocation detail is needed. Peerovo's TURN REST usernames contain the project and session IDs, but they are short-lived usernames; do not enable username-labeled metrics without checking coturn's memory behavior for ephemeral usernames.
- Set a warning threshold from the provider's fair-use policy or written guidance. Some providers describe bandwidth as unmetered fair share and do not publish a fixed monthly GB quota, so a quota-percentage alert may not be available.

## Coturn controls

Coturn can limit concurrent allocations with `user-quota` and `total-quota`, and throughput with `max-bps` per session and `bps-capacity` for the server. These are concurrency and rate limits; they do not set a monthly transfer quota. Avoid setting arbitrary throughput values before checking normal call quality and the provider's guidance.

See the [coturn configuration reference](https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf) and [turnserver options](https://github.com/coturn/coturn/wiki/turnserver). Keep any coturn metrics/admin listener private to the VPS or a trusted monitoring network.

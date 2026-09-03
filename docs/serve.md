# Local-server safety

`docket serve` is a same-computer interface over the current repository. It binds to IPv4 loopback (`127.0.0.1`) and exposes no host override in the first public preview.

The server rejects non-loopback `Host` values. Browser write requests must also carry a same-origin `Origin`; origin-less local clients remain supported. These checks reduce browser-origin and DNS-rebinding risks while keeping the command useful for local tools.

The server has no authentication, authorization, TLS, multi-user isolation, or network deployment contract. Do not place it behind a public tunnel, reverse proxy, LAN address, container ingress, or hosted endpoint. If another person needs access, share the underlying Git repository and let them run their own local process.

`--watch` rebuilds browser assets during frontend development. `--commit` lets supported UI writes create scoped Git commits. Neither flag changes the loopback boundary.

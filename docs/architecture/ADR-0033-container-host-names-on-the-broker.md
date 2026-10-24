# ADR-0033: Accept container host names on the broker's client routes

- **Status:** Accepted and implemented
- **Date:** 2026-10-24
- **Scope:** Which `Host` headers the shared broker on `127.0.0.1:27200` accepts, so that a client running in a Docker or Podman container can reach a vault (#640)
- **Relates to:** [ADR-0021](/docs/architecture/ADR-0021-shared-local-discovery-broker.md) and [ADR-0027](/docs/architecture/ADR-0027-shared-broker-for-all-clients.md) (the broker and its routes), [ADR-0016](/docs/architecture/ADR-0016-omc-008-adopt-mcp-spec-2026-07-28.md) (the Origin check on the vault port)

## Context

A user runs MetaMCP and LiteLLM in Docker on Windows.
They take the URL from a copy button, replace `127.0.0.1` with `host.docker.internal`, and the client reports the server as unhealthy.
The same edit works for their other local MCP servers (#640).

The broker answers every request whose `Host` header is not `127.0.0.1:27200` or `localhost:27200` with `403 untrusted request origin or host` (`brokerServer.ts`, `handle`).
A container that calls `http://host.docker.internal:27200/v1/<route>/mcp` sends `Host: host.docker.internal:27200`, so it gets that `403` before the route, the vault or the bearer token is looked at.
This is verified in the code.
The reporter has not yet confirmed that this is the only cause.

The vault's own port has no `Host` check.
Its middleware checks the method and path, the `Origin` header, the protocol version and the bearer token.
So the same container can reach a vault today on its direct port, for example `http://host.docker.internal:27201/mcp`, if the connection gets through at all.
That URL breaks when the vault's dynamic port changes, unless the vault uses a fixed port.

Both servers bind `127.0.0.1` only.
Docker Desktop on Windows and macOS delivers a connection to `host.docker.internal` to the host's loopback, which is why the user's other servers work.
That is Docker Desktop behaviour, not checked here on Windows.
Docker Engine on Linux without Docker Desktop delivers it on the bridge address instead, which a loopback-bound server never sees.

The `Host` check exists against DNS rebinding.
A page on a name the attacker controls gets that name pointed at `127.0.0.1`, and the browser then sends `Host: attacker.example`.
`host.docker.internal` and `host.containers.internal` are fixed names that Docker Desktop and Podman resolve locally.
A web page cannot make its own origin carry one of them.
A page can still send a request to such a name, but a browser marks every cross-origin request that could reach a route, a `POST`, with its own `Origin`.
The broker rejects any `Origin` that is not loopback, and the vault rejects it again.

## Decision

1. **The broker accepts two more host names on client routes.**
   `host.docker.internal:27200` and `host.containers.internal:27200` join `127.0.0.1:27200` and `localhost:27200`, compared without case.
   They apply to `/v1/<route-id>/mcp` and to the legacy bare `/mcp` only.
   Registration and `/_obsidian_mcp_broker/health` stay loopback-only, because only vaults on the same machine use them.
2. **Nothing else changes.**
   The `Origin` check, the route admission checks and the vault's bearer authentication run as before.
   The broker still rewrites `Host` to `127.0.0.1:<port>` when it forwards, so the vault sees what it sees today.
   Both servers keep binding `127.0.0.1`.
3. **No setting.**
   The list is a constant next to `BROKER_PORT`.
4. **The protocol version stays 3.**
   The change alters what the host accepts, not how vaults and the broker talk.
5. **The README says how to connect from a container.**
   It covers which URL to use, the Docker Desktop and Podman Desktop requirement, and why Docker Engine on Linux is not covered.

## Consequences

- A container on Docker Desktop or Podman Desktop reaches every vault through the broker URL, with only the host name changed.
- Until every open vault runs a release with this change, the broker can be hosted by a vault on an older build, which still refuses the container.
  Restarting Obsidian after updating fixes it.
- Docker Engine on Linux still fails.
  Supporting it means binding a non-loopback address, which opens the vault to the network.
  That needs its own decision.
- The vault's direct port stays without a `Host` check.
  That inconsistency predates this ADR, and this ADR does not change it.

## Alternatives considered

- **An allowed-hosts setting, as the issue asks.**
  Rejected.
  The broker runs in whichever vault won the election (ADR-0027), so a per-vault list would apply or not depending on which vault started first.
  A broker-wide list would need a new shared store and a protocol bump.
  A free-text field would also let a user add a name an attacker controls, which reopens DNS rebinding.
- **Dropping the `Host` check on client routes.**
  Rejected.
  Any name would then pass, and the `Origin` check alone would stand against DNS rebinding.
- **Binding `0.0.0.0`.**
  Rejected for this issue.
  It exposes the vault to the local network, and the reported setup does not need it.
- **Telling container users to use the direct port.**
  This works today and is the workaround for older broker builds, but it breaks every time a dynamic port changes.

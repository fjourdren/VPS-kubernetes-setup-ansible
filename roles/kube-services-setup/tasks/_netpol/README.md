# NetworkPolicy task helpers

Small `include_tasks` helpers used by every service file under
`roles/kube-services-setup/tasks/` to compose NetworkPolicies without
duplicating ~30 lines of YAML per pattern.

Each helper creates exactly **one** `NetworkPolicy` resource, named
`<ns>-<purpose>` (or `<ns>-<name_suffix>-<purpose>` if `name_suffix`
is set, for namespaces that host more than one workload).

## Usage

```yaml
################################################################################
#  NetworkPolicy
################################################################################
- include_tasks: _netpol/default-deny.yml
  vars: { ns: pgadmin }

- include_tasks: _netpol/dns-egress.yml
  vars: { ns: pgadmin }

- include_tasks: _netpol/traefik-ingress.yml
  vars:
    ns: pgadmin
    pod_selector: { app: pgadmin }
    port: 80

- include_tasks: _netpol/egress-to-namespace.yml
  vars:
    ns: pgadmin
    name: postgresql
    pod_selector: { app: pgadmin }
    target_namespace: postgresql
    port: 5432
```

Anything that is genuinely service-specific (e.g. ECK pod-to-pod traffic,
Traefik's egress to every backend namespace, Falco's SMTP egress) stays
inline in the service file. The helpers cover the boilerplate that would
otherwise be duplicated 20+ times.

## Helpers

| Helper | Purpose | Required vars | Optional vars |
|---|---|---|---|
| `default-deny.yml` | `default-deny` ingress + egress | `ns` | — |
| `dns-egress.yml` | Egress to CoreDNS (kube-system, port 53) | `ns` | — |
| `intra-namespace.yml` | Allow pod-to-pod traffic inside the namespace | `ns` | — |
| `kubeapi-egress.yml` | Egress to the kube-apiserver (svc + node ports) | `ns` | — |
| `node-ingress.yml` | Allow kubelet probes (ingress from the node CIDR) | `ns` | — |
| `web-egress.yml` | Egress to Internet on 80/443, block LAN | `ns` | `pod_selector` (default `{}`), `name_suffix` (default `web`), `ports` (default `[80, 443]`) |
| `traefik-ingress.yml` | Ingress from the `traefik` namespace on `port` | `ns`, `pod_selector`, `port` | `name_suffix` (default `traefik`) |
| `prometheus-scrape.yml` | Ingress from the `monitoring` namespace on `ports` | `ns`, `pod_selector`, `ports` | `name_suffix` (default `prometheus-scrape`) |
| `kuma-probe.yml` | Ingress from Uptime Kuma on `port` (TCP probe) | `ns`, `pod_selector`, `port` | — |
| `egress-to-namespace.yml` | Egress from `pod_selector` to `target_namespace` on `port`/`ports` | `ns`, `name`, `pod_selector`, `target_namespace` | `port` or `ports` |

## Conventions

- `ns` is always the source namespace (where the policy is created).
- `pod_selector` is a `matchLabels`-style dict, e.g. `{ app: pgadmin }` or
  `{ app.kubernetes.io/name: postgresql }`.
- `port` is a single TCP port; `ports` is a list of TCP ports.
- All helpers create policies with `state: present` and rely on
  `kubernetes.core.k8s` idempotency — re-running the playbook is a no-op.

## Why this layout

Without these helpers, each service file would carry ~80 lines of
identical YAML for the four boilerplate policies. With ~22 namespaces
that's ~1700 lines of pure duplication that need to be edited in lockstep
every time the pattern changes (and easy to drift out of sync, as it had).

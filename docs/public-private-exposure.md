# Modèle d'exposition : services publics vs privés

Tout ce qui, dans ce dépôt, décide qu'un service est joignable depuis Internet
ou seulement depuis le LAN/Tailscale. Sources : `roles/kube-services-setup/tasks/`
(metalb, traefik, cert-manager, coredns-local, block-local-access, `_netpol/`) et
`roles/cloudflare-ddns/`.

Voir aussi [`tailscale-metallb-access.md`](tailscale-metallb-access.md) : MetalLB,
Tailscale et les trois chemins d'accès de bout en bout.

---

## 1. Le principe en une phrase

Deux IP LoadBalancer MetalLB, deux services Traefik, deux jeux d'entrypoints.
Internet ne parle qu'à `network.public_address` ; le LAN et le tailnet ne parlent
qu'à `network.private_address`. Les backends (Postgres, Redis, …) n'ont jamais de
LoadBalancer, ils restent en ClusterIP derrière des NetworkPolicies.

---

## 2. Les variables qui pilotent tout

`secrets.yml` (voir `secrets-example.yml`) :

| Variable | Rôle |
|---|---|
| `network.public_address` | IP du pool MetalLB public (ex. `192.168.1.210`) — celle vers laquelle le routeur NAT 80/443/25565 |
| `network.private_address` | IP du pool MetalLB privé (ex. `192.168.1.220`) — **aucun port-forward** dessus |
| `network.private_cidr` | CIDR du LAN (ex. `192.168.1.0/24`), utilisé partout comme « LAN à bloquer » en egress |
| `network.public_domain` | Domaine public (Cloudflare), utilisé par les routes `*-public` |
| `network.private_domain` | Domaine privé (ex. `lan`), résolu par CoreDNS local, utilisé par les routes `*-private` |
| `network.host_gateway` | Passerelle, seule exception LAN autorisée en egress global |
| `traefik.allowed_ips` | Liste optionnelle ajoutée au middleware `whitelist-local` |
| `cloudflare.records` | Enregistrements DNS mis à jour par le DDNS (avec `proxy: true`) |

---

## 3. Couche L3 — MetalLB : deux pools

`roles/kube-services-setup/tasks/metalb.yml`

```yaml
IPAddressPool public-pool   -> network.public_address  (autoAssign: false)
IPAddressPool private-pool  -> network.private_address (autoAssign: false)
L2Advertisement public-advertisement  -> public-pool
L2Advertisement private-advertisement -> private-pool
```

Chaque pool ne contient **qu'une seule adresse** (`X-X`) et `autoAssign: false` :
aucun `Service: LoadBalancer` ne peut piocher une IP par accident, il faut
l'annotation explicite `metallb.universe.tf/address-pool`. La tâche est censée
supprimer aussi tout pool/L2Advertisement par défaut qui ne s'appelle pas
`public-pool` / `private-pool` — le garde-fou du pool ne fonctionne pas, voir
[`tailscale-metallb-access.md`](tailscale-metallb-access.md) §2.

---

## 4. Couche L4 — Traefik : deux Services LoadBalancer

`roles/kube-services-setup/tasks/traefik.yml` — le Service par défaut du chart est
désactivé (`service.enabled: false`), remplacé par deux `additionalServices` :

| Service | Pool | Annotations | Particularité |
|---|---|---|---|
| `public` | `public-pool` → `network.public_address` | `allow-shared-ip: traefik-public` | `externalTrafficPolicy: Local` |
| `private` | `private-pool` → `network.private_address` | `allow-shared-ip: dns-private` | `externalTrafficPolicy` par défaut (`Cluster`) |

`externalTrafficPolicy: Local` sur le public est **obligatoire** : sans lui kube-proxy
SNAT l'IP source, le bouncer CrowdSec verrait l'IP d'un nœud au lieu de l'IP edge
Cloudflare, et les bans viseraient nos propres nœuds. Contrepartie : les paquets sont
droppés sur les nœuds sans pod Traefik — sans effet ici, MetalLB n'annonce la VIP que
depuis les nœuds qui en hébergent un.

### Entrypoints

Les entrypoints `web`/`websecure` du chart sont mis à `null` et remplacés :

| Entrypoint | Port pod | Port exposé | Exposé sur |
|---|---|---|---|
| `web-public` | 8080 | 80 | service `public` |
| `websecure-public` | 8443 | 443 | service `public` |
| `minecraft` | 25565 | 25565 | service `public` |
| `web-private` | 8081 | 80 | service `private` |
| `websecure-private` | 8444 | 443 | service `private` |
| `traefik` | 9003 | 9003 | aucun (dashboard interne) |

Les entrypoints publics portent `forwardedHeaders.trustedIPs` = les plages
Cloudflare, récupérées **dynamiquement au déploiement** via
`https://www.cloudflare.com/ips-v4/` et `/ips-v6/` (tâches en tête de `traefik.yml`).
C'est ce qui permet à Traefik d'extraire la vraie IP visiteur depuis `X-Forwarded-For`.

---

## 5. Couche L7 — les middlewares

Créés en `extraObjects` du chart Traefik, namespace `traefik` :

| Middleware | Type | Contenu |
|---|---|---|
| `cloudflare-ips` | `ipAllowList` | plages Cloudflare v4+v6 récupérées à chaud |
| `crowdsec-bouncer` | plugin | `crowdsecMode: stream`, LAPI `crowdsec-service.crowdsec.svc:8080`, `forwardedHeadersTrustedIPs` = plages Cloudflare |
| **`public-security`** | `chain` | `cloudflare-ips` → `crowdsec-bouncer` |
| **`whitelist-local`** | `ipAllowList` | `127.0.0.1/8`, `192.168.0.0/16`, `10.0.0.0/8`, `100.64.0.0/10` + `traefik.allowed_ips` |
| `redirect-to-https` | `redirectScheme` | vers https, permanent |
| `redirect-to-dashboard` | `redirectRegex` | `^/$` → `/dashboard/` |

`allowCrossNamespace: true` est activé sur le provider CRD : c'est ce qui permet à une
IngressRoute dans `nginx` ou `heimdall` de référencer un middleware du namespace `traefik`.

---

## 6. Le contrat par service

### Service public — patron (`nginx.yml`, `n8n-webhook-proxy.yml`, `wordpress.yml`)

1. **Certificat** : `Certificate` cert-manager, `issuerRef: letsencrypt-prod`,
   `dnsNames: <app>.{{ network.public_domain }}`, secret `<app>-cert-prod`.
2. **Nettoyage ACME** : `include_tasks: _cf-acme-cleanup.yml` avant la demande de
   certificat — purge les TXT `_acme-challenge` restés sur Cloudflare quand une
   validation DNS-01 a été interrompue, **uniquement** si le Secret TLS n'existe pas
   encore localement.
3. **IngressRoute HTTP** sur `web-public`, middlewares `public-security` +
   `redirect-to-https`.
4. **IngressRoute HTTPS** sur `websecure-public`, middleware `public-security`,
   `tls.secretName: <app>-cert-prod`.
5. **NetworkPolicies** : `default-deny` + `dns-egress` + `traefik-ingress` (+ egress
   spécifiques).
6. **DNS public** : ajouter l'enregistrement dans `cloudflare.records` avec
   `proxy: "true"`.

### Service privé — patron (`heimdall.yml`, `prometheus-ingress.yml`, `kuma.yml`, `pgadmin.yml`, `n8n.yml`, `ghostfolio.yml`, `nextcloud.yml`, `jellyfin.yml`, `qbittorrent.yml`, `portainer.yml`)

1. **Pas de certificat** — aucune IngressRoute privée ne définit de bloc `tls`.
   `websecure-private` sert donc le certificat auto-signé par défaut de Traefik.
2. **Une seule IngressRoute** sur `[web-private, websecure-private]`, middleware
   `whitelist-local`, match `Host(\`<app>.{{ network.private_domain }}\`)`.
3. **Pas de redirection HTTP→HTTPS** : le HTTP en clair est accepté tel quel.
4. Mêmes NetworkPolicies que le public.
5. Résolution DNS assurée par le wildcard CoreDNS local, rien à déclarer.

### Cas particulier TCP — Minecraft

`IngressRouteTCP` sur l'entrypoint `minecraft` (25565), `match: HostSNI(\`*\`)`.
Public, mais **sans** `public-security` : SNI vide sur le protocole Minecraft, donc ni
allowlist Cloudflare (Cloudflare ne proxifie pas ce port de toute façon) ni bouncer L7.
La seule protection à ce niveau est le bouncer firewall nftables (§8).

### Cas particulier — dashboard Traefik

Déclaré dans les values du chart (`ingressRoute.dashboard`) sur
`web-private` + `websecure-private`, middlewares `redirect-to-dashboard` +
`whitelist-local`, hôte `traefik.{{ network.private_domain }}`.

---

## 7. DNS

### Public — `roles/cloudflare-ddns/`

Rôle exécuté `run_once` depuis un nœud control-plane. Clone
`K0p1-Git/cloudflare-ddns-updater` (commit épinglé), génère **un script par
enregistrement** de `cloudflare.records`, l'exécute immédiatement, puis pose un cron
root par enregistrement. Chaque entrée porte `proxy: "true"` → le trafic passe par
l'edge Cloudflare, ce qui est la prémisse du filtre `cloudflare-ips`.

### Privé — `coredns-local.yml`

CoreDNS déployé dans `dns-system`, exposé en LoadBalancer sur
`network.private_address` (UDP+TCP 53) **en partageant l'IP avec Traefik privé** via
`metallb.universe.tf/allow-shared-ip: dns-private`.

Corefile, trois blocs :
- `{{ network.private_domain }}:53` → zone fichier `private.db` avec `@ IN A` et
  `* IN A` pointant sur `network.private_address` → **tout** `*.lan` résout vers
  Traefik privé, aucun enregistrement à créer par service.
- `cluster.local:53` → forward vers kube-dns `10.152.183.10`, pour les pods qui
  utilisent CoreDNS local avec `dnsPolicy: None` (cas d'Uptime Kuma).
- `.:53` → forward `9.9.9.9`, `8.8.8.8`, `network.dns`.

Egress verrouillé : DNS sortant vers `0.0.0.0/0` **except** `network.private_cidr`.
Ingress ouvert à tous mais restreint aux ports 53/8080/8181.

### Accès tailnet — `tailscale.yml`

Opérateur Tailscale + `Connector` subnet router qui annonce `tailscale.advertise_routes`
(LAN + CIDR pods + CIDR services). Les membres du tailnet atteignent donc
`network.private_address` comme s'ils étaient sur le LAN. `apiServerProxyConfig.mode: "true"`
expose en plus le kube-apiserver au tailnet.

---

## 8. Défense en profondeur

### CrowdSec — deux bouncers

- **Bouncer Traefik** (plugin L7, `crowdsec.traefik_bouncer_key`) : dans la chaîne
  `public-security`, décide au niveau HTTP. Les logs d'accès Traefik sont la source
  des décisions (`logs.access.enabled: true`, tous champs `keep`).
- **Bouncer firewall** (`crowdsec.firewall_bouncer_key`) : DaemonSet `hostNetwork: true`,
  capacités `NET_ADMIN`/`NET_RAW`, backend **nftables** (`deny_action: DROP`, hooks
  `input` + `forward`). Il filtre donc aussi ce que le L7 ne voit pas — dont Minecraft.

### NetworkPolicies — `_netpol/`

Helpers réutilisables (voir `_netpol/README.md`). Ceux qui touchent l'exposition :

| Helper | Effet |
|---|---|
| `default-deny.yml` | deny ingress + egress sur tout le namespace |
| `traefik-ingress.yml` | rouvre l'ingress **uniquement** depuis le namespace `traefik`, sur un port |
| `web-egress.yml` | egress Internet 80/443, LAN exclu |
| `node-ingress.yml` | ingress depuis le CIDR nœud (sondes kubelet) |

Traefik lui-même a une policy explicite `traefik-allow-all-ingress` (`0.0.0.0/0` +
`::/0`) — c'est son rôle de reverse proxy public ; le filtrage se fait au L7. Son
egress est limité à une liste blanche de namespaces backends
(`traefik-allow-apps-egress`) : **ajouter le namespace ici en même temps qu'une
nouvelle app**, sinon la route renverra une erreur.

### Blocage LAN global — `block-local-access.yml`

Dernière tâche de `main.yml`. Sur **chaque** namespace sauf `kube-system`,
`kube-public`, `kube-node-lease` : egress vers `0.0.0.0/0` **except**
`network.private_cidr`, le CIDR pods `10.1.0.0/16` et le CIDR services
`10.152.183.0/24`, plus une autorisation explicite vers `network.host_gateway/32`.
Un pod compromis ne peut donc scanner ni le LAN ni le cluster. `kube-system` est
exclu pour laisser passer le driver CSI NFS.

Les deux CIDR cluster manquaient jusqu'à la correction du finding #1 de
[`tailscale-metallb-access.md`](tailscale-metallb-access.md) : comme les règles
NetworkPolicy s'unionnent, cette policy rouvrait alors tout l'intra-cluster et
annulait `default-deny`, `egress-to-namespace` et `traefik_backend_namespaces`.
La règle reste **sans restriction de port** vers Internet, volontairement : le
self-check DNS-01 de cert-manager sort en 53 vers des résolveurs publics.

Seule exception assumée : `kuma-allow-uptime-kuma-egress` autorise Uptime Kuma à
joindre `network.public_address/32` (sonde TCP Minecraft). Attention à la portée
réelle : la règle n'a **aucune** restriction de port, et elle garde délibérément
les CIDR cluster ouverts — sonder les services in-cluster sur des ports
arbitraires est le métier de ce pod. Elle reste bornée par son
`podSelector: app: uptime-kuma`.

### cert-manager

ClusterIssuers `letsencrypt-staging` et `letsencrypt-prod`, solver **DNS-01 Cloudflare**
uniquement — aucun challenge HTTP-01, donc aucune ouverture temporaire de route publique
n'est nécessaire pour émettre un certificat.

---

## 9. Matrice des flux

| Flux | Chemin | Ce qui filtre |
|---|---|---|
| Internet → service public | Cloudflare → NAT routeur → `public_address` → Traefik public → ClusterIP | `cloudflare-ips` + `crowdsec-bouncer`, TLS Let's Encrypt, NetworkPolicy `allow-traefik-ingress` |
| Internet → service privé | *(bloqué)* | pas de port-forward vers `private_address` |
| LAN → service privé | device LAN → `private_address` → Traefik privé | `whitelist-local`, NetworkPolicies |
| Tailscale → service privé | tailnet → subnet router → `private_address` | ACL tailnet, puis identique au LAN |
| LAN → service public | device LAN → `public_address` | `cloudflare-ips` rejette (IP source réelle préservée par `externalTrafficPolicy: Local`) |
| Internet → Minecraft | NAT 25565 → `public_address` → entrypoint `minecraft` | bouncer firewall nftables uniquement |
| Pod → base de données | ClusterIP `postgresql.postgresql.svc:5432` | `default-deny` + `egress-to-namespace` explicite |
| Pod → LAN | *(bloqué)* | `block-local-lan-egress-except-gw-nfs` |

---

## 10. Ajouter un service

**Public**
1. Namespace + Deployment + Service **ClusterIP**.
2. `_cf-acme-cleanup.yml` puis `Certificate` (`letsencrypt-prod`).
3. IngressRoute `web-public` (+ `redirect-to-https`) et `websecure-public`, middleware
   `public-security` dans les deux.
4. NetPol : `default-deny`, `dns-egress`, `traefik-ingress`.
5. Ajouter le namespace à `traefik_backend_namespaces` dans `traefik.yml`.
6. Ajouter l'enregistrement dans `cloudflare.records` (`proxy: "true"`).

**Privé**
1. Namespace + Deployment + Service **ClusterIP**.
2. Une IngressRoute `[web-private, websecure-private]`, middleware `whitelist-local`,
   hôte `<app>.{{ network.private_domain }}`.
3. NetPol : idem.
4. Ajouter le namespace à `traefik_backend_namespaces`.
5. Rien à faire côté DNS (wildcard CoreDNS).

---

## 11. Limites connues

- **`whitelist-local` est large** : `192.168.0.0/16` + `10.0.0.0/8` acceptent tout le
  LAN, y compris un IoT ou un Wi-Fi invité sur le même subnet. Le vrai verrou du privé
  reste « peux-tu router jusqu'à `private_address` ». `100.64.0.0/10` (CGNAT
  Tailscale) fait maintenant partie du défaut du code — ce n'était pas le cas
  auparavant, malgré ce qu'affirmait le README.
- **Les routes privées acceptent le HTTP en clair** sans redirection, et
  `websecure-private` n'a pas de certificat valide. Les identifiants transitent en clair
  si l'utilisateur tape `http://`. Correctif : ajouter `redirect-to-https` aux
  IngressRoutes privées (patron déjà présent sur `nginx-http-redirect`).
- **`traefik-private` reste en `externalTrafficPolicy: Cluster`** : sur plusieurs nœuds
  l'IP source peut être SNATée, les logs privés ne montrent donc pas toujours le vrai
  client.
- **`traefik_backend_namespaces` est une liste manuelle** dans `traefik.yml` : oubli =
  route qui renvoie une erreur, sans message évident.
- **Minecraft n'a aucune protection L7** — seul le bouncer nftables le couvre.

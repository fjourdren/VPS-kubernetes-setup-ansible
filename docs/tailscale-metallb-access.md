# Tailscale, MetalLB et les trois chemins d'accès

Comment un paquet arrive jusqu'à un service, selon qu'il vient d'Internet, du LAN
ou du tailnet. Sources : `roles/kube-services-setup/tasks/` (metalb, tailscale,
traefik, coredns-local, block-local-access, `_netpol/`), `roles/cloudflare-ddns/`,
`provision.yml`, `deploy.yml`.

Complément de [`public-private-exposure.md`](public-private-exposure.md), qui
couvre la couche Traefik (entrypoints, middlewares, contrat par service). Ce
document-ci couvre ce qu'il y a **en dessous** : MetalLB, Tailscale, et les
chemins de bout en bout.

> Analyse statique du dépôt. Les points marqués « à confirmer » n'ont pas été
> vérifiés sur le cluster.
>
> **État au 2026-08-16 : les findings #1, #2, #3, #4, #6 et #7 sont corrigés dans
> le code.** La §5 les conserve pour mémoire, chacun annoté de son correctif.

---

## 1. Le plan en une image

```
Internet ──Cloudflare(proxy)──NAT routeur 80/443/25565──► 192.168.1.210  traefik-public
LAN      ──────────────────────────────────────────────► 192.168.1.220  traefik-private + CoreDNS
Tailnet  ──WireGuard/DERP──► pod subnet-router ──SNAT──► 192.168.1.220  (identique au LAN)
```

Un seul nœud (`192.168.1.202`) et **aucun firewall hôte** :
`security_enable_firewall: false` (`provision.yml:32`). Le seul filtrage L3 sur
l'hôte est le bouncer nftables CrowdSec (hooks `input` + `forward`).

---

## 2. MetalLB — `tasks/metalb.yml`

| Point | État |
|---|---|
| Installation | Helm, `speaker.frr: false` + `frrk8s: false` → **L2 pur (ARP)**, pas de BGP. L'addon microk8s `metallb` n'est pas activé dans `deploy.yml` → pas de conflit. |
| Pools | Deux pools d'**une seule adresse** (`X-X`), `autoAssign: false`. |
| Consommateurs | Exactement trois Services : `traefik-public` (.210), `traefik-private` (.220), `coredns-local` (.220 partagée). Aucune base de données n'a de LoadBalancer. |
| Partage d'IP | `allow-shared-ip: dns-private` sur `.220`, ports disjoints (80/443 TCP vs 53 UDP+TCP) → valide. |
| `externalTrafficPolicy` | `Local` sur public, `Cluster` sur privé. |

`autoAssign: false` est le vrai verrou du modèle : aucun `Service: LoadBalancer`
ne peut piocher une IP par accident, l'annotation `metallb.universe.tf/address-pool`
est obligatoire.

### Pourquoi `traefik-private` ne peut pas passer en `Local`

MetalLB n'autorise le partage d'une IP que si **tous** les Services concernés sont
en `externalTrafficPolicy: Cluster`, ou **tous** en `Local **et** pointant vers le
même set de pods. Traefik ≠ CoreDNS → tant que `.220` est partagée avec CoreDNS,
`traefik-private` est verrouillé en `Cluster`. Ce n'est pas un oubli : pour obtenir
l'IP source réelle côté privé, il faudrait d'abord donner une IP dédiée à CoreDNS.

### Limites

- ~~**Le nettoyage des pools par défaut est mort**~~ — **corrigé.** La condition
  était `when: ansible_host in (item.spec.addresses | join(','))`, un test de
  sous-chaîne : `ansible_host` vaut `192.168.1.202`, un pool par défaut contient
  une plage type `192.168.1.240-192.168.1.250` → jamais vrai, la tâche ne
  supprimait rien. Remplacée par `item.spec.autoAssign | default(true)`, qui
  exprime le vrai danger : un pool étranger qui distribue des IP tout seul est
  supprimé, un pool manuel créé à la main survit. Le nettoyage des
  `L2Advertisement` juste en dessous n'a toujours pas de garde-fou et supprime
  tout ce qui n'est pas `public-advertisement` / `private-advertisement`.
- **Mono-nœud** : un seul speaker, pas de failover L2. Les deux VIP tombent avec
  le nœud.

---

## 3. Tailscale — `tasks/tailscale.yml`

Opérateur installé par Helm (OAuth), plus un `Connector` subnet router qui annonce
`tailscale.advertise_routes` : LAN `192.168.1.0/24`, pods `10.1.0.0/16`, services
`10.152.183.0/24`. `apiServerProxyConfig.mode: "true"` expose en plus le
kube-apiserver au tailnet (identité tailnet → RBAC).

Aucune annotation `tailscale.com/expose` n'est utilisée : rien n'est exposé
service par service sur le tailnet, tout passe par le routage de sous-réseau.

NetworkPolicies du namespace : `default-deny`, `dns-egress`, `intra-namespace`,
`kubeapi-egress`, `node-ingress`, plus deux règles spécifiques — egress tailnet
(TCP/443 + UDP tous ports, LAN exclu) et egress vers les routes annoncées.

### Les pods Tailscale ne sont **pas** `hostNetwork`

Le README les liste parmi les pods host-network : c'est faux. Les proxies de
l'opérateur sont des pods normaux (`NET_ADMIN` + `/dev/net/tun`). C'est
précisément pour ça que les deux policies d'egress ci-dessus sont nécessaires —
sur un pod host-network elles ne s'appliqueraient pas du tout. Les vrais
host-network du cluster sont le speaker MetalLB et le bouncer firewall CrowdSec.
(Falco est annoncé host-network dans un commentaire de `falco.yml`, mais rien ne
le règle dans les values et le chart amont est à `false` — à vérifier. « Filebeat »
n'existe pas dans le dépôt : le log shipping, c'est Loki/Promtail.)

### Tout repose sur le SNAT du subnet router

Par défaut `--snat-subnet-routes=true` : le paquet qui arrive sur `.220` a pour
source l'IP du pod (`10.1.x.x`), et `whitelist-local` le laisse passer via
`10.0.0.0/8`. Depuis la correction du finding #2, `100.64.0.0/10` est aussi dans
la `sourceRange`, donc l'accès tient également sans SNAT. Conséquences :

- désactiver le SNAT ne casse plus l'accès privé (c'était un 403 systématique
  avant le correctif) ;
- les logs d'accès Traefik privés ne montrent jamais quel utilisateur tailnet a
  fait quoi : une seule IP de pod pour tout le monde.

### Étapes manuelles, hors Ansible

1. **ACL tailnet** (`tagOwners` pour `tag:k8s-operator` / `tag:k8s`) — elle fait
   partie du périmètre de sécurité, elle donne un accès de niveau LAN, et elle
   n'est pas versionnée ici. La garder tag-scopée, jamais « tous les
   utilisateurs ».
2. **Approbation des routes** dans la console (sinon elles restent `pending` et
   rien ne circule). `autoApprovers` dans l'ACL supprime cette étape.
3. **Split-DNS** : voir §4.
4. **RBAC du proxy API server** : aucun `RoleBinding` n'est créé par le dépôt, les
   membres du tailnet prennent un 403 tant que le RBAC n'est pas fait à la main.

`tailscale.advertise_routes` code en dur les CIDR pods/services de MicroK8s. S'ils
diffèrent sur le cluster, le debug ClusterIP/PodIP échoue sans message clair (la
commande de vérification est dans le README, section *Tailscale Setup*).

---

## 4. Les trois chemins de bout en bout

### Internet

Cloudflare (enregistrements `proxy: true`, DDNS cron horaire par enregistrement)
→ NAT routeur 80/443/25565 → `.210` → `forwardedHeaders.trustedIPs` = plages
Cloudflare → chaîne `public-security` (`cloudflare-ips` puis `crowdsec-bouncer`)
→ backend ClusterIP. Certificats Let's Encrypt via DNS-01 Cloudflare.

`externalTrafficPolicy: Local` préserve l'IP source, c'est ce qui rend l'allowlist
Cloudflare et les bans CrowdSec exploitables.

Minecraft (25565) sort de ce cadre : `HostSNI(*)`, pas de `public-security`, pas de
Cloudflare devant — seul le bouncer nftables couvre ce port.

### LAN

`.220:80/443` → `web-private` / `websecure-private` → `whitelist-local` →
ClusterIP. DNS assuré par CoreDNS local sur la même VIP, wildcard
`* IN A 192.168.1.220` → aucun enregistrement à créer par service.

- **Rien dans le dépôt ne configure les clients LAN pour utiliser `.220` comme
  résolveur** : c'est un réglage DHCP du routeur, manuel. Le nœud lui-même pointe
  sur `network.dns`.
- CoreDNS accepte l'ingress DNS depuis `0.0.0.0/0` → **résolveur récursif ouvert**
  pour le LAN et le tailnet. Risque faible tant que la VIP n'est pas joignable
  depuis Internet, mais c'est un vecteur d'amplification si elle le devient.
- Le vrai verrou du privé est topologique — « le routeur ne NAT pas vers `.220` ».
  `whitelist-local` n'est que de la défense en profondeur.

### Tailnet

Client → WireGuard (direct ou DERP, **aucun port à ouvrir**) → pod subnet-router →
SNAT `10.1.x.x` → `.220` → `traefik-private` → `whitelist-local` → ClusterIP.
Plus : le LAN complet (`192.168.1.x`), les ClusterIP/PodIP pour le debug, et le
kube-apiserver via le proxy HTTPS de l'opérateur.

Le tailnet **n'est pas un contournement d'authentification** : les NetworkPolicies
d'ingress s'appliquent toujours, et le namespace `tailscale` n'est dans aucune
allowlist de PostgreSQL/Redis — un client tailnet ne peut pas parler au 5432 même
en routant vers le service CIDR.

Pour résoudre `*.lan` depuis un client tailnet, MagicDNS seul **ne suffit pas** :
il faut un split-DNS — *admin console → DNS → Nameservers → Add nameserver
`192.168.1.220`, Restrict to domain `lan`*. Sans ça, il faut taper les IP.

---

## 5. Findings

### ✅ #1 — `block-local-access.yml` annulait la moitié egress du modèle — **corrigé**

Dernière tâche de `main.yml`, appliquée à **tous** les namespaces sauf les trois
`kube-*`, avec `podSelector: {}`. Les deux règles n'ont aucun `ports:`, et les
règles NetworkPolicy sont une **union** : comme les CIDR cluster n'étaient pas
dans l'`except`, chaque pod obtenait un egress libre vers **toutes** les IP de
pods (`10.1.0.0/16`) et tous les ClusterIP (`10.152.183.0/24`). `default-deny`
(egress), `egress-to-namespace` et `traefik_backend_namespaces` ne filtraient donc
plus rien en intra-cluster.

Correctif appliqué :

```yaml
except:
  - "{{ network.private_cidr }}"
  - "10.1.0.0/16"        # CIDR pods MicroK8s
  - "10.152.183.0/24"    # CIDR services MicroK8s
```

La règle reste **volontairement sans restriction de port** vers Internet : le
self-check DNS-01 de cert-manager sort en UDP/TCP 53 vers des résolveurs publics
(cf. [`https-certificates.md`](https-certificates.md) §5). La resserrer à 80/443
casserait l'émission des certificats en silence.

**Le même motif existait à trois autres endroits**, non relevés dans la première
passe — les corriger était nécessaire pour que le #1 serve à quelque chose :

| Fichier | Portée du trou | État |
|---|---|---|
| `_netpol/web-egress.yml` | egress intra-cluster sur les ports du helper (80/443 par défaut), pour tout pod couvert | corrigé |
| `qbittorrent.yml` (`media-allow-qbittorrent-internet-egress`) | **tous ports**, vers tous les pods et tous les services | corrigé |
| `argocd.yml` (`argocd-repo-server`) | aucun `except` du tout — même le LAN passait ; rôle désactivé dans `main.yml` | corrigé |

`kuma.yml` garde délibérément les CIDR cluster ouverts : sonder les services
in-cluster sur des ports arbitraires est précisément le métier d'Uptime Kuma. La
règle reste bornée par `podSelector: app: uptime-kuma`.

**Trois chemins légitimes tombaient** avec ce durcissement et ont été rouverts
explicitement dans le même lot :

- **Grafana → Loki** (`loki.logging.svc:3100`). Les deux policies de scrape de
  `prometheus.yml` sont épinglées sur `app.kubernetes.io/name: prometheus` ;
  Grafana n'avait aucune règle inter-namespace. L'ingress côté Loki l'autorisait
  déjà — seul l'egress manquait.
- **Traefik → `media`.** `media` manquait de `traefik_backend_namespaces` ;
  Jellyfin (8096) et qBittorrent (8080) écoutent hors 80/443, donc le `web-egress`
  de Traefik ne les rattrapait pas.
- **`container-registry` et `default`** perdaient le DNS : aucune tâche ne les
  possède, donc aucune policy egress propre. `block-local-access.yml` leur pose
  maintenant un `_netpol/dns-egress.yml`.

⚠️ `dns-system` survit **de justesse** : sa règle inline garde
`0.0.0.0/0 except [private_cidr]` sur le port 53, ce qui couvre encore
`forward . 10.152.183.10`. Ne pas y propager les nouveaux `except` sans ajouter
d'abord un peer explicite vers le CoreDNS de `kube-system` — sinon `dns-system`
tombe et emporte le DNS d'Uptime Kuma (`dnsPolicy: None`).

**n8n** semblait au départ impossible à durcir — ses workflows vivent en base, pas
dans le dépôt. En réalité ils ne composent pas les services externes eux-mêmes :
ils passent par `n8n-webhook-proxy`. n8n n'a donc qu'**une** destination
in-cluster, et la policy est nominative :

```yaml
- include_tasks: _netpol/egress-to-namespace.yml
  vars: { ns: n8n, name: webhook-proxy, pod_selector: { app: n8n },
          target_namespace: n8n-webhook-proxy, port: 3000 }
```

Le port est **3000**, pas 80 : kube-proxy DNAT le Service (`80 → targetPort 3000`)
avant que Calico n'évalue l'egress, donc c'est le port du conteneur qu'il faut
nommer. Le dépôt appliquait déjà cette règle sans le dire —
`n8n-webhook-proxy-allow-n8n-egress` vise 5678 et non 80.

Deux manques côté proxy, invisibles tant que le blanket egress existait :

- son `default-deny` ingress n'admettait que le namespace `traefik`, donc l'appel
  in-cluster depuis n8n était refusé — seul le chemin public
  (`webhook.<domaine>` via Cloudflare) fonctionnait. Ajout de
  `n8n-webhook-proxy-allow-n8n-ingress` (3000).
- il n'avait **aucune** policy d'egress Internet : ses appels vers les cibles
  externes ne passaient que par la règle sans port de `block-local-access`. Ajout
  d'un `_netpol/web-egress.yml` explicite.

Reste vrai : un workflow qui composerait directement un service in-cluster, sans
passer par le proxy, n'est pas couvert. C'est le seul scénario à vérifier.

À confirmer sur le cluster :
`kubectl exec -n heimdall <pod> -- nc -zv postgresql.postgresql.svc 5432` doit
maintenant échouer.

### ✅ #2 — `whitelist-local` sans `100.64.0.0/10` — **corrigé**

`traefik.yml` ne contenait que `127.0.0.1/8`, `192.168.0.0/16`, `10.0.0.0/8` +
`traefik.allowed_ips` — une variable qui n'existe **nulle part** dans le dépôt
(ni `secrets.yml`, ni `secrets-example.yml`, ni `defaults/`), et qui ne résolvait
à `[]` que grâce au `| default([])`. Le README affirmait le contraire à trois
endroits.

Correctif : la CGNAT est passée dans le défaut du code plutôt que dans le vault,
ce qui rend le README vrai sans l'éditer. Ça marchait jusqu'ici uniquement grâce
au SNAT du subnet router (§3) ; désormais l'accès tient aussi si le SNAT est
désactivé.

### ✅ #3 — Split-DNS tailnet absent de la doc — **corrigé**

Le chemin réseau fonctionnait, la résolution de noms non. Documenté dans le README,
*Tailscale Setup → 6. Add split-DNS for the private domain*.

### ✅ #4 — `network.dns` en 3ᵉ upstream de CoreDNS local — **corrigé**

`coredns-local.yml` interdisait l'egress vers le LAN alors que le bloc `.:53`
forwarde vers `9.9.9.9`, `8.8.8.8` **et `network.dns`**. Ça ne fonctionnait que
parce que `block-local-access` rouvre `host_gateway/32` et que
`network.dns == host_gateway`. Un Pi-hole en `.200` aurait été bloqué en silence.

Correctif : la policy du pod autorise maintenant explicitement
`{{ network.dns | default(network.host_gateway) }}/32` sur le port 53. Le
`default()` conserve le contrat optionnel de la variable (la Corefile la garde
derrière un `is defined`).

### 🟡 #5 — Le « blocage LAN » ne bloque pas les VIP MetalLB — *comportement voulu*

kube-proxy DNAT l'IP du LoadBalancer **avant** que Calico n'évalue la policy
d'egress. Un pod atteint donc `192.168.1.220:53` ou `.210:25565` malgré le
`except: 192.168.1.0/24`. C'est ce qui fait fonctionner Uptime Kuma
(`dnsPolicy: None` → nameserver `192.168.1.220`). Rien à corriger côté code, mais
à connaître : « LAN bloqué » signifie « hôtes LAN réels », pas « VIP de service ».

La policy s'appelle `kuma-allow-uptime-kuma-egress` (et non
`kuma-allow-traefik-lb-egress`, nom résiduel dans deux commentaires et dans le
README — corrigé). Elle ne couvre que `public_address/32`, **sans** restriction de
port, et pas `private_address`.

### ✅ #6 — Plages Cloudflare figées au déploiement — **atténué**

`traefik.yml` récupère les plages par `uri:` puis les inline dans le middleware
`cloudflare-ips` et dans `forwardedHeaders.trustedIPs` — quatre emplacements, tous
dans le bloc `values:` du chart. Il n'y avait ni `retries`, ni `failed_when`, ni
fallback : un corps vide ou tronqué produisait un `sourceRange` vide, donc un 403
pour tous les visiteurs, sans erreur au déploiement.

Correctif : `retries: 3` sur les deux `uri:` et un `assert` que les deux listes
parsées sont non vides — la panne devient bruyante au déploiement.

La dérive de fond demeure : les plages restent figées jusqu'au prochain
`deploy.yml`. Cloudflare en ajoute rarement, et un CronJob de rafraîchissement ne
pourrait de toute façon pas patcher les `forwardedHeaders.trustedIPs`, qui sont
scellés dans la release Helm. Redéployer périodiquement reste la réponse.

### ✅ #7 — Dérives de documentation — **corrigées**

- README : Tailscale listé en `hostNetwork: true` → faux (§3). « Filebeat » n'existe
  pas non plus dans le dépôt (c'est Loki/Promtail).
- README : `100.64.0.0/10` présenté comme présent dans `whitelist-local` → c'est
  désormais vrai (#2), les trois occurrences sont restées telles quelles.
- README : whitelist CrowdSec custom `s02-enrich/custom-whitelists.yaml` avec la
  CGNAT Tailscale → **ce fichier n'existe pas dans le dépôt**, seule la whitelist
  RFC1918 de `crowdsecurity/linux` s'applique. Idem pour l'acquisition
  `/var/log/auth.log` et pour `crowdsecurity/sshd` dans les collections.
- README : `kuma-allow-traefik-lb-egress` → la policy n'existe pas (#5).
- `secrets-example.yml` proposait `tailscale.hostname: homelab-vps-operator` alors
  que le code a pour défaut `vps-subnet-router` : l'exemple est aligné sur le code,
  et le README renvoie maintenant à « la machine nommée par `tailscale.hostname` »
  plutôt qu'à une valeur en dur. **Le vault n'a pas été touché** — si le vôtre dit
  `homelab-vps-operator`, c'est ce nom qui s'affiche dans la console.
- `traefik_backend_namespaces` reste une liste manuelle : `media` y manquait et a
  été ajouté. Un oubli est désormais une vraie coupure, plus une erreur silencieuse.

---

## 6. Ce qui reste ouvert

- **`traefik_backend_namespaces`** : liste manuelle, sans garde-fou. Un service
  ajouté dans un nouveau namespace prend un 502 tant que la ligne n'est pas là.
- **n8n** : durci sur la seule cible `n8n-webhook-proxy`. Si un workflow compose un
  service in-cluster en direct, il lui faudra son propre `egress-to-namespace`.
- **Nettoyage des `L2Advertisement`** (`metalb.yml`) : toujours sans garde-fou,
  supprime tout ce qui n'est pas dans l'allowlist à chaque `deploy.yml`.
- **Mono-nœud** : un seul speaker MetalLB, pas de failover L2 ; les deux VIP
  tombent avec le nœud.

# CrowdSec : comment il est installé ici

Détection d'intrusion sur les logs Traefik + bannissement actif à deux étages
(plugin Traefik en L7, nftables en L3/L4). Sources :
`roles/kube-services-setup/tasks/crowdsec.yml`,
`roles/apps-nodes-settings/tasks/crowdsec-requirements.yml`,
`roles/kube-services-setup/tasks/traefik.yml`.

---

## 1. Le principe en une phrase

L'**agent** lit les logs des pods Traefik, envoie les alertes au **LAPI**, qui
distribue les décisions de ban à deux **bouncers** : le plugin Traefik (bloque
en HTTP, voit la vraie IP client derrière Cloudflare) et le bouncer firewall
(DaemonSet nftables, bloque tout le reste du trafic TCP/UDP de l'hôte).

```
logs Traefik ─► agent ─► LAPI ─┬─► plugin Traefik   (middleware public-security)
                               └─► firewall bouncer (nftables, hostNetwork)
```

---

## 2. Prérequis

`roles/apps-nodes-settings/tasks/crowdsec-requirements.yml` (joué par
`provision.yml`) monte les limites inotify de l'hôte, sinon l'agent meurt en
« too many open files » :

| sysctl | valeur |
|---|---|
| `fs.inotify.max_user_watches` | `524288` |
| `fs.inotify.max_user_instances` | `512` |

Secrets à renseigner dans `secrets.yml` (voir `secrets-example.yml`) :

```yaml
crowdsec:
  traefik_bouncer_key: "<clé>"    # consommée par le plugin Traefik
  firewall_bouncer_key: "<clé>"   # consommée par le DaemonSet nftables
  enroll_key: "<clé console>"     # rattache l'instance à app.crowdsec.net
```

Les deux clés bouncer sont **choisies par toi** (n'importe quelle chaîne
aléatoire) : elles sont injectées dans le LAPI via `BOUNCER_KEY_traefik` /
`BOUNCER_KEY_firewall`, qui crée les bouncers au démarrage. Les agents, eux,
s'auto-enregistrent (`auto_registration` limité aux plages RFC1918).

---

## 3. Ce que déploie `crowdsec.yml`

Chart Helm officiel (`crowdsec/crowdsec`, image `v1.7.3`) dans le namespace
`crowdsec` :

- **LAPI** (StatefulSet) — base SQLite sur `nfs-runtime`, ServiceMonitor
  Prometheus, dashboard désactivé, enrôlé sur la console CrowdSec sous le nom
  `microk8s_homelab`.
- **Agent** (DaemonSet) — `container_runtime: containerd`, acquisition sur les
  pods `traefik-*` du namespace `traefik`, avec les logs de l'hôte
  (`/var/snap/microk8s/common/var/log`) montés en lecture seule.
- **Bouncer firewall** (DaemonSet maison, `hostNetwork: true`) — image
  `ghcr.io/shgew/cs-firewall-bouncer-docker`, backend **nftables** (tables
  `crowdsec` / `crowdsec6`, hooks `input` + `forward`), `deny_action: DROP`,
  rafraîchissement toutes les 10 s.
- **NetworkPolicies** — default-deny + DNS + intra-namespace + kube-apiserver,
  Traefik → LAPI:8080, agent → LAPI:8080, scrape Prometheus:6060, et sortie
  Internet (LAN bloqué) pour les pulls de threat-intel. Elles ne s'appliquent
  **pas** au bouncer firewall, qui est en host-network.

Collections activées (`COLLECTIONS`) : `crowdsecurity/traefik`,
`crowdsecurity/linux`, `crowdsecurity/http-cve`,
`crowdsecurity/base-http-scenarios`.

---

## 4. Le bouncer Traefik

Configuré dans `traefik.yml`, pas ici : plugin expérimental
`maxlerebourg/crowdsec-bouncer-traefik-plugin`, middleware `crowdsec-bouncer`
en mode `stream` (cache local rafraîchi toutes les 300 s, pas d'appel LAPI par
requête). Il est chaîné après `cloudflare-ips` dans le middleware
`public-security` que référencent toutes les IngressRoutes publiques.

`forwardedHeadersTrustedIPs` = plages Cloudflare, sinon le plugin bannirait
les IP edge de Cloudflare au lieu du vrai client. C'est la raison d'être de ce
bouncer : le bouncer nftables, lui, ne voit que l'IP edge sur le trafic HTTP.

---

## 5. Deux correctifs à connaître

**Init container non idempotent.** Le chart lance `cscli lapi register` à chaque
démarrage de l'agent ; au redémarrage du sandbox (reboot, OOM, disk-pressure) le
LAPI répond « user already exist » et l'agent part en `Init:CrashLoopBackOff`.
La tâche patche la commande de l'init container pour rejouer les credentials
depuis `/tmp_config` s'ils existent déjà.

**Sauvegarde Velero.** Le StatefulSet LAPI est annoté pour sauvegarder le volume
`data` avec un hook pre-backup en cascade : `sqlite3 .backup` → `apk add sqlite`
puis `.backup` → `cp`. Un hook de restore (`restore-db-swap`) remet le snapshot
en place avant le démarrage de CrowdSec. `cscli config backup` ayant disparu en
1.7.x, il n'y a pas d'outil officiel.

---

## 6. Commandes utiles

```bash
LAPI="kubectl -n crowdsec exec sts/crowdsec-lapi --"

$LAPI cscli metrics
$LAPI cscli decisions list
$LAPI cscli alerts list
$LAPI cscli bouncers list          # doit lister traefik + firewall
kubectl -n crowdsec exec ds/crowdsec-agent -- cscli metrics
```

Tester un ban de bout en bout :

```bash
IP=$(curl -s https://api.ipify.org)
$LAPI cscli decisions add --ip $IP -t ban   # ban
$LAPI cscli decisions delete --ip $IP       # unban
```

Sur l'hôte, vérifier que le bouncer firewall pousse bien les IP :

```bash
sudo nft list table ip crowdsec | head -20
```

---

## 7. Limites connues

- Seule acquisition configurée : les pods Traefik. Pas de `/var/log/auth.log`,
  donc pas de détection SSH ; `templates/acquis.yaml.j2` n'est pas utilisé.
- Whitelist : uniquement la RFC1918 fournie par `crowdsecurity/linux`. La plage
  Tailscale `100.64.0.0/10` **n'est pas** whitelistée — ajouter un parser
  `s02-enrich` si besoin.
- Minecraft (25565) passe par un `IngressRouteTCP`, qui ne supporte pas les
  middlewares HTTP : seul le bouncer nftables le couvre.

Voir aussi [`public-private-exposure.md`](public-private-exposure.md) §8 pour la
place des deux bouncers dans la chaîne d'exposition.

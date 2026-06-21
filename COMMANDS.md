# Fast Commands

Quick reference for running this cluster's playbooks.

## SSH into a node

```bash
ssh ansible@192.168.1.201 -p 30000
```

## Run playbooks (interactive vault password)

```bash
export ANSIBLE_HOST_KEY_CHECKING=False
ansible-playbook provision.yml -i hosts --key-file ~/.ssh/id_rsa --ask-vault-pass
ansible-playbook deploy.yml    -i hosts --key-file ~/.ssh/id_rsa --ask-vault-pass
```

## Run playbooks (vault password from file)

```bash
export ANSIBLE_HOST_KEY_CHECKING=False
ansible-playbook provision.yml -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
ansible-playbook deploy.yml    -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
```

## Edit the vault

```bash
EDITOR="code --wait" ansible-vault edit secrets.yml --vault-password-file vault_password_file.txt
```

## Retrieve app passwords

```bash
ansible-playbook retrieve-passwords.yml -i hosts --key-file ~/.ssh/id_rsa
```

## Restore from a Velero backup (disaster recovery)

On-demand restore: re-injects backed-up data onto the NFS server. `recover` mode
restores into `<ns>-recover` namespaces (safe); `inplace` overwrites the originals.

```bash
# List the available backups
ansible-playbook restore.yml -i hosts --key-file ~/.ssh/id_rsa -e list=true

# Restore one namespace into kuma-recover (safe)
ansible-playbook restore.yml -i hosts --key-file ~/.ssh/id_rsa -e backup=latest -e namespaces=kuma -e mode=recover

# Full in-place disaster recovery from a chosen backup
ansible-playbook restore.yml -i hosts --key-file ~/.ssh/id_rsa -e backup=nightly-full-20260615030000 -e namespaces=all -e mode=inplace -e confirm=true
```

## One-liners (for AI debug)

Single-line variants combining the env var with the playbook run:

```bash
export ANSIBLE_HOST_KEY_CHECKING=False && ansible-playbook provision.yml -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
export ANSIBLE_HOST_KEY_CHECKING=False && ansible-playbook deploy.yml -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
```

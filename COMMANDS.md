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

## One-liners (for AI debug)

Single-line variants combining the env var with the playbook run:

```bash
export ANSIBLE_HOST_KEY_CHECKING=False && ansible-playbook provision.yml -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
export ANSIBLE_HOST_KEY_CHECKING=False && ansible-playbook deploy.yml -i hosts --key-file ~/.ssh/id_rsa --vault-password-file vault_password_file.txt
```

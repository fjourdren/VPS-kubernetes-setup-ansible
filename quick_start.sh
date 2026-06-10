export ANSIBLE_HOST_KEY_CHECKING=False
ansible-galaxy install -r requirements.yml

ansible-playbook provision.yml -i hosts --key-file ~/.ssh/id_rsa --ask-vault-pass
ansible-playbook deploy.yml -i hosts --key-file ~/.ssh/id_rsa --ask-vault-pass
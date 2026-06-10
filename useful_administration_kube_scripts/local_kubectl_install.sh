sudo apt update
sudo apt install -y curl

# Download the latest stable `kubectl` binary
curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"

# Make it executable
chmod +x kubectl

# Move it to a directory in your PATH
sudo mv kubectl /usr/local/bin/

# Verify installation
kubectl version --client

# Test kubectl and kubeconfig
KUBECONFIG=./kubeconfig kubectl get pods -A --insecure-skip-tls-verify
# n8n Webhook Proxy

Secure multi-target webhook proxy for n8n with API key authentication and rate limiting.

## Description

This proxy centralizes and secures n8n webhooks by providing:
- **Multi-target routing**: Single entry point to multiple backend services
- **Authentication**: Protection via API key (header `x-api-key`)
- **Rate limiting**: Request throttling to prevent abuse
- **Health check**: Health endpoint for Kubernetes monitoring

## Architecture

```
Client → POST /webhook/<key> → Proxy → n8n backend service
```

The proxy receives webhooks at `/webhook/<key>` and forwards them to the corresponding URL configured in `TARGETS`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3000` | Proxy listening port |
| `TARGETS` | **Yes** | - | JSON configuration of targets (see below) |
| `API_KEY` | No | - | API key for authentication (optional but recommended) |
| `RATE_LIMIT_WINDOW` | No | `60000` | Time window in ms for rate limiting |
| `RATE_LIMIT_MAX` | No | `60` | Maximum requests per window |

### TARGETS Format

JSON environment variable containing an array of objects:

```json
[
  { "key": "crm", "url": "http://n8n-svc/webhook/crm" },
  { "key": "erp", "url": "http://n8n-svc/webhook/erp" },
  { "key": "marketing", "url": "http://n8n-svc/webhook/marketing" }
]
```

## Usage

### Build Docker Image

```bash
docker build -t n8n-proxy:latest .
```

### Local Execution

```bash
npm install
export TARGETS='[{"key":"test","url":"http://localhost:5678/webhook/test"}]'
export API_KEY="your-secret-key"
node index.js
```

### Kubernetes Deployment

Example ConfigMap and Secret:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: n8n-proxy-config
data:
  TARGETS: |
    [
      {"key": "crm", "url": "http://n8n-svc:5678/webhook/crm"},
      {"key": "erp", "url": "http://n8n-svc:5678/webhook/erp"}
    ]
  RATE_LIMIT_WINDOW: "60000"
  RATE_LIMIT_MAX: "100"
---
apiVersion: v1
kind: Secret
metadata:
  name: n8n-proxy-secret
type: Opaque
stringData:
  API_KEY: "your-secret-api-key"
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: n8n-proxy
spec:
  replicas: 2
  selector:
    matchLabels:
      app: n8n-proxy
  template:
    metadata:
      labels:
        app: n8n-proxy
    spec:
      containers:
      - name: proxy
        image: n8n-proxy:latest
        ports:
        - containerPort: 3000
        envFrom:
        - configMapRef:
            name: n8n-proxy-config
        - secretRef:
            name: n8n-proxy-secret
        livenessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 3
          periodSeconds: 5
```

## Endpoints

### POST /webhook/:key

Main endpoint to receive webhooks.

**Parameters:**
- `:key` - Key matching an entry in `TARGETS`

**Headers (if API_KEY is configured):**
- `x-api-key` - API key for authentication

**Body:** JSON (2 MB limit)

**Responses:**
- `200-299`: Success, returns backend service response
- `401`: Invalid or missing API key
- `404`: Unknown target key
- `429`: Too many requests (rate limit exceeded)
- `502`: Error forwarding to backend

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"event": "test", "data": {"foo": "bar"}}' \
  http://localhost:3000/webhook/crm
```

### GET /healthz

Health check endpoint for Kubernetes.

**Response:** `200 OK`

## Security

1. **Authentication**: Always configure `API_KEY` in production
2. **Rate limiting**: Adjust `RATE_LIMIT_WINDOW` and `RATE_LIMIT_MAX` according to your needs
3. **Network**: Deploy in a private Kubernetes network, expose only via Ingress/Service
4. **Secrets**: Use Kubernetes Secrets to store `API_KEY`

## Monitoring

- The proxy displays a table of targets at startup
- Proxy errors are logged to the console
- Use the `/healthz` endpoint for monitoring
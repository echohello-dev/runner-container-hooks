# Runner Container Hooks

Enhanced GitHub Actions runner container hooks for Kubernetes and Docker environments. This fork improves error reporting and diagnostics for pod lifecycles to help troubleshoot issues at runtime.

## Why This Fork?

This fork extends the original [actions/runner-container-hooks](https://github.com/actions/runner-container-hooks) with **enhanced error reporting and diagnostics** for pod lifecycles in Kubernetes environments. When pod scheduling or execution fails, you get actionable error messages instead of cryptic Kubernetes API errors.

### Before vs After: Error Diagnostics

**Before (Original Hook):**
```
Error: Pod failed to come online with error: pods "runner-xyz" was not ready
```

**After (Enhanced Diagnostics):**
```
Error: Pod scheduling failed due to CPU resource constraints: pods "runner-xyz" was not ready

== Pod Events ==
[2026-04-11T10:15:30.000Z] Warning FailedScheduling: 0/3 nodes available: 2 Insufficient cpu, 1 node(s) had taint {node-role: infra}, that the pod didn't tolerate.

Container Statuses:
- runner-xyz: Not Ready
  Waiting: CircuitBreaking, node(s) had insufficient resources

CPU resource constraint detected. The job requires more CPU than available on the node.
Consider reducing CPU requests in your workflow or using a node with more resources.
```

**Key Improvements:**
- Detailed pod failure diagnostics with container logs, events, and status conditions
- Resource constraint detection (CPU/memory) with actionable error messages
- Node selector and affinity issue reporting
- Immediate pod status checking after creation for early failure detection
- Comprehensive logging of pod manifests and container resources
- Redacted sensitive values in environment variables from logs

## Features

- **Kubernetes Hook**: Dynamically spin up Kubernetes pods to run jobs, with enhanced error diagnostics
- **Docker Hook**: Extend the GitHub Actions runner's Docker capabilities
- **Hooklib**: Shared TypeScript utilities and interfaces

## Container Image

Pre-built images available on GitHub Container Registry:

```
ghcr.io/echohello-dev/runner-container-hooks:latest
```

Multi-platform: `linux/amd64`, `linux/arm64`

## Using with Actions Runner Controller (ARC)

### Option 1: Use Pre-built Image

Reference the pre-built image in your ARC RunnerSet:

```yaml
apiVersion://actions.summerwind.net/v1alpha1
kind: RunnerSet
metadata:
  name: actions-runner-set
  namespace: actions-runner
spec:
  replicas: 2
  runnerManagementURL: https://github.com/YOUR_ORG
  githubToken:
    secretName: github-token
  image: ghcr.io/echohello-dev/runner-container-hooks:latest
  imagePullPolicy: Always
  env:
    - name: ACTIONS_RUNNER_CONTAINER_HOOKS
      value: /home/runner/k8s/index.js
    - name: ACTIONS_RUNNER_POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
      value: "true"
```

### Option 2: Rebuild from Source with Customizations

If you need to customize the hooks or add your own tooling:

```dockerfile
# Dockerfile.runner
FROM ghcr.io/echohello-dev/runner-container-hooks:latest

# Add your customizations here
RUN apt-get update && apt-get install -y \
    kubectl \
    helm \
    && rm -rf /var/lib/apt/lists/*

# Override the hooks directory if needed
COPY custom-hooks/ /home/runner/k8s/
```

Build and push:

```bash
# Login to GHCR
echo $GITHUB_TOKEN | docker login ghcr.io -u $GITHUB_ACTOR --password-stdin

# Build and push
docker build -t ghcr.io/YOUR_ORG/runner-container-hooks:custom .
docker push ghcr.io/YOUR_ORG/runner-container-hooks:custom
```

### Option 3: Add Hooks to Existing Runner Deployment

If you already have ARC runners deployed and want to add these enhanced hooks:

```yaml
# patch-runners.yaml - apply with kubectl
apiVersion: actions.summerwind.net/v1alpha1
kind: RunnerDeployment
metadata:
  name: actions-runner
  namespace: actions-runner
spec:
  template:
    spec:
      containers:
        - name: runner
          env:
            - name: ACTIONS_RUNNER_CONTAINER_HOOKS
              value: /home/runner/k8s/index.js
          volumeMounts:
            - name: runner-hooks
              mountPath: /home/runner/k8s
      volumes:
        - name: runner-hooks
          emptyDir: {}
      initContainers:
        - name: install-hooks
          image: ghcr.io/echohello-dev/runner-container-hooks:latest
          command: ['sh', '-c', 'cp -r /opt/hooks/* /hooks/']
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
```

## Packages

| Package | Description |
|---------|-------------|
| `packages/k8s` | Kubernetes hook implementation for ARC |
| `packages/docker` | Docker-based container hooks |
| `packages/hooklib` | Shared TypeScript utilities and interfaces |

## Project Structure

```
runner-container-hooks/
├── packages/
│   ├── k8s/              # Kubernetes hook implementation
│   │   ├── src/
│   │   │   ├── hooks/    # Hook implementations
│   │   │   └── k8s/       # Kubernetes utilities
│   │   ├── tests/        # Unit and integration tests
│   │   └── entrypoint.js # Entry point for ARC
│   ├── docker/           # Docker hook implementation
│   └── hooklib/           # Shared library
├── examples/             # Example configurations
├── .github/workflows/     # CI/CD workflows
└── mise.toml             # Task definitions
```

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for local development and testing)
- Kind (for Kubernetes testing)
- mise (for task running)

### Installation

```bash
mise run install
```

### Building

```bash
mise run build
```

### Testing

```bash
mise run test
```

Note: Tests require a Kind cluster and Docker to be running.

## Development

### Available Tasks

```bash
mise run install      # Install dependencies
mise run build        # Build all packages
mise run test         # Run tests (requires Kind + Docker)
mise run lint         # Run linting
mise run format       # Format code
mise run create:kind  # Create Kind test cluster
mise run delete:kind  # Delete Kind test cluster
```

## License

MIT
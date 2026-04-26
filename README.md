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

## Container Image

Pre-built images available on GitHub Container Registry:

```
ghcr.io/echohello-dev/runner-container-hooks:latest
```

Multi-platform: `linux/amd64`, `linux/arm64`

## Installation Methods

### Option 1: Init Container (Recommended for production)

The cleanest approach - uses an init container to copy hooks from the published image to a volume mount. No need to modify your runner image.

```yaml
apiVersion: actions.github.com/v1alpha1
kind: AutoscalingRunnerSet
metadata:
  name: actions-runner-set
  namespace: actions-runner
spec:
  runnerScaleSetName: actions-runner-set
  maxRunners: 10
  minRunners: 0
  template:
    spec:
      initContainers:
        - name: install-hooks
          image: ghcr.io/echohello-dev/runner-container-hooks:latest
          command: ['sh', '-c', 'cp -r /home/runner/k8s/* /hooks/']
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
      containers:
        - name: runner
          image: ghcr.io/actions/actions-runner:latest
          command: ['/home/runner/run.sh']
          env:
            - name: ACTIONS_RUNNER_CONTAINER_HOOKS
              value: /hooks/index.js
            - name: ACTIONS_RUNNER_POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
              value: "true"
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
            - name: work
              mountPath: /home/runner/_work
      volumes:
        - name: runner-hooks
          emptyDir: {}
        - name: work
          ephemeral:
            volumeClaimTemplate:
              spec:
                accessModes: ["ReadWriteOnce"]
                resources:
                  requests:
                    storage: 10Gi
```

### Option 2: Volume Mount from ConfigMap

For development or when you want to quickly test changes without rebuilding images:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: runner-container-hooks
  namespace: actions-runner
data:
  index.js: |
    module.exports = require('./lib/src/index.js')
  lib.src.index.js: |
    // hook content here
  lib.src.hooks.prepare-job.js: |
    // hook content here
---
apiVersion: actions.github.com/v1alpha1
kind: AutoscalingRunnerSet
# ... rest of config with volumes referencing ConfigMap
```

### Option 3: COPY from Image in Dockerfile

If you prefer to bake the hooks into your runner image:

```dockerfile
# Dockerfile
FROM ghcr.io/actions/actions-runner:latest

# Copy k8s container hooks
COPY --from=ghcr.io/echohello-dev/runner-container-hooks:latest /home/runner/k8s /home/runner/k8s

# Or copy docker hooks
COPY --from=ghcr.io/echohello-dev/runner-container-hooks:latest /home/runner/docker /home/runner/docker

ENV ACTIONS_RUNNER_CONTAINER_HOOKS=/home/runner/k8s/index.js
```

### Option 4: Direct curl/wget download at startup

For testing or temporary configurations:

```yaml
initContainers:
  - name: download-hooks
    image: curlimages/curl:latest
    command: ['sh', '-c', 'curl -sfL https://github.com/echohello-dev/runner-container-hooks/releases/latest/download/k8s-index.js -o /hooks/index.js && chmod +x /hooks/index.js']
    volumeMounts:
      - name: runner-hooks
        mountPath: /hooks
```

## Using with Actions Runner Controller (ARC)

### Modern API: AutoscalingRunnerSet (actions.github.com/v1alpha1)

The modern GitHub-managed scaling API:

```yaml
apiVersion: actions.github.com/v1alpha1
kind: AutoscalingRunnerSet
metadata:
  name: actions-runner-set
  namespace: actions-runner
spec:
  runnerScaleSetName: actions-runner-set
  maxRunners: 10
  minRunners: 0
  template:
    spec:
      initContainers:
        - name: install-hooks
          image: ghcr.io/echohello-dev/runner-container-hooks:latest
          command: ['sh', '-c', 'cp -r /home/runner/k8s/* /hooks/']
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
      containers:
        - name: runner
          image: ghcr.io/actions/actions-runner:latest
          command: ['/home/runner/run.sh']
          env:
            - name: ACTIONS_RUNNER_CONTAINER_HOOKS
              value: /hooks/index.js
            - name: ACTIONS_RUNNER_POD_NAME
              valueFrom:
                fieldRef:
                  fieldPath: metadata.name
            - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
              value: "true"
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
            - name: work
              mountPath: /home/runner/_work
      volumes:
        - name: runner-hooks
          emptyDir: {}
        - name: work
          ephemeral:
            volumeClaimTemplate:
              spec:
                accessModes: ["ReadWriteOnce"]
                resources:
                  requests:
                    storage: 10Gi
```

### Legacy API: RunnerSet (actions.summerwind.dev/v1alpha1)

For organizations still using the community-maintained ARC:

```yaml
apiVersion: actions.summerwind.dev/v1alpha1
kind: RunnerSet
metadata:
  name: actions-runner-set
  namespace: actions-runner
spec:
  replicas: 2
  runnerManagementURL: https://github.com/YOUR_ORG
  githubToken:
    secretName: github-token
  template:
    spec:
      repository: YOUR_REPO
      containerMode:
        type: dind
      containerHooks:
        path: /hooks/index.js
      image: ghcr.io/actions/actions-runner:latest
      imagePullPolicy: Always
      initContainers:
        - name: install-hooks
          image: ghcr.io/echohello-dev/runner-container-hooks:latest
          command: ['sh', '-c', 'cp -r /home/runner/k8s/* /hooks/']
          volumeMounts:
            - name: runner-hooks
              mountPath: /hooks
      env:
        - name: ACTIONS_RUNNER_POD_NAME
          valueFrom:
            fieldRef:
              fieldPath: metadata.name
        - name: ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER
          value: "true"
      volumeMounts:
        - name: runner-hooks
          mountPath: /hooks
      volumes:
        - name: runner-hooks
          emptyDir: {}
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
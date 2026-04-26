# Runner Container Hooks

Enhanced GitHub Actions runner container hooks for Kubernetes and Docker environments. This fork improves error reporting and diagnostics for pod lifecycles to help troubleshoot issues at runtime.

## Features

- **Kubernetes Hook**: Dynamically spin up Kubernetes pods to run jobs, optimizing resource utilization and job execution efficiency.
- **Docker Hook**: Extend the GitHub Actions runner's Docker capabilities, enabling more complex and customizable containerized environments for CI/CD pipelines.
- **Hooklib**: A TypeScript-based shared library offering essential definitions and utilities, supporting the Kubernetes and Docker hooks.

## Why This Fork?

This fork focuses on improving error reporting and diagnostics for pod lifecycles. Key enhancements include:

- Detailed pod failure diagnostics with container logs, events, and status conditions
- Resource constraint detection (CPU/memory) with actionable error messages
- Node selector and affinity issue reporting
- Immediate pod status checking after creation for early failure detection
- Comprehensive logging of pod manifests and container resources

## Packages

| Package | Description |
|---------|-------------|
| `packages/k8s` | Kubernetes hook implementation for ARC (Actions Runner Controller) |
| `packages/docker` | Docker-based container hooks |
| `packages/hooklib` | Shared TypeScript utilities and interfaces |

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

## Project Structure

```
runner-container-hooks/
├── packages/
│   ├── k8s/              # Kubernetes hook implementation
│   │   ├── src/
│   │   │   ├── hooks/    # Hook implementations (prepare-job, cleanup-job, etc.)
│   │   │   └── k8s/       # Kubernetes utilities
│   │   ├── tests/        # Unit and integration tests
│   │   └── entrypoint.js # Entry point for ARC
│   ├── docker/           # Docker hook implementation
│   │   ├── src/
│   │   │   ├── hooks/    # Hook implementations
│   │   │   └── dockerCommands/ # Docker CLI wrappers
│   │   └── tests/
│   └── hooklib/           # Shared library
│       └── src/          # Interfaces and utilities
├── examples/             # Example configurations
├── .github/
│   └── workflows/        # CI/CD workflows
└── mise.toml             # Task definitions
```

## Kubernetes Hook Usage

The Kubernetes hook is designed for use with [Actions Runner Controller (ARC)](https://github.com/actions-runner-controller/actions-runner-controller).

### Container Hook Environment Variables

| Variable | Description |
|----------|-------------|
| `ACTIONS_RUNNER_POD_NAME` | Name of the runner pod |
| `ACTIONS_RUNNER_REQUIRE_JOB_CONTAINER` | Must be `true` to require job containers |
| `ACTIONS_RUNNER_CLAIM_NAME` | PVC claim name for runner working directory |

### Setting Container Hooks

```yaml
# In your ARC RunnerSet or RunnerDeployment
template:
  spec:
    env:
      - name: ACTIONS_RUNNER_CONTAINER_HOOKS
        value: /home/runner/k8s/index.js
```

## Development

### Available Tasks

```bash
mise run install      # Install dependencies
mise run build        # Build all packages
mise run test         # Run tests (requires Kind + Docker)
mise run lint         # Run linting
mise run create:kind  # Create Kind test cluster
mise run delete:kind  # Delete Kind test cluster
```

## License

MIT
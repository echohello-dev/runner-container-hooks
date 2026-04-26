# runner-container-hooks

## Project Overview

Forked from `actions/runner-container-hooks` to enhance error reporting and diagnostics for pod lifecycles in Kubernetes environments.

## Tech Stack

- TypeScript for all packages
- Node.js 20
- mise for task management
- Jest for testing
- Kind for Kubernetes testing

## Key Commands

```bash
mise run install   # Install dependencies
mise run build     # Build all packages
mise run test      # Run tests
mise run lint      # Lint code
```

## Architecture

- `packages/hooklib` - Shared interfaces and utilities
- `packages/k8s` - Kubernetes hook for ARC
- `packages/docker` - Docker container hooks

## Notes

- The k8s package includes enhanced diagnostics for troubleshooting pod failures
- Docker hook uses dind (Docker-in-Docker) for container operations
- Tests require Kind cluster for integration testing
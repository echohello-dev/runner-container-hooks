import * as k8s from '@kubernetes/client-node'
import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as core from '@actions/core'
import { Mount } from 'hooklib'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { POD_VOLUME_NAME } from './index'
import { CONTAINER_EXTENSION_PREFIX } from '../hooks/constants'
import * as shlex from 'shlex'

/**
 * The default container entrypoint arguments.
 */
export const DEFAULT_CONTAINER_ENTRY_POINT_ARGS = [`-f`, `/dev/null`]
export const DEFAULT_CONTAINER_ENTRY_POINT = 'tail'

/**
 * The environment variable that contains the path to the container entrypoint.
 */
export const ENV_HOOK_TEMPLATE_PATH = 'ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE'
export const ENV_USE_KUBE_SCHEDULER = 'ACTIONS_RUNNER_USE_KUBE_SCHEDULER'

/**
 * Creates a Docker in Docker container spec.
 *
 * @returns The container spec.
 */
export function generateDinDContainer(): k8s.V1Container {
  const container: k8s.V1Container = {
    name: 'dind',
    image: 'docker:dind',
    args: [
      'dockerd',
      '--host=unix:///run/docker/docker.sock',
      '--group=$(DOCKER_GROUP_GID)'
    ],
    env: [
      {
        name: 'DOCKER_GROUP_GID',
        value: '1001'
      }
    ],
    securityContext: {
      privileged: true
    },
    volumeMounts: [
      {
        name: 'dind-sock',
        mountPath: '/run/docker'
      }
    ],
    resources: {
      limits: {
        cpu: '1400m',
        memory: '768Mi'
      },
      requests: {
        cpu: '200m',
        memory: '256Mi'
      }
    }
  }

  if (process.env.DOCKER_MTU) {
    container.args = container.args || []
    container.args.push(`--mtu=${process.env.DOCKER_MTU}`)
  }

  return container
}

/**
 * Create container volume mounts for the job.
 *
 * @example ```typescript
 * containerVolumes([
 * {
 *   sourceVolumePath: '/home/runner/work/_temp/_github_home',
 *   targetVolumePath: '/github/home',
 *   readOnly: true
 * }
 * ])
 * ```
 * @param userMountVolumes - User defined mount volumes
 * @param jobContainer - Whether to mount default volumes for job container
 * @param containerAction - Whether to mount default volumes for container action
 * @returns The container volume mounts.
 * @throws Error when workspace path is not defined
 * @throws Error when volume mounts are outside of the workspace
 */
export function containerVolumes(
  userMountVolumes: Mount[] = [],
  jobContainer = true,
  containerAction = false
): k8s.V1VolumeMount[] {
  const mounts: k8s.V1VolumeMount[] = [
    {
      name: POD_VOLUME_NAME,
      mountPath: '/__w'
    }
  ]

  const workspacePath = process.env.GITHUB_WORKSPACE as string
  if (containerAction) {
    const i = workspacePath.lastIndexOf('_work/')
    const workspaceRelativePath = workspacePath.slice(i + '_work/'.length)
    mounts.push(
      {
        name: POD_VOLUME_NAME,
        mountPath: '/github/workspace',
        subPath: workspaceRelativePath
      },
      {
        name: POD_VOLUME_NAME,
        mountPath: '/github/file_commands',
        subPath: '_temp/_runner_file_commands'
      }
    )
    return mounts
  }

  if (!jobContainer) {
    return mounts
  }

  mounts.push(
    {
      name: POD_VOLUME_NAME,
      mountPath: '/__e',
      subPath: 'externals'
    },
    {
      name: POD_VOLUME_NAME,
      mountPath: '/github/home',
      subPath: '_temp/_github_home'
    },
    {
      name: POD_VOLUME_NAME,
      mountPath: '/github/workflow',
      subPath: '_temp/_github_workflow'
    },
    {
      name: 'dind-sock',
      mountPath: '/run/docker',
      readOnly: true
    }
  )

  if (!userMountVolumes?.length) {
    return mounts
  }

  for (const userVolume of userMountVolumes) {
    let sourceVolumePath = ''
    if (path.isAbsolute(userVolume.sourceVolumePath)) {
      if (!userVolume.sourceVolumePath.startsWith(workspacePath)) {
        throw new Error(
          'Volume mounts outside of the work folder are not supported'
        )
      }
      // source volume path should be relative path
      sourceVolumePath = userVolume.sourceVolumePath.slice(
        workspacePath.length + 1
      )
    } else {
      sourceVolumePath = userVolume.sourceVolumePath
    }

    mounts.push({
      name: POD_VOLUME_NAME,
      mountPath: userVolume.targetVolumePath,
      subPath: sourceVolumePath,
      readOnly: userVolume.readOnly
    })
  }

  return mounts
}

/**
 * Write the entrypoint script to the runner temp directory.
 *
 * @example writeEntryPointScript('/__w/_temp', 'echo', ['hello world']) -> { containerPath: '/__w/_temp/uuid.sh', runnerPath: '/tmp/uuid.sh' }
 * @param workingDirectory - The working directory.
 * @param entryPoint - The entrypoint.
 * @param entryPointArgs - The entrypoint arguments.
 * @param prependPath - The path to prepend to the PATH environment variable.
 * @param environmentVariables - The environment variables.
 * @returns The container path and runner path.
 * @throws Error when environment variable key contains invalid characters
 */
export function writeEntryPointScript(
  workingDirectory: string,
  entryPoint: string,
  entryPointArgs?: string[],
  prependPath?: string[],
  environmentVariables?: { [key: string]: string }
): { containerPath: string; runnerPath: string } {
  let exportPath = ''
  if (prependPath?.length) {
    // TODO: remove compatibility with typeof prependPath === 'string' as we bump to next major version, the hooks will lose PrependPath compat with runners 2.293.0 and older
    const prepend =
      typeof prependPath === 'string' ? prependPath : prependPath.join(':')
    exportPath = `export PATH=${prepend}:$PATH`
  }
  let environmentPrefix = ''

  if (environmentVariables && Object.entries(environmentVariables).length) {
    const envBuffer: string[] = []
    for (const [key, value] of Object.entries(environmentVariables)) {
      if (
        key.includes(`=`) ||
        key.includes(`'`) ||
        key.includes(`"`) ||
        key.includes(`$`)
      ) {
        throw new Error(
          `environment key ${key} is invalid - the key must not contain =, $, ', or "`
        )
      }
      envBuffer.push(
        `"${key}=${value
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\$/g, '\\$')
          .replace(/`/g, '\\`')}"`
      )
    }
    environmentPrefix = `env ${envBuffer.join(' ')} `
  }

  const content = `#!/bin/sh -l
${exportPath}
cd ${workingDirectory} && \
exec ${environmentPrefix} ${entryPoint} ${
    entryPointArgs?.length ? entryPointArgs.join(' ') : ''
  }
`
  const filename = `${randomUUID()}.sh`
  const entryPointPath = `${process.env.RUNNER_TEMP}/${filename}`
  fs.writeFileSync(entryPointPath, content)
  return {
    containerPath: `/__w/_temp/${filename}`,
    runnerPath: entryPointPath
  }
}

/**
 * Generate a container name from an image.
 *
 * @example generateContainerName('ubuntu:latest') -> 'ubuntu'
 * @param image - The image.
 * @returns The container name.
 * @throws Error when image definition is invalid
 */
export function generateContainerName(image: string): string {
  const nameWithTag = image.split('/').pop()
  const name = nameWithTag?.split(':').at(0)

  if (!name) {
    throw new Error(`Image definition '${image}' is invalid`)
  }

  return name
}

/**
 * Merge container options with the base container.
 *
 * Keep in mind, envs and volumes could be passed as fields in container definition
 * so default volume mounts and envs are appended first, and then create options are used
 * to append more values
 *
 * Rest of the fields are just applied
 * For example, container.createOptions.container.image is going to overwrite container.image field
 *
 * @param base - The base container.
 * @param from - The container options.
 * @returns The merged container.
 * @throws Error when base container name is not defined
 */
export function mergeContainerWithOptions(
  base: k8s.V1Container,
  from: k8s.V1Container
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'name') {
      if (value !== CONTAINER_EXTENSION_PREFIX + base.name) {
        core.warning("Skipping name override: name can't be overwritten")
      }
      continue
    } else if (key === 'image') {
      core.warning("Skipping image override: image can't be overwritten")
      continue
    } else if (key === 'env') {
      const envs = value as k8s.V1EnvVar[]
      base.env = mergeLists(base.env, envs)
    } else if (key === 'volumeMounts' && value) {
      const volumeMounts = value as k8s.V1VolumeMount[]
      base.volumeMounts = mergeLists(base.volumeMounts, volumeMounts)
    } else if (key === 'ports' && value) {
      const ports = value as k8s.V1ContainerPort[]
      base.ports = mergeLists(base.ports, ports)
    } else {
      base[key] = value
    }
  }
}

/**
 * Merge pod spec options with the base pod spec.
 *
 * @example mergePodSpecWithOptions({ containers: [{ name: 'a' }] }, { containers: [{ name: 'b' }] }) -> { containers: [{ name: 'a' }, { name: 'b' }] }
 * @param base - The base pod spec.
 * @param from - The pod spec options.
 * @returns The merged pod spec.
 * @throws Error when base pod spec is not defined
 */
export function mergePodSpecWithOptions(
  base: k8s.V1PodSpec,
  from: k8s.V1PodSpec
): void {
  for (const [key, value] of Object.entries(from)) {
    if (key === 'containers') {
      base.containers.push(
        ...from.containers.filter(
          e => !e.name?.startsWith(CONTAINER_EXTENSION_PREFIX)
        )
      )
    } else if (key === 'volumes' && value) {
      const volumes = value as k8s.V1Volume[]
      base.volumes = mergeLists(base.volumes, volumes)
    } else {
      base[key] = value
    }
  }
}

/**
 * Merge object metadata with the base object metadata.
 *
 * @example mergeObjectMeta({ metadata: { labels: { a: 'b' } } }, { metadata: { labels: { c: 'd' } } }) -> { metadata: { labels: { a: 'b', c: 'd' } } }
 * @param base - The base object metadata.
 * @param from - The object metadata.
 * @returns The merged object metadata.
 * @throws Error when base object metadata is not defined
 */
export function mergeObjectMeta(
  base: { metadata?: k8s.V1ObjectMeta },
  from: k8s.V1ObjectMeta
): void {
  if (!base.metadata?.labels || !base.metadata?.annotations) {
    throw new Error(
      "Can't merge metadata: base.metadata or base.annotations field is undefined"
    )
  }
  if (from?.labels) {
    for (const [key, value] of Object.entries(from.labels)) {
      if (base.metadata?.labels?.[key]) {
        core.warning(`Label ${key} is already defined and will be overwritten`)
      }
      base.metadata.labels[key] = value
    }
  }

  if (from?.annotations) {
    for (const [key, value] of Object.entries(from.annotations)) {
      if (base.metadata?.annotations?.[key]) {
        core.warning(
          `Annotation ${key} is already defined and will be overwritten`
        )
      }
      base.metadata.annotations[key] = value
    }
  }
}

/**
 * Read the extension from a file and parse it as YAML.
 *
 * @returns The parsed extension.
 * @throws Error when file path is not defined
 */
export function readExtensionFromFile(): k8s.V1PodTemplateSpec | undefined {
  const filePath = process.env[ENV_HOOK_TEMPLATE_PATH]
  if (!filePath) {
    return undefined
  }
  const doc = yaml.load(fs.readFileSync(filePath, 'utf8'))
  if (!doc || typeof doc !== 'object') {
    throw new Error(`Failed to parse ${filePath}`)
  }
  return doc as k8s.V1PodTemplateSpec
}

/**
 * Use the Kubernetes scheduler instead of the default scheduler.
 *
 * @returns Whether to use the Kubernetes scheduler.
 * @throws Error when environment variable is not defined
 */
export function useKubeScheduler(): boolean {
  return process.env[ENV_USE_KUBE_SCHEDULER] === 'true'
}

/**
 * The pod phase.
 *
 * @see https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-phase
 */
export enum PodPhase {
  PENDING = 'Pending',
  RUNNING = 'Running',
  SUCCEEDED = 'Succeeded',
  FAILED = 'Failed',
  UNKNOWN = 'Unknown',
  COMPLETED = 'Completed'
}

/**
 * Merge two lists together.
 *
 * @example mergeLists([1, 2, 3], [4, 5, 6]) -> [1, 2, 3, 4, 5, 6]
 * @param base - The base list.
 * @param from - The list to merge.
 * @returns The merged list.
 * @throws Error when base list is not defined
 */
function mergeLists<T>(base?: T[], from?: T[]): T[] {
  const b: T[] = base || []
  if (!from?.length) {
    return b
  }
  b.push(...from)
  return b
}

/**
 * Fix args with shlex.
 *
 * @example fixArgs(['echo', 'hello world']) -> ['echo', 'hello world']
 * @param args - The args to fix.
 * @returns The fixed args.
 */
export function fixArgs(args: string[]): string[] {
  return shlex.split(args.join(' '))
}

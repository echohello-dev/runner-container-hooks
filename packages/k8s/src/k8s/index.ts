import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'
import { ContainerInfo, Registry } from 'hooklib'
import * as stream from 'stream'
import {
  getJobPodName,
  getRunnerPodName,
  getSecretName,
  getStepPodName,
  getVolumeClaimName,
  RunnerInstanceLabel
} from '../hooks/constants'
import {
  PodPhase,
  mergePodSpecWithOptions,
  mergeObjectMeta,
  useKubeScheduler,
  generateDinDContainer,
  fixArgs
} from './utils'

const kc = new k8s.KubeConfig()

kc.loadFromDefault()

// Export the k8sApi variable
export const k8sApi = kc.makeApiClient(k8s.CoreV1Api)
const k8sBatchV1Api = kc.makeApiClient(k8s.BatchV1Api)
const k8sAuthorizationV1Api = kc.makeApiClient(k8s.AuthorizationV1Api)

/**
 * The default time to wait for a pod to come online.
 */
const DEFAULT_WAIT_FOR_POD_TIME_SECONDS = 10 * 60 // 10 min

/**
 * The name of the volume claim.
 */
export const POD_VOLUME_NAME = 'work'

/**
 * The required permissions for the service account.
 */
export const requiredPermissions = [
  {
    group: '',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'pods',
    subresource: ''
  },
  {
    group: '',
    verbs: ['get', 'create'],
    resource: 'pods',
    subresource: 'exec'
  },
  {
    group: '',
    verbs: ['get', 'list', 'watch'],
    resource: 'pods',
    subresource: 'log'
  },
  {
    group: 'batch',
    verbs: ['get', 'list', 'create', 'delete'],
    resource: 'jobs',
    subresource: ''
  },
  {
    group: '',
    verbs: ['create', 'delete', 'get', 'list'],
    resource: 'secrets',
    subresource: ''
  }
]

/**
 * Creates a container spec for a job or service.
 *
 * @param container The container info.
 * @param name The name of the container.
 * @param isJobContainer Whether this is the job container.
 * @param extension The extension to apply to the container.
 * @returns The created container spec.
 */
export async function createPod(
  jobContainer?: k8s.V1Container,
  services?: k8s.V1Container[],
  registry?: Registry,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Pod> {
  const containers: k8s.V1Container[] = []
  if (jobContainer) {
    containers.push(jobContainer)
    containers.push(generateDinDContainer())
  }
  if (services?.length) {
    containers.push(...services)
  }

  const appPod = new k8s.V1Pod()

  appPod.apiVersion = 'v1'
  appPod.kind = 'Pod'

  appPod.metadata = new k8s.V1ObjectMeta()
  appPod.metadata.name = getJobPodName()

  const instanceLabel = new RunnerInstanceLabel()
  appPod.metadata.labels = {
    [instanceLabel.key]: instanceLabel.value
  }
  appPod.metadata.annotations = {}

  appPod.spec = new k8s.V1PodSpec()
  appPod.spec.containers = containers
  appPod.spec.restartPolicy = 'Never'

  if (!useKubeScheduler()) {
    appPod.spec.nodeName = await getCurrentNodeName()
  }

  const claimName = getVolumeClaimName()
  appPod.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    },
    {
      name: 'dind-sock',
      emptyDir: {}
    }
  ]

  // add image pull secret if registry is provided
  if (registry) {
    const secret = await createDockerSecret(registry)
    if (!secret?.metadata?.name) {
      throw new Error(`created secret does not have secret.metadata.name`)
    }
    const secretReference = new k8s.V1LocalObjectReference()
    secretReference.name = secret.metadata.name
    appPod.spec.imagePullSecrets = [secretReference]
  }

  if (extension?.metadata) {
    mergeObjectMeta(appPod, extension.metadata)
  }

  if (extension?.spec) {
    mergePodSpecWithOptions(appPod.spec, extension.spec)
  }

  const { body } = await k8sApi.createNamespacedPod(namespace(), appPod)
  return body
}

/**
 * Creates a job for a GitHub container step.
 *
 * @param container The container info.
 * @param extension The extension to apply to the container.
 * @returns The created job.
 */
export async function createJob(
  container: k8s.V1Container,
  extension?: k8s.V1PodTemplateSpec
): Promise<k8s.V1Job> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const job = new k8s.V1Job()
  job.apiVersion = 'batch/v1'
  job.kind = 'Job'
  job.metadata = new k8s.V1ObjectMeta()
  job.metadata.name = getStepPodName()
  job.metadata.labels = { [runnerInstanceLabel.key]: runnerInstanceLabel.value }
  job.metadata.annotations = {}

  job.spec = new k8s.V1JobSpec()
  job.spec.ttlSecondsAfterFinished = 300
  job.spec.backoffLimit = 0
  job.spec.template = new k8s.V1PodTemplateSpec()

  job.spec.template.spec = new k8s.V1PodSpec()
  job.spec.template.metadata = new k8s.V1ObjectMeta()
  job.spec.template.metadata.labels = {}
  job.spec.template.metadata.annotations = {}
  job.spec.template.spec.containers = [container]
  job.spec.template.spec.restartPolicy = 'Never'

  if (!useKubeScheduler()) {
    job.spec.template.spec.nodeName = await getCurrentNodeName()
  }

  const claimName = getVolumeClaimName()
  job.spec.template.spec.volumes = [
    {
      name: 'work',
      persistentVolumeClaim: { claimName }
    }
  ]

  if (extension) {
    if (extension.metadata) {
      // apply metadata both to the job and the pod created by the job
      mergeObjectMeta(job, extension.metadata)
      mergeObjectMeta(job.spec.template, extension.metadata)
    }
    if (extension.spec) {
      mergePodSpecWithOptions(job.spec.template.spec, extension.spec)
    }
  }

  const { body } = await k8sBatchV1Api.createNamespacedJob(namespace(), job)
  return body
}

/**
 * Get the name of the pod for a job.
 *
 * @param jobName The name of the job.
 * @returns The name of the pod.
 */
export async function getContainerJobPodName(jobName: string): Promise<string> {
  const selector = `job-name=${jobName}`
  const backOffManager = new BackOffManager(60)
  while (true) {
    const podList = await k8sApi.listNamespacedPod(
      namespace(),
      undefined,
      undefined,
      undefined,
      undefined,
      selector,
      1
    )

    if (!podList.body.items?.length) {
      await backOffManager.backOff()
      continue
    }

    if (!podList.body.items[0].metadata?.name) {
      throw new Error(
        `Failed to determine the name of the pod for job ${jobName}`
      )
    }
    return podList.body.items[0].metadata.name
  }
}

/**
 * Delete a pod by name.
 *
 * @param podName The name of the pod.
 * @returns A promise that resolves when the pod is deleted.
 */
export async function deletePod(podName: string): Promise<void> {
  await k8sApi.deleteNamespacedPod(
    podName,
    namespace(),
    undefined,
    undefined,
    0
  )
}

/**
 * Execute a command in a pod mainly used in GitHub container steps.
 *
 * @example ```typescript
 * await execPodStep(
 * ['sh', '-c', 'echo "hello"'],
 * 'my-pod',
 * 'my-container'
 * )
 * ```
 * @param command The command to execute.
 * @param podName The name of the pod.
 * @param containerName The name of the container.
 * @param stdin The stdin stream.
 * @returns A promise that resolves when the command is executed.
 */
export async function execPodStep(
  command: string[],
  podName: string,
  containerName: string,
  stdin?: stream.Readable
): Promise<void> {
  const exec = new k8s.Exec(kc)
  command = fixArgs(command)
  // Exec returns a websocket. If websocket fails, we should reject the promise. Otherwise, websocket will call a callback. Since at that point, websocket is not failing, we can safely resolve or reject the promise.
  await new Promise(function (resolve, reject) {
    exec
      .exec(
        namespace(),
        podName,
        containerName,
        command,
        process.stdout,
        process.stderr,
        stdin ?? null,
        false /* tty */,
        resp => {
          // kube.exec returns an error if exit code is not 0, but we can't actually get the exit code
          if (resp.status === 'Success') {
            resolve(resp.code)
          } else {
            core.debug(
              JSON.stringify({
                message: resp?.message,
                details: resp?.details
              })
            )
            reject(resp?.message)
          }
        }
      )
      // If exec.exec fails, explicitly reject the outer promise
      .catch(e => reject(e))
  })
}

/**
 * Wait for a job to complete.
 *
 * @example ```typescript
 * await waitForJobToComplete('my-job')
 * ```
 * @param jobName The name of the job.
 * @returns A promise that resolves when the job is completed.
 */
export async function waitForJobToComplete(jobName: string): Promise<void> {
  const backOffManager = new BackOffManager()
  while (true) {
    try {
      if (await isJobSucceeded(jobName)) {
        return
      }
    } catch (error) {
      throw new Error(`job ${jobName} has failed`)
    }
    await backOffManager.backOff()
  }
}

/**
 * Wait for a pod to complete.
 *
 * @example ```typescript
 * await waitForPodToComplete('my-pod')
 * ```
 * @param podName The name of the pod.
 * @returns A promise that resolves when the pod is completed.
 */
export async function createDockerSecret(
  registry: Registry
): Promise<k8s.V1Secret> {
  const authContent = {
    auths: {
      [registry.serverUrl || 'https://index.docker.io/v1/']: {
        username: registry.username,
        password: registry.password,
        auth: Buffer.from(`${registry.username}:${registry.password}`).toString(
          'base64'
        )
      }
    }
  }

  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secretName = getSecretName()
  const secret = new k8s.V1Secret()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName
  secret.metadata.namespace = namespace()
  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.type = 'kubernetes.io/dockerconfigjson'
  secret.kind = 'Secret'
  secret.data = {
    '.dockerconfigjson': Buffer.from(JSON.stringify(authContent)).toString(
      'base64'
    )
  }

  const { body } = await k8sApi.createNamespacedSecret(namespace(), secret)
  return body
}

/**
 * Create a secret for environment variables.
 *
 * @example ```typescript
 * const secretName = await createSecretForEnvs({
 *  'MY_ENV': 'my-value'
 * })
 * ```
 * @param envs The environment variables.
 * @returns A promise that resolves when the secret is created.
 */
export async function createSecretForEnvs(envs: {
  [key: string]: string
}): Promise<string> {
  const runnerInstanceLabel = new RunnerInstanceLabel()

  const secret = new k8s.V1Secret()
  const secretName = getSecretName()
  secret.immutable = true
  secret.apiVersion = 'v1'
  secret.metadata = new k8s.V1ObjectMeta()
  secret.metadata.name = secretName

  secret.metadata.labels = {
    [runnerInstanceLabel.key]: runnerInstanceLabel.value
  }
  secret.kind = 'Secret'
  secret.data = {}
  for (const [key, value] of Object.entries(envs)) {
    secret.data[key] = Buffer.from(value).toString('base64')
  }

  await k8sApi.createNamespacedSecret(namespace(), secret)
  return secretName
}

/**
 * Delete a secret.
 *
 * @param secretName The name of the secret.
 * @returns A promise that resolves when the secret is deleted.
 */
export async function deleteSecret(secretName: string): Promise<void> {
  await k8sApi.deleteNamespacedSecret(secretName, namespace())
}

/**
 * Prune secrets.
 *
 * @returns A promise that resolves when the secrets are pruned.
 */
export async function pruneSecrets(): Promise<void> {
  const secretList = await k8sApi.listNamespacedSecret(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!secretList.body.items.length) {
    return
  }

  await Promise.all(
    secretList.body.items.map(
      secret => secret.metadata?.name && deleteSecret(secret.metadata.name)
    )
  )
}

/**
 * Wait for a pod to complete.
 *
 * @example ```typescript
 * await waitForPodToComplete('my-pod')
 * ```
 * @param podName The name of the pod.
 * @returns A promise that resolves when the pod is completed.
 */
export async function waitForPodPhases(
  podName: string,
  awaitingPhases: Set<PodPhase>,
  backOffPhases: Set<PodPhase>,
  maxTimeSeconds = DEFAULT_WAIT_FOR_POD_TIME_SECONDS
): Promise<void> {
  const backOffManager = new BackOffManager(maxTimeSeconds)
  let phase: PodPhase = PodPhase.UNKNOWN
  let backoffCount = 0
  const maxBackoffs = 3 // Check for scheduling issues after this many backoffs
  const logInterval = 5 // Log pod details every 5 iterations

  try {
    while (true) {
      phase = await getPodPhase(podName)

      // Log pod phase on each check and more detailed logs periodically
      if (backoffCount % logInterval === 0) {
        core.info(
          `Pod ${podName} is in phase: ${phase} after ${backoffCount} checks`
        )

        // If pod stays in PENDING for too long, log more details
        if (phase === PodPhase.PENDING && backoffCount >= maxBackoffs) {
          try {
            const podStatus = await getPodStatus(podName)
            if (podStatus) {
              core.info(
                `Pod conditions: ${JSON.stringify(podStatus.conditions || [])}`
              )
              if (podStatus.containerStatuses) {
                core.info(
                  `Container statuses: ${JSON.stringify(
                    podStatus.containerStatuses
                  )}`
                )
              }
            }
          } catch (statusError) {
            core.debug(`Error getting pod status: ${statusError}`)
          }
        }
      } else {
        core.debug(`Pod ${podName} is in phase: ${phase}`)
      }

      if (awaitingPhases.has(phase)) {
        core.info(`Pod ${podName} reached desired phase: ${phase}`)
        return
      }

      // If pod is in PENDING state for too long, check for scheduling issues
      if (phase === PodPhase.PENDING && backoffCount >= maxBackoffs) {
        const schedulingIssues = await checkPodSchedulingIssues(podName)
        if (schedulingIssues) {
          // This will help users identify resource constraints more clearly
          throw new Error(
            `Pod ${podName} failed to schedule: ${schedulingIssues}. ` +
              `Check your workflow's resource requests or node capacity.`
          )
        }
      }

      if (!backOffPhases.has(phase)) {
        // Before throwing an error, check for scheduling issues
        const schedulingIssues = await checkPodSchedulingIssues(podName)
        if (schedulingIssues) {
          throw new Error(
            `Pod ${podName} is unhealthy with phase status ${phase}. ` +
              `Scheduling issues detected: ${schedulingIssues}`
          )
        } else {
          throw new Error(
            `Pod ${podName} is unhealthy with phase status ${phase}`
          )
        }
      }

      backoffCount++
      await backOffManager.backOff()
    }
  } catch (error) {
    // Log the final error with more details
    core.error(
      `Pod ${podName} failed with phase ${phase} after ${backoffCount} checks`
    )

    // Check for scheduling issues one last time
    try {
      const schedulingIssues = await checkPodSchedulingIssues(podName)
      if (schedulingIssues) {
        throw new Error(
          `Pod ${podName} is unhealthy with phase status ${phase}. ` +
            `Scheduling issues detected: ${schedulingIssues}`
        )
      }
    } catch (scheduleCheckError) {
      // If checking for scheduling issues fails, fall back to the original error
      core.debug(`Failed to check scheduling issues: ${scheduleCheckError}`)
    }

    throw new Error(
      `Pod ${podName} is unhealthy with phase status ${phase}: ${error}`
    )
  }
}

/**
 * Get GitHub prepare job timeout in seconds.
 *
 * @returns The timeout in seconds.
 */
export function getPrepareJobTimeoutSeconds(): number {
  const envTimeoutSeconds =
    process.env['ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS']

  if (!envTimeoutSeconds) {
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  const timeoutSeconds = parseInt(envTimeoutSeconds, 10)
  if (!timeoutSeconds || timeoutSeconds <= 0) {
    core.warning(
      `Prepare job timeout is invalid ("${timeoutSeconds}"): use an int > 0`
    )
    return DEFAULT_WAIT_FOR_POD_TIME_SECONDS
  }

  return timeoutSeconds
}

/**
 * Get pod phase status.
 *
 * @param podName The name of the pod.
 * @returns The pod phase status.
 */
async function getPodPhase(podName: string): Promise<PodPhase> {
  const podPhaseLookup = new Set<string>([
    PodPhase.PENDING,
    PodPhase.RUNNING,
    PodPhase.SUCCEEDED,
    PodPhase.FAILED,
    PodPhase.UNKNOWN
  ])
  const { body: pod } = await k8sApi.readNamespacedPod(podName, namespace())

  if (!pod.status?.phase || !podPhaseLookup.has(pod.status.phase)) {
    return PodPhase.UNKNOWN
  }
  return pod.status?.phase as PodPhase
}

/**
 * Check if a job has succeeded.
 *
 * @param jobName The name of the job.
 * @returns A promise that resolves to true if the job has succeeded.
 */
async function isJobSucceeded(jobName: string): Promise<boolean> {
  const { body: job } = await k8sBatchV1Api.readNamespacedJob(
    jobName,
    namespace()
  )
  if (job.status?.failed) {
    throw new Error(`job ${jobName} has failed`)
  }
  return !!job.status?.succeeded
}

/**
 * Gets logs from a container in a pod, with error handling
 *
 * @param podName The name of the pod
 * @param containerName The name of the container (optional, uses first container if not specified)
 * @returns Pod logs or error message
 */
export async function getPodLogs(
  podName: string,
  containerName?: string
): Promise<string> {
  try {
    // If no container name provided, try to get the first container name
    if (!containerName) {
      try {
        const { body: pod } = await k8sApi.readNamespacedPod(
          podName,
          namespace()
        )
        const containers = pod.spec?.containers || []
        if (containers.length > 0) {
          containerName = containers[0].name
        } else {
          return 'No containers found in pod'
        }
      } catch (error) {
        return `Could not determine container name: ${error}`
      }
    }

    // Use a properly configured read log operation with explicit parameters
    try {
      const response = await k8sApi.readNamespacedPodLog(
        podName,
        namespace(),
        containerName,
        undefined,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        100,
        undefined
      )

      const body = response.body

      if (!body || body.trim() === '') {
        return 'No logs available yet'
      }

      return body
    } catch (logsError: any) {
      // Check if the error is a 404 (which is expected if the pod is already gone)
      if (logsError.statusCode === 404) {
        return 'Pod not found (likely terminated)'
      }

      // Handle other common HTTP errors
      if (logsError.statusCode) {
        return `Error retrieving logs: HTTP ${logsError.statusCode} - ${logsError.message}`
      }

      return `Error retrieving logs: ${logsError}`
    }
  } catch (error) {
    return `Failed to get pod logs: ${error}`
  }
}

/**
 * Prune pods for a job.
 *
 * @returns A promise that resolves when the pods are pruned.
 */
export async function prunePods(): Promise<void> {
  const podList = await k8sApi.listNamespacedPod(
    namespace(),
    undefined,
    undefined,
    undefined,
    undefined,
    new RunnerInstanceLabel().toString()
  )
  if (!podList.body.items.length) {
    return
  }

  await Promise.all(
    podList.body.items.map(
      pod => pod.metadata?.name && deletePod(pod.metadata.name)
    )
  )
}

/**
 * Get the status of a pod.
 *
 * @param name The name of the pod.
 * @returns The status of the pod.
 */
export async function getPodStatus(
  name: string
): Promise<k8s.V1PodStatus | undefined> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body.status
}

/**
 * Is the service account permissions are valid.
 *
 * @returns A promise that resolves to true if the service account permissions are valid.
 */
export async function isAuthPermissionsOK(): Promise<boolean> {
  const sar = new k8s.V1SelfSubjectAccessReview()
  const asyncs: Promise<{
    response: unknown
    body: k8s.V1SelfSubjectAccessReview
  }>[] = []
  for (const resource of requiredPermissions) {
    for (const verb of resource.verbs) {
      sar.spec = new k8s.V1SelfSubjectAccessReviewSpec()
      sar.spec.resourceAttributes = new k8s.V1ResourceAttributes()
      sar.spec.resourceAttributes.verb = verb
      sar.spec.resourceAttributes.namespace = namespace()
      sar.spec.resourceAttributes.group = resource.group
      sar.spec.resourceAttributes.resource = resource.resource
      sar.spec.resourceAttributes.subresource = resource.subresource
      asyncs.push(k8sAuthorizationV1Api.createSelfSubjectAccessReview(sar))
    }
  }
  const responses = await Promise.all(asyncs)
  return responses.every(resp => resp.body.status?.allowed)
}

/**
 * Is the pod container Alpine.
 *
 * @example ```typescript
 * const isAlpine = await isPodContainerAlpine('my-pod', 'my-container')
 * ```
 * @param podName The name of the pod.
 * @param containerName The name of the container.
 * @returns A promise that resolves to true if the pod container is Alpine.
 * @throws An error if the pod container is not Alpine.
 */
export async function isPodContainerAlpine(
  podName: string,
  containerName: string
): Promise<boolean> {
  let isAlpine = true
  try {
    await execPodStep(
      [
        'sh',
        '-c',
        `'[ $(cat /etc/*release* | grep -i -e "^ID=*alpine*" -c) != 0 ] || exit 1'`
      ],
      podName,
      containerName
    )
  } catch (err) {
    isAlpine = false
  }

  return isAlpine
}

/**
 * Get the current node name.
 *
 * @returns The current node name.
 */
async function getCurrentNodeName(): Promise<string> {
  const resp = await k8sApi.readNamespacedPod(getRunnerPodName(), namespace())

  const nodeName = resp.body.spec?.nodeName
  if (!nodeName) {
    throw new Error('Failed to determine node name')
  }
  return nodeName
}

/**
 * Get the namespace.
 *
 * @returns The namespace.
 */
export function namespace(): string {
  if (process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']) {
    return process.env['ACTIONS_RUNNER_KUBERNETES_NAMESPACE']
  }

  const context = kc.getContexts().find(ctx => ctx.namespace)
  if (!context?.namespace) {
    throw new Error(
      'Failed to determine namespace, falling back to `default`. Namespace should be set in context, or in env variable "ACTIONS_RUNNER_KUBERNETES_NAMESPACE"'
    )
  }
  return context.namespace
}

/**
 * A backoff manager for exponential backoff. The backoff time is doubled each time, up to 20 seconds.
 * If a throwAfterSeconds is provided, an error will be thrown after that many seconds.
 *
 * @example ```typescript
 * const backOffManager = new BackOffManager(60)
 * while (true) {
 *  try {
 *   await backOffManager.backOff()
 *  // do something
 * } catch (error) {
 *  // handle error
 * }
 * ```
 * @param throwAfterSeconds Throw an error after this many seconds.
 * @returns A promise that resolves when the backoff is complete.
 */
class BackOffManager {
  private backOffSeconds = 1
  totalTime = 0
  constructor(private throwAfterSeconds?: number) {
    if (!throwAfterSeconds || throwAfterSeconds < 0) {
      this.throwAfterSeconds = undefined
    }
  }

  async backOff(): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, this.backOffSeconds * 1000)
    )
    this.totalTime += this.backOffSeconds
    if (this.throwAfterSeconds && this.throwAfterSeconds < this.totalTime) {
      throw new Error('backoff timeout')
    }
    if (this.backOffSeconds < 20) {
      this.backOffSeconds *= 2
    }
    if (this.backOffSeconds > 20) {
      this.backOffSeconds = 20
    }
  }
}

/**
 * Get the container ports.
 *
 * @example ```typescript
 * const ports = containerPorts(container)
 * ```
 * @param container The container info.
 * @returns The container ports.
 */
export function containerPorts(
  container: ContainerInfo
): k8s.V1ContainerPort[] {
  const ports: k8s.V1ContainerPort[] = []
  if (!container.portMappings?.length) {
    return ports
  }
  for (const portDefinition of container.portMappings) {
    const portProtoSplit = portDefinition.split('/')
    if (portProtoSplit.length > 2) {
      throw new Error(`Unexpected port format: ${portDefinition}`)
    }

    const port = new k8s.V1ContainerPort()
    port.protocol =
      portProtoSplit.length === 2 ? portProtoSplit[1].toUpperCase() : 'TCP'

    const portSplit = portProtoSplit[0].split(':')
    if (portSplit.length > 2) {
      throw new Error('ports should have at most one ":" separator')
    }

    const parsePort = (p: string): number => {
      const num = Number(p)
      if (!Number.isInteger(num) || num < 1 || num > 65535) {
        throw new Error(`invalid container port: ${p}`)
      }
      return num
    }

    if (portSplit.length === 1) {
      port.containerPort = parsePort(portSplit[0])
    } else {
      port.hostPort = parsePort(portSplit[0])
      port.containerPort = parsePort(portSplit[1])
    }

    ports.push(port)
  }
  return ports
}

/**
 * Get a pod by name.
 *
 * @example ```typescript
 * const pod = await getPodByName('my-pod')
 * ```
 * @param name The name of the pod.
 * @returns The pod.
 */
export async function getPodByName(name): Promise<k8s.V1Pod> {
  const { body } = await k8sApi.readNamespacedPod(name, namespace())
  return body
}

/**
 * Checks for pod scheduling issues by fetching relevant Kubernetes events
 *
 * @param podName The name of the pod
 * @returns A string describing scheduling issues or empty string if none found
 */
export async function checkPodSchedulingIssues(
  podName: string
): Promise<string> {
  let result = ''
  try {
    // Add timeout to prevent hanging on API call
    const timeout = 5000 // 5 seconds
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      // Get pod events sorted by timestamp
      const fieldSelector = `involvedObject.name=${podName}`
      const { body: events } = await k8sApi.listNamespacedEvent(
        namespace(),
        undefined,
        undefined,
        undefined,
        fieldSelector,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )

      clearTimeout(timeoutId)

      // Filter events to show only scheduling-related ones
      const schedulingIssues = events.items.filter(
        e =>
          (e.reason?.includes('FailedScheduling') ||
            e.reason?.includes('NodeNotReady') ||
            e.reason?.includes('Insufficient') ||
            e.reason?.includes('Unschedulable') ||
            e.reason?.includes('Taint') ||
            e.message?.includes('node(s) didn')) &&
          e.type === 'Warning'
      )

      if (schedulingIssues.length > 0) {
        result += 'Scheduling issues detected:\n'

        // Sort events by timestamp (newest first) to get the most recent issues
        schedulingIssues.sort((a, b) => {
          const timeA = a.lastTimestamp || a.eventTime || a.firstTimestamp
          const timeB = b.lastTimestamp || b.eventTime || b.firstTimestamp

          if (!timeA) return 1
          if (!timeB) return -1

          return new Date(timeB).getTime() - new Date(timeA).getTime()
        })

        for (const event of schedulingIssues) {
          result += `- [${
            event.lastTimestamp || event.eventTime || event.firstTimestamp
          }] ${event.reason}: ${event.message}\n`
        }

        // Add more details for common scheduling issues
        if (
          schedulingIssues.some(e => e.message?.includes('Insufficient memory'))
        ) {
          result +=
            '\nPossible memory constraint issue. Check node memory availability.\n'
          try {
            const nodeInfo = await getNodeResourceUsage()
            result += `\nNode resource details:\n${nodeInfo}\n`
          } catch (nodeErr) {
            result += `\nCould not get node resource details: ${nodeErr}\n`
          }
        }

        if (
          schedulingIssues.some(e => e.message?.includes('Insufficient cpu'))
        ) {
          result +=
            '\nPossible CPU constraint issue. Check node CPU availability.\n'
        }

        if (
          schedulingIssues.some(e => e.message?.includes('node(s) had taint'))
        ) {
          result +=
            '\nPod may not have the required tolerations for node taints.\n'
        }

        return result
      } else {
        // If no scheduling events found, check pod status directly for hard failures
        try {
          const { body: pod } = await k8sApi.readNamespacedPod(
            podName,
            namespace()
          )

          if (pod.status?.phase === 'Failed') {
            result += `Pod is in Failed phase. Reason: ${
              pod.status.reason || 'Unknown'
            }\n`

            // Check container statuses
            if (pod.status.containerStatuses) {
              for (const status of pod.status.containerStatuses) {
                if (status.state?.waiting) {
                  result += `Container ${status.name} is waiting: ${
                    status.state.waiting.reason
                  } - ${status.state.waiting.message || 'No message'}\n`
                } else if (status.state?.terminated) {
                  result += `Container ${status.name} terminated: Exit code ${
                    status.state.terminated.exitCode
                  } - ${status.state.terminated.reason} - ${
                    status.state.terminated.message || 'No message'
                  }\n`
                }
              }
            }

            // Get pod conditions
            if (pod.status.conditions) {
              result += 'Pod conditions:\n'
              for (const condition of pod.status.conditions) {
                result += `- ${condition.type}: ${condition.status} (${
                  condition.reason || 'No reason'
                } - ${condition.message || 'No message'})\n`
              }
            }

            return result
          } else if (pod.status?.phase === 'Pending') {
            // Only treat Pending as an issue when it's clearly unschedulable or image errors
            if (pod.status.conditions) {
              const unschedulable = pod.status.conditions.find(
                c =>
                  c.type === 'PodScheduled' &&
                  c.status === 'False' &&
                  ((c.reason ?? '').includes('Unschedulable') ||
                    (c.message ?? '').match(/Insufficient|taint|No nodes/i))
              )

              if (unschedulable) {
                result += 'Pod is Pending due to scheduling constraints:\n'
                result += `- ${unschedulable.type}: ${unschedulable.status} (${
                  unschedulable.reason || 'No reason'
                } - ${unschedulable.message || 'No message'})\n`
                return result
              }
            }

            // For init containers, surface only hard errors that block progress
            if (pod.status.initContainerStatuses) {
              const blockingInits = pod.status.initContainerStatuses.filter(
                init => {
                  const reason = init.state?.waiting?.reason || ''
                  const term = init.state?.terminated
                  return (
                    reason.includes('ErrImagePull') ||
                    reason.includes('ImagePullBackOff') ||
                    (term && term.exitCode !== 0)
                  )
                }
              )
              if (blockingInits.length > 0) {
                result += 'Init container failures detected:\n'
                for (const init of blockingInits) {
                  if (init.state?.waiting) {
                    result += `- ${init.name}: Waiting - ${
                      init.state.waiting.reason
                    } - ${init.state.waiting.message || 'No message'}\n`
                  } else if (init.state?.terminated) {
                    result += `- ${init.name}: Failed - Exit code ${
                      init.state.terminated.exitCode
                    } - ${init.state.terminated.reason} - ${
                      init.state.terminated.message || 'No message'
                    }\n`
                  }
                }
                return result
              }
            }
            // Otherwise: Pending without concrete issues – return empty to keep waiting
          }
        } catch (podErr) {
          // Non-fatal; do not treat as a scheduling issue
          core.debug(`Error checking pod status for ${podName}: ${podErr}`)
        }
      }
    } catch (err) {
      clearTimeout(timeoutId)

      // Check if this is a 404 (pod may have been deleted)
      if ((err as any)?.response?.statusCode === 404) {
        return `Pod ${podName} not found - it may have been deleted`
      }

      // Handle other API errors
      core.debug(`Error checking pod events for ${podName}: ${err}`)

      // Try to get pod status directly
      try {
        const { body: pod } = await k8sApi.readNamespacedPod(
          podName,
          namespace()
        )
        // Only flag hard failures here
        if (pod.status?.phase === 'Failed') {
          return `Pod is in Failed phase. Reason: ${
            pod.status.reason || 'Unknown'
          }`
        }
      } catch (podErr) {
        core.debug(`Could not fetch pod status for ${podName}: ${podErr}`)
      }
    }
  } catch (error) {
    core.debug(`Failed to check scheduling issues for ${podName}: ${error}`)
  }

  // Empty string means: keep waiting, no concrete scheduling issues detected
  return ''
}

/**
 * Gets detailed information about a pod, including its status and events
 * Similar to running kubectl describe pod
 *
 * @param podName The name of the pod
 * @returns Detailed pod information and related events
 */
export async function getPodDetails(podName: string): Promise<string> {
  let details = `\n==== Pod Details ====\n`
  let podDetailsRetrieved = false

  // Try to get pod details, but don't fail if we can't
  try {
    // Get pod details
    const { body: pod } = await k8sApi.readNamespacedPod(podName, namespace())

    podDetailsRetrieved = true
    details += `Name: ${pod.metadata?.name}\n`
    details += `Namespace: ${pod.metadata?.namespace}\n`
    details += `Status: ${pod.status?.phase}\n`

    if (pod.status?.conditions) {
      details += `\n== Conditions ==\n`
      for (const condition of pod.status.conditions) {
        details += `${condition.type}: ${condition.status}\n`
        if (condition.reason) {
          details += `  Reason: ${condition.reason}\n`
        }
        if (condition.message) {
          details += `  Message: ${condition.message}\n`
        }
      }
    }

    // Container statuses
    if (pod.status?.containerStatuses) {
      details += `\n== Container Statuses ==\n`
      for (const containerStatus of pod.status.containerStatuses) {
        details += `${containerStatus.name}: ${
          containerStatus.ready ? 'Ready' : 'Not Ready'
        }\n`

        // Show waiting state (particularly useful for CrashLoopBackoff, etc.)
        if (containerStatus.state?.waiting) {
          details += `  State: Waiting\n`
          details += `  Reason: ${containerStatus.state.waiting.reason}\n`
          if (containerStatus.state.waiting.message) {
            details += `  Message: ${containerStatus.state.waiting.message}\n`
          }
        }

        // Show terminated state
        if (containerStatus.state?.terminated) {
          details += `  State: Terminated\n`
          details += `  Exit Code: ${containerStatus.state.terminated.exitCode}\n`
          details += `  Reason: ${containerStatus.state.terminated.reason}\n`
          if (containerStatus.state.terminated.message) {
            details += `  Message: ${containerStatus.state.terminated.message}\n`
          }
        }
      }
    }
  } catch (podError: any) {
    // Improve error handling by checking error type and code
    const errorMessage = podError.message || String(podError)
    const statusCode = podError.statusCode || podError.code

    core.debug(
      `Error retrieving pod details for ${podName}: ${errorMessage}, code: ${statusCode}`
    )

    if (statusCode === 404) {
      details += `Pod not found (likely terminated or never created).\n`
    } else {
      details += `Pod may have been deleted or never successfully created. Error: ${errorMessage}\n`
    }
  }

  // Try to get pod events separately - this might work even if the pod is gone
  try {
    const fieldSelector = `involvedObject.name=${podName}`

    const { body: eventList } = await k8sApi.listNamespacedEvent(
      namespace(),
      undefined,
      undefined,
      fieldSelector
    )

    // Pod Events (most useful for scheduling and other issues)
    if (eventList.items.length > 0) {
      details += `\n== Pod Events ==\n`

      // Sort events by timestamp (latest first)
      const sortedEvents = eventList.items.sort((a, b) => {
        const timeA = a.lastTimestamp || a.eventTime || ''
        const timeB = b.lastTimestamp || b.eventTime || ''
        return new Date(timeB).getTime() - new Date(timeA).getTime()
      })

      for (const event of sortedEvents) {
        const timestamp = event.lastTimestamp || event.eventTime || ''
        details += `[${new Date(timestamp).toISOString()}] ${event.type} ${
          event.reason
        }: ${event.message}\n`
      }
    } else {
      details += `\n== No Events Found ==\n`

      // If we couldn't get pod details AND there are no events, check node capacity
      if (!podDetailsRetrieved) {
        try {
          details += await getNodeResourceUsage()
        } catch (nodeError) {
          core.debug(`Error retrieving node resource usage: ${nodeError}`)
        }
      }
    }

    return details
  } catch (eventsError: any) {
    // Improve error handling by checking error type and code
    const errorMessage = eventsError.message || String(eventsError)
    const statusCode = eventsError.statusCode || eventsError.code

    core.debug(
      `Error retrieving events for ${podName}: ${errorMessage}, code: ${statusCode}`
    )

    details += `\n== Error Retrieving Events ==\n`
    if (statusCode) {
      details += `Failed to retrieve events for pod ${podName}: HTTP ${statusCode} - ${errorMessage}\n`
    } else {
      details += `Failed to retrieve events for pod ${podName}: ${errorMessage}\n`
    }

    // If everything fails, try to get cluster status
    if (!podDetailsRetrieved) {
      try {
        details += await getNodeResourceUsage()
      } catch (nodeError) {
        core.debug(`Error retrieving node resource usage: ${nodeError}`)
      }
    }

    return details
  }
}

/**
 * Gets overview of node resource usage in the cluster
 * Helpful for diagnosing capacity issues
 *
 * @returns A string with node resource usage information
 */
export async function getNodeResourceUsage(): Promise<string> {
  try {
    const { body: nodeList } = await k8sApi.listNode()
    let nodeDetails = `\n== Cluster Node Resources ==\n`

    for (const node of nodeList.items) {
      const nodeName = node.metadata?.name || 'unknown'
      const capacity = node.status?.capacity || {}
      const allocatable = node.status?.allocatable || {}

      nodeDetails += `Node: ${nodeName}\n`
      nodeDetails += `  CPU Capacity: ${capacity.cpu || 'unknown'}\n`
      nodeDetails += `  Memory Capacity: ${capacity.memory || 'unknown'}\n`
      nodeDetails += `  CPU Allocatable: ${allocatable.cpu || 'unknown'}\n`
      nodeDetails += `  Memory Allocatable: ${
        allocatable.memory || 'unknown'
      }\n`

      // Check if the node has taints that might prevent scheduling
      if (node.spec?.taints && node.spec.taints.length > 0) {
        nodeDetails += `  Taints:\n`
        for (const taint of node.spec.taints) {
          nodeDetails += `    ${taint.key}=${taint.value}:${taint.effect}\n`
        }
      }

      // Check node conditions
      if (node.status?.conditions) {
        const notReadyCondition = node.status.conditions.find(
          c => c.type === 'Ready' && c.status !== 'True'
        )

        if (notReadyCondition) {
          nodeDetails += `  Node Not Ready! Reason: ${notReadyCondition.reason}\n`
          nodeDetails += `  Message: ${notReadyCondition.message}\n`
        }
      }
    }

    return nodeDetails
  } catch (error) {
    return `\n== Failed to retrieve node resource usage: ${error} ==\n`
  }
}

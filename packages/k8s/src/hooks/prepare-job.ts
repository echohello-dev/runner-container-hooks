import * as core from '@actions/core'
import * as io from '@actions/io'
import * as k8s from '@kubernetes/client-node'
import {
  JobContainerInfo,
  ContextPorts,
  PrepareJobArgs,
  writeToResponseFile
} from 'hooklib'
import path from 'path'
import {
  containerPorts,
  createPod,
  isPodContainerAlpine,
  prunePods,
  waitForPodPhases,
  getPrepareJobTimeoutSeconds,
  getPodDetails,
  namespace,
  k8sApi,
  getPodLogs,
  getNodeResourceUsage
} from '../k8s'
import { CONTAINER_EXTENSION_PREFIX, JOB_CONTAINER_NAME } from './constants'
import {
  readExtensionFromFile,
  generateContainerName,
  PodPhase,
  DEFAULT_CONTAINER_ENTRY_POINT,
  DEFAULT_CONTAINER_ENTRY_POINT_ARGS,
  fixArgs,
  containerVolumes,
  mergeContainerWithOptions
} from '../k8s/utils'

/**
 * Prepares a job by creating a pod and waiting for it to come online.
 *
 * @param args The arguments for the job.
 * @param responseFile The path to the response file.
 * @returns A promise that resolves when the job is ready.
 */
export async function prepareJob(
  args: PrepareJobArgs,
  responseFile
): Promise<void> {
  if (!args.container) {
    throw new Error('Job Container is required.')
  }

  await prunePods()

  const extension = readExtensionFromFile()
  await copyExternalsToRoot()

  let container: k8s.V1Container | undefined = undefined
  if (args.container?.image) {
    core.debug(`Using image '${args.container.image}' for job image`)

    // Log resource requests before container creation
    const cpuRequest = args.container.cpu || 'default'
    const memoryRequest = args.container.memory || 'default'
    core.info(
      `Workflow job requesting resources - CPU: ${cpuRequest}, Memory: ${memoryRequest}`
    )

    container = createContainerSpec(
      args.container,
      JOB_CONTAINER_NAME,
      true,
      extension
    )

    // Log the actual resource limits after container creation
    if (container.resources) {
      core.info(
        `Actual container resources - Limits: CPU=${
          container.resources.limits?.cpu || 'none'
        }, Memory=${container.resources.limits?.memory || 'none'}`
      )
      core.info(
        `Actual container resources - Requests: CPU=${
          container.resources.requests?.cpu || 'none'
        }, Memory=${container.resources.requests?.memory || 'none'}`
      )
    }
  }

  let services: k8s.V1Container[] = []
  if (args.services?.length) {
    services = args.services.map(service => {
      core.debug(`Adding service '${service.image}' to pod definition`)
      return createContainerSpec(
        service,
        generateContainerName(service.image),
        false,
        extension
      )
    })
  }

  if (!container && !services?.length) {
    throw new Error('No containers exist, skipping hook invocation')
  }

  // Print diagnostic information before creating the pod
  try {
    core.info('==== RUNNER DIAGNOSTICS ====')

    // Node resource information
    try {
      const nodeInfo = await getNodeResourceUsage()
      core.info('Node Resources:')
      core.info(nodeInfo)
    } catch (nodeErr) {
      core.warning(`Failed to get node resource info: ${nodeErr}`)
    }

    // Container resource requests
    core.info('Container Resources:')
    if (container?.resources) {
      core.info(
        `Job Container CPU Request: ${
          container.resources.requests?.cpu || 'unspecified'
        }`
      )
      core.info(
        `Job Container Memory Request: ${
          container.resources.requests?.memory || 'unspecified'
        }`
      )
      core.info(
        `Job Container CPU Limit: ${
          container.resources.limits?.cpu || 'unspecified'
        }`
      )
      core.info(
        `Job Container Memory Limit: ${
          container.resources.limits?.memory || 'unspecified'
        }`
      )
    }

    // Display extension information if available
    if (extension) {
      core.info('Pod Extension Information:')

      if (extension.spec?.nodeSelector) {
        core.info('Node Selector:')
        for (const [key, value] of Object.entries(
          extension.spec.nodeSelector
        )) {
          core.info(`  ${key}: ${value}`)
        }
      }

      if (
        extension.spec?.tolerations &&
        extension.spec.tolerations.length > 0
      ) {
        core.info('Tolerations:')
        for (const toleration of extension.spec.tolerations) {
          core.info(
            `  ${toleration.key}=${toleration.value}:${
              toleration.effect || 'NoSchedule'
            }`
          )
        }
      }

      if (extension.spec?.affinity) {
        core.info('Affinity rules are configured.')
      }
    }

    core.info('===========================')
  } catch (diagnosticErr) {
    core.warning(`Failed to print pod diagnostics: ${diagnosticErr}`)
  }

  let createdPod: k8s.V1Pod | undefined = undefined
  try {
    createdPod = await createPod(
      container,
      services,
      args.container.registry,
      extension
    )

    // Log the pod manifest after creation
    if (createdPod?.metadata?.name) {
      try {
        core.info('==== CREATED POD MANIFEST ====')
        // Fetch the actual created pod to ensure we have the complete information
        const { body: podManifest } = await k8sApi.readNamespacedPod(
          createdPod.metadata.name,
          namespace()
        )

        // Create a safe copy for logging
        const safePodManifest = JSON.parse(JSON.stringify(podManifest))

        // Mask sensitive information in environment variables
        if (safePodManifest.spec?.containers) {
          for (const container of safePodManifest.spec.containers) {
            if (container.env) {
              for (const env of container.env) {
                // Mask potentially sensitive values
                if (
                  env.name.includes('TOKEN') ||
                  env.name.includes('SECRET') ||
                  env.name.includes('KEY') ||
                  env.name.includes('PASSWORD')
                ) {
                  env.value = '***REDACTED***'
                }
              }
            }
          }
        }

        core.info(JSON.stringify(safePodManifest, null, 2))
        core.info('=============================')
      } catch (podLogErr) {
        core.warning(`Failed to log pod manifest: ${podLogErr}`)
      }
    }
  } catch (err) {
    await prunePods()
    core.debug(`createPod failed: ${JSON.stringify(err)}`)
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to create job pod: ${message}`)
  }

  if (!createdPod?.metadata?.name) {
    throw new Error('created pod should have metadata.name')
  }
  core.debug(
    `Job pod created, waiting for it to come online ${createdPod?.metadata?.name}`
  )

  // Try to immediately check pod status for early failures or issues
  try {
    // Capture pod status immediately after creation
    const podName = createdPod.metadata.name

    // Wait a brief moment for the pod to initialize
    await new Promise(resolve => setTimeout(resolve, 1000))

    const { body: initialPod } = await k8sApi.readNamespacedPod(
      podName,
      namespace()
    )
    core.info(`Initial pod status: ${initialPod.status?.phase}`)

    if (initialPod.status?.phase === 'Failed') {
      // If pod already failed, get detailed information immediately
      core.warning('Pod failed immediately after creation!')

      // Try to get logs from the container
      try {
        const logs = await getPodLogs(podName, JOB_CONTAINER_NAME)
        core.info('Pod logs:')
        core.info(logs)
      } catch (logErr) {
        core.warning(`Failed to get pod logs: ${logErr}`)
      }

      // Log container status if available
      if (initialPod.status?.containerStatuses) {
        for (const containerStatus of initialPod.status.containerStatuses) {
          // Check for terminated containers with error states
          if (containerStatus.state?.terminated) {
            core.error(
              `Container ${containerStatus.name} terminated with exit code ${containerStatus.state.terminated.exitCode}: ${containerStatus.state.terminated.reason}`
            )
            if (containerStatus.state.terminated.message) {
              core.error(`Message: ${containerStatus.state.terminated.message}`)
            }
          }

          // Check for waiting containers
          if (containerStatus.state?.waiting) {
            core.warning(
              `Container ${containerStatus.name} waiting: ${containerStatus.state.waiting.reason}`
            )
            if (containerStatus.state.waiting.message) {
              core.warning(`Message: ${containerStatus.state.waiting.message}`)
            }
          }
        }
      }

      // Try to get pod events immediately
      try {
        const fieldSelector = `involvedObject.name=${podName}`
        const { body: eventList } = await k8sApi.listNamespacedEvent(
          namespace(),
          undefined,
          undefined,
          undefined,
          fieldSelector
        )

        if (eventList.items.length > 0) {
          core.info('Initial pod events:')
          for (const event of eventList.items) {
            core.info(`${event.type} ${event.reason}: ${event.message}`)
          }
        } else {
          core.info('No initial events found for pod.')
        }
      } catch (eventErr) {
        core.warning(`Failed to get initial pod events: ${eventErr}`)
      }
    }
  } catch (initialCheckErr) {
    core.warning(`Error checking initial pod status: ${initialCheckErr}`)
  }

  try {
    await waitForPodPhases(
      createdPod.metadata.name,
      new Set([PodPhase.RUNNING]),
      new Set([PodPhase.PENDING]),
      getPrepareJobTimeoutSeconds()
    )
  } catch (err) {
    // Gather detailed pod information before pruning
    let podDetails = ''
    try {
      core.info(
        `Gathering detailed information for failed pod ${createdPod.metadata.name}...`
      )
      podDetails = await getPodDetails(createdPod.metadata.name)

      // Try to get container logs which may have more details
      try {
        const logs = await getPodLogs(
          createdPod.metadata.name,
          JOB_CONTAINER_NAME
        )
        if (
          logs &&
          !logs.startsWith('Error') &&
          !logs.startsWith('Failed') &&
          logs !== 'No logs available yet'
        ) {
          podDetails += '\n\n== Container Logs ==\n'
          podDetails += logs
        }
      } catch (logErr) {
        core.warning(`Failed to get container logs: ${logErr}`)
      }

      core.info('Pod detailed information:')
      core.info(podDetails)
    } catch (detailsError) {
      core.warning(`Failed to get detailed pod information: ${detailsError}`)
      try {
        // If getPodDetails fails completely, try a direct API approach
        const { body: pod } = await k8sApi.readNamespacedPod(
          createdPod.metadata.name,
          namespace()
        )
        podDetails = `\nPod Status: ${pod.status?.phase}\n`
        if (pod.status?.message) {
          podDetails += `Message: ${pod.status.message}\n`
        }
        if (pod.status?.reason) {
          podDetails += `Reason: ${pod.status.reason}\n`
        }

        // Try to get status conditions
        if (pod.status?.conditions) {
          podDetails += '\nConditions:\n'
          for (const condition of pod.status.conditions) {
            podDetails += `- ${condition.type}: ${condition.status}\n`
            if (condition.reason) {
              podDetails += `  Reason: ${condition.reason}\n`
            }
            if (condition.message) {
              podDetails += `  Message: ${condition.message}\n`
            }
          }
        }

        // Try to get container statuses
        if (pod.status?.containerStatuses) {
          podDetails += '\nContainer Statuses:\n'
          for (const status of pod.status.containerStatuses) {
            podDetails += `- ${status.name}: ${
              status.ready ? 'Ready' : 'Not Ready'
            }\n`
            if (status.state?.waiting) {
              podDetails += `  Waiting: ${status.state.waiting.reason} - ${
                status.state.waiting.message || 'No message'
              }\n`
            }
            if (status.state?.terminated) {
              podDetails += `  Terminated: Exit Code ${status.state.terminated.exitCode} - ${status.state.terminated.reason}\n`
              if (status.state.terminated.message) {
                podDetails += `  Message: ${status.state.terminated.message}\n`
              }
            }
          }
        }
      } catch (fallbackError) {
        core.warning(`Failed to get basic pod information: ${fallbackError}`)
        podDetails =
          '\nCould not retrieve any pod information. The pod may have been deleted.\n'

        // Try one more approach - get node information to see if there are resource constraints
        try {
          const nodeDetails = await getNodeResourceUsage()
          podDetails += '\n== Cluster Resource Information ==\n'
          podDetails += nodeDetails
        } catch (nodeError) {
          core.warning(`Failed to get node resource information: ${nodeError}`)
        }
      }
    }

    // Always try to get events separately, as this is most likely to work and be useful
    try {
      const fieldSelector = `involvedObject.name=${createdPod.metadata.name}`
      const { body: eventList } = await k8sApi.listNamespacedEvent(
        namespace(),
        undefined,
        undefined,
        undefined,
        fieldSelector
      )

      if (eventList.items.length > 0) {
        podDetails += '\n== Pod Events ==\n'
        for (const event of eventList.items) {
          const timestamp = event.lastTimestamp || event.eventTime || ''
          podDetails += `[${new Date(timestamp).toISOString()}] ${event.type} ${
            event.reason
          }: ${event.message}\n`
        }
      }
    } catch (eventsError) {
      core.warning(`Failed to get pod events: ${eventsError}`)
    }

    await prunePods()

    // Check for scheduling issues in the error message
    const errorMessage = String(err)

    // Add clearer logging for debugging purposes
    core.error(`Pod failure details: ${errorMessage}`)

    if (
      errorMessage.includes('OutOfcpu') ||
      errorMessage.includes('Insufficient cpu') ||
      errorMessage.includes("didn't have enough resource: cpu")
    ) {
      core.error(
        'CPU resource constraint detected. The job requires more CPU than available on the node.'
      )
      core.error(
        'Consider reducing CPU requests in your workflow or using a node with more resources.'
      )
      throw new Error(
        `Pod scheduling failed due to CPU resource constraints: ${err}\n${podDetails}`
      )
    }

    if (
      errorMessage.includes('OutOfmemory') ||
      errorMessage.includes('Insufficient memory') ||
      errorMessage.includes("didn't have enough resource: memory")
    ) {
      core.error(
        'Memory resource constraint detected. The job requires more memory than available on the node.'
      )
      core.error(
        'Consider reducing memory requests in your workflow or using a node with more resources.'
      )
      throw new Error(
        `Pod scheduling failed due to memory resource constraints: ${err}\n${podDetails}`
      )
    }

    // Handle node selector and affinity issues
    if (
      errorMessage.includes("node(s) didn't match node selector") ||
      errorMessage.includes("node(s) didn't satisfy existing NodeAffinity")
    ) {
      core.error(
        'Node selection constraint detected. No nodes matching the required selectors/affinity rules are available.'
      )
      core.error(
        'Check your nodeSelector and affinity rules in the runner configuration.'
      )
      throw new Error(
        `Pod scheduling failed due to node selection constraints: ${err}\n${podDetails}`
      )
    }

    // Include the pod details in the general error message
    throw new Error(
      `Pod failed to come online with error: ${err}\n${podDetails}`
    )
  }

  core.debug('Job pod is ready for traffic')

  let isAlpine = false
  try {
    isAlpine = await isPodContainerAlpine(
      createdPod.metadata.name,
      JOB_CONTAINER_NAME
    )
  } catch (err) {
    core.debug(
      `Failed to determine if the pod is alpine: ${JSON.stringify(err)}`
    )
    const message = (err as any)?.response?.body?.message || err
    throw new Error(`failed to determine if the pod is alpine: ${message}`)
  }
  core.debug(`Setting isAlpine to ${isAlpine}`)
  generateResponseFile(responseFile, createdPod, isAlpine)
}

/**
 * Generates the response file.
 *
 * @param responseFile The path to the response file.
 * @param appPod The pod that was created.
 * @param isAlpine Whether or not the pod is Alpine.
 * @throws An error if the app pod does not have a name.
 */
function generateResponseFile(
  responseFile: string,
  appPod: k8s.V1Pod,
  isAlpine
): void {
  if (!appPod.metadata?.name) {
    throw new Error('app pod must have metadata.name specified')
  }
  const response = {
    state: {
      jobPod: appPod.metadata.name
    },
    context: {},
    isAlpine
  }

  const mainContainer = appPod.spec?.containers?.find(
    c => c.name === JOB_CONTAINER_NAME
  )
  if (mainContainer) {
    const mainContainerContextPorts: ContextPorts = {}
    if (mainContainer?.ports) {
      for (const port of mainContainer.ports) {
        mainContainerContextPorts[port.containerPort] =
          mainContainerContextPorts.hostPort
      }
    }

    response.context['container'] = {
      image: mainContainer.image,
      ports: mainContainerContextPorts
    }
  }

  const serviceContainers = appPod.spec?.containers.filter(
    c => c.name !== JOB_CONTAINER_NAME && c.name !== 'dind'
  )
  if (serviceContainers?.length) {
    response.context['services'] = serviceContainers.map(c => {
      const ctxPorts: ContextPorts = {}
      if (c.ports?.length) {
        for (const port of c.ports) {
          ctxPorts[port.containerPort] = port.hostPort
        }
      }

      return {
        image: c.image,
        ports: ctxPorts
      }
    })
  }
  writeToResponseFile(responseFile, JSON.stringify(response))
}

/**
 * Copies the externals directory to the root of the workspace.
 *
 * @returns A promise that resolves when the externals are copied.
 */
async function copyExternalsToRoot(): Promise<void> {
  const workspace = process.env['RUNNER_WORKSPACE']
  if (workspace) {
    await io.cp(
      path.join(workspace, '../../externals'),
      path.join(workspace, '../externals'),
      { force: true, recursive: true, copySourceDirectory: false }
    )
  }
}

/**
 * Creates a container spec for a pod.
 *
 * @example createContainerSpec({ image: 'alpine' }, 'job', true)
 * @param container The container info.
 * @param name The name of the container.
 * @param jobContainer Whether or not this is the job container.
 * @param extension The extension to merge into the container.
 * @returns A container spec for a pod.
 * @throws An error if the container image is not specified.
 */
export function createContainerSpec(
  container: JobContainerInfo,
  name: string,
  jobContainer = false,
  extension?: k8s.V1PodTemplateSpec
): k8s.V1Container {
  if (!container.entryPoint && jobContainer) {
    container.entryPoint = DEFAULT_CONTAINER_ENTRY_POINT
    container.entryPointArgs = DEFAULT_CONTAINER_ENTRY_POINT_ARGS
  }

  const podContainer = {
    name,
    image: container.image,
    ports: containerPorts(container)
  } as k8s.V1Container
  if (container.workingDirectory) {
    podContainer.workingDir = container.workingDirectory
  }

  if (container.entryPoint) {
    podContainer.command = [container.entryPoint]
  }

  if (container.entryPointArgs?.length > 0) {
    podContainer.args = fixArgs(container.entryPointArgs)
  }

  podContainer.env = []
  for (const [key, value] of Object.entries(
    container['environmentVariables']
  )) {
    if (value && key !== 'HOME') {
      podContainer.env.push({ name: key, value: value as string })
    }
  }

  podContainer.env.push({
    name: 'CI',
    value: 'true'
  })

  if (jobContainer) {
    podContainer.env.push({
      name: 'DOCKER_HOST',
      value: 'unix:///run/docker/docker.sock'
    })

    podContainer.env.push({
      name: 'RUNNER_WAIT_FOR_DOCKER_IN_SECONDS',
      value: '120'
    })
  }

  podContainer.volumeMounts = containerVolumes(
    container.userMountVolumes,
    jobContainer
  )

  podContainer.resources = {
    limits: {
      cpu: '2000m',
      memory: '1Gi'
    },
    requests: {
      cpu: '200m',
      memory: '256Mi'
    }
  }

  if (!extension) {
    return podContainer
  }

  const from = extension.spec?.containers?.find(
    c => c.name === CONTAINER_EXTENSION_PREFIX + name
  )

  if (from) {
    mergeContainerWithOptions(podContainer, from)
  }

  return podContainer
}

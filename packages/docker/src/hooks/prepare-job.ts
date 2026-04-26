import * as core from '@actions/core'
import { ContextPorts, PrepareJobArgs, writeToResponseFile } from 'hooklib/lib'
import { exit } from 'process'
import { v4 as uuidv4 } from 'uuid'
import {
  ContainerMetadata,
  containerPorts,
  containerPrune,
  containerPull,
  containerStart,
  createContainer,
  healthCheck,
  isContainerAlpine,
  registryLogin,
  registryLogout
} from '../dockerCommands/container'
import { networkCreate, networkPrune } from '../dockerCommands/network'
import { runDockerCommand, sanitize } from '../utils'

// Helper function to get system information for diagnostics
async function getSystemInfo(): Promise<string> {
  try {
    // Get Docker info
    const dockerInfo = await runDockerCommand([
      'info',
      '--format',
      '{{json .}}'
    ])

    // Parse the JSON response to get detailed information
    const info = JSON.parse(dockerInfo)

    // Format a user-friendly response with relevant information
    let result = '==== Docker System Information ====\n'

    // Docker version and platform
    result += `Docker Version: ${info.ServerVersion || 'Unknown'}\n`
    result += `OS/Arch: ${info.OSType || 'Unknown'}/${
      info.Architecture || 'Unknown'
    }\n`

    // Resources
    if (info.MemTotal) {
      const memoryGB = (info.MemTotal / (1024 * 1024 * 1024)).toFixed(2)
      result += `Total Memory: ${memoryGB} GB\n`
    }

    if (info.NCPU) {
      result += `CPUs: ${info.NCPU}\n`
    }

    // Container stats
    result += `Running Containers: ${info.ContainersRunning || 0}\n`
    result += `Total Containers: ${info.Containers || 0}\n`

    // Storage driver and status
    if (info.Driver) {
      result += `Storage Driver: ${info.Driver}\n`
    }

    return result
  } catch (error) {
    return `Failed to get system information: ${error}`
  }
}

// Helper function to get detailed container information
async function getContainerDetails(containerId: string): Promise<string> {
  try {
    const inspectOutput = await runDockerCommand([
      'container',
      'inspect',
      containerId
    ])

    // Parse the container inspection output
    const containerInfo = JSON.parse(inspectOutput)[0]

    // Create a sanitized version for logging (remove sensitive data)
    const sanitizedInfo = JSON.parse(JSON.stringify(containerInfo))

    // Mask potentially sensitive environment variables
    if (sanitizedInfo.Config?.Env) {
      sanitizedInfo.Config.Env = sanitizedInfo.Config.Env.map((env: string) => {
        const [key] = env.split('=')
        if (
          key.includes('TOKEN') ||
          key.includes('SECRET') ||
          key.includes('KEY') ||
          key.includes('PASSWORD')
        ) {
          return `${key}=***REDACTED***`
        }
        return env
      })
    }

    return JSON.stringify(sanitizedInfo, null, 2)
  } catch (error) {
    return `Failed to inspect container: ${error}`
  }
}

export async function prepareJob(
  args: PrepareJobArgs,
  responseFile
): Promise<void> {
  // Print diagnostic system information before starting
  try {
    core.info('==== RUNNER DIAGNOSTICS ====')
    const systemInfo = await getSystemInfo()
    core.info(systemInfo)
    core.info('=============================')
  } catch (diagnosticErr) {
    core.warning(`Failed to get diagnostic information: ${diagnosticErr}`)
  }

  await containerPrune()
  await networkPrune()

  const container = args.container
  const services = args.services

  if (!container?.image && !services?.length) {
    core.info('No containers exist, skipping hook invocation')
    exit(0)
  }
  const networkName = generateNetworkName()
  // Create network
  await networkCreate(networkName)

  // Log container configuration before creating
  if (container?.image) {
    core.info('==== JOB CONTAINER CONFIGURATION ====')
    core.info(`Image: ${container.image}`)
    if (container.entryPointArgs) {
      core.info(`EntryPoint Args: ${container.entryPointArgs.join(' ')}`)
    }
    if (container.environmentVariables) {
      core.info('Environment Variables:')
      for (const [key, value] of Object.entries(
        container.environmentVariables
      )) {
        // Mask sensitive values
        let displayValue = value
        if (
          key.includes('TOKEN') ||
          key.includes('SECRET') ||
          key.includes('KEY') ||
          key.includes('PASSWORD')
        ) {
          displayValue = '***REDACTED***'
        }
        core.info(`  ${key}=${displayValue}`)
      }
    }
    if (container.createOptions) {
      core.info(`Create Options: ${container.createOptions}`)
    }
    if (container.portMappings && container.portMappings.length > 0) {
      core.info(`Port Mappings: ${container.portMappings.join(', ')}`)
    }
    core.info('=====================================')
  }

  // Create Job Container
  let containerMetadata: ContainerMetadata | undefined = undefined
  if (!container?.image) {
    core.info('No job container provided, skipping')
  } else {
    setupContainer(container, true)

    const configLocation = await registryLogin(container.registry)
    try {
      await containerPull(container.image, configLocation)
    } finally {
      await registryLogout(configLocation)
    }

    containerMetadata = await createContainer(
      container,
      generateContainerName(container.image),
      networkName
    )
    if (!containerMetadata?.id) {
      throw new Error('Failed to create container')
    }
    await containerStart(containerMetadata?.id)

    // Log container details after creation
    try {
      core.info('==== CREATED CONTAINER DETAILS ====')
      const containerDetails = await getContainerDetails(containerMetadata.id)
      core.info(containerDetails)
      core.info('==================================')
    } catch (detailsError) {
      core.warning(`Failed to get container details: ${detailsError}`)
    }
  }

  // Create Service Containers
  const servicesMetadata: ContainerMetadata[] = []
  if (!services?.length) {
    core.info('No service containers provided, skipping')
  } else {
    for (const service of services) {
      // Log service container configuration
      core.info(`==== SERVICE CONTAINER: ${service.image} ====`)
      if (service.entryPointArgs) {
        core.info(`EntryPoint Args: ${service.entryPointArgs.join(' ')}`)
      }
      if (service.createOptions) {
        core.info(`Create Options: ${service.createOptions}`)
      }
      core.info('=====================================')

      const configLocation = await registryLogin(service.registry)
      try {
        await containerPull(service.image, configLocation)
      } finally {
        await registryLogout(configLocation)
      }

      setupContainer(service)
      const response = await createContainer(
        service,
        generateContainerName(service.image),
        networkName
      )

      servicesMetadata.push(response)
      await containerStart(response.id)

      // Log service container details after creation
      try {
        core.info(`==== CREATED SERVICE CONTAINER: ${service.image} ====`)
        const containerDetails = await getContainerDetails(response.id)
        core.info(containerDetails)
        core.info('============================================')
      } catch (detailsError) {
        core.warning(`Failed to get service container details: ${detailsError}`)
      }
    }
  }

  if (
    (container && !containerMetadata?.id) ||
    (services?.length && servicesMetadata.some(s => !s.id))
  ) {
    throw new Error(
      `Not all containers are started correctly ${
        containerMetadata?.id
      }, ${servicesMetadata.map(e => e.id).join(',')}`
    )
  }

  let isAlpine = false
  if (containerMetadata?.id) {
    isAlpine = await isContainerAlpine(containerMetadata.id)
  }

  if (containerMetadata?.id) {
    containerMetadata.ports = await containerPorts(containerMetadata.id)
  }
  if (servicesMetadata?.length) {
    for (const serviceMetadata of servicesMetadata) {
      serviceMetadata.ports = await containerPorts(serviceMetadata.id)
    }
  }

  const healthChecks: Promise<void>[] = []
  if (containerMetadata) {
    healthChecks.push(healthCheck(containerMetadata))
  }
  for (const service of servicesMetadata) {
    healthChecks.push(healthCheck(service))
  }
  try {
    await Promise.all(healthChecks)
    core.info('All services are healthy')
  } catch (error) {
    core.error(`Failed to initialize containers, ${error}`)
    throw new Error(`Failed to initialize containers, ${error}`)
  }

  generateResponseFile(
    responseFile,
    networkName,
    containerMetadata,
    servicesMetadata,
    isAlpine
  )
}

function generateResponseFile(
  responseFile: string,
  networkName: string,
  containerMetadata?: ContainerMetadata,
  servicesMetadata?: ContainerMetadata[],
  isAlpine = false
): void {
  const response = {
    state: { network: networkName },
    context: {},
    isAlpine
  }
  if (containerMetadata) {
    response.state['container'] = containerMetadata.id
    const contextMeta = JSON.parse(JSON.stringify(containerMetadata))
    if (containerMetadata.ports) {
      contextMeta.ports = transformDockerPortsToContextPorts(containerMetadata)
    }
    response.context['container'] = contextMeta

    if (containerMetadata.ports) {
      response.context['container'].ports =
        transformDockerPortsToContextPorts(containerMetadata)
    }
  }
  if (servicesMetadata && servicesMetadata.length > 0) {
    response.state['services'] = []
    response.context['services'] = []
    for (const meta of servicesMetadata) {
      response.state['services'].push(meta.id)
      const contextMeta = JSON.parse(JSON.stringify(meta))
      if (contextMeta.ports) {
        contextMeta.ports = transformDockerPortsToContextPorts(contextMeta)
      }
      response.context['services'].push(contextMeta)
    }
  }
  writeToResponseFile(responseFile, JSON.stringify(response))
}

function setupContainer(container, jobContainer = false): void {
  if (!container.entryPoint && jobContainer) {
    container.entryPointArgs = [`-f`, `/dev/null`]
    container.entryPoint = 'tail'
  }
}

function generateNetworkName(): string {
  return `github_network_${uuidv4()}`
}

function generateContainerName(container): string {
  const randomAlias = uuidv4().replace(/-/g, '')
  const randomSuffix = uuidv4().substring(0, 6)
  return `${randomAlias}_${sanitize(container.image)}_${randomSuffix}`
}

function transformDockerPortsToContextPorts(
  meta: ContainerMetadata
): ContextPorts {
  // ex: '80/tcp -> 0.0.0.0:80'
  const re = /^(\d+)(\/\w+)? -> (.*):(\d+)$/
  const contextPorts: ContextPorts = {}

  if (meta.ports?.length) {
    for (const port of meta.ports) {
      const matches = port.match(re)
      if (!matches) {
        throw new Error(
          'Container ports could not match the regex: "^(\\d+)(\\/\\w+)? -> (.*):(\\d+)$"'
        )
      }
      contextPorts[matches[1]] = matches[matches.length - 1]
    }
  }

  return contextPorts
}

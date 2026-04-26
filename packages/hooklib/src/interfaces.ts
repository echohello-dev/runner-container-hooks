export enum Command {
  PrepareJob = 'prepare_job',
  CleanupJob = 'cleanup_job',
  RunContainerStep = 'run_container_step',
  RunScriptStep = 'run_script_step'
}

/**
 * The data passed to the hook.
 */
export interface HookData {
  /**
   * The command to run.
   */
  command: Command

  /**
   * The path to the response file.
   */
  responseFile: string

  /**
   * The arguments for the command.
   */
  args?: PrepareJobArgs | RunContainerStepArgs | RunScriptStepArgs

  /**
   * The state of the job.
   */
  state?: { [key: string]: any }
}

/**
 * The data passed to the hook.
 */
export interface PrepareJobArgs {
  /**
   * The container to run the job in.
   */
  container?: JobContainerInfo

  /**
   * The services to run in the job.
   */
  services?: ServiceContainerInfo[]
}

export type RunContainerStepArgs = StepContainerInfo

/**
 * The arguments for a script step.
 * @example ```typescript
 * const args: RunScriptStepArgs = {
 *  entryPoint: 'echo',
 *  entryPointArgs: ['hello world'],
 *  environmentVariables: {
 *    'FOO': 'bar'
 *  },
 *  prependPath: ['/usr/bin'],
 *  workingDirectory: '/home/runner/work/my-repo/my-repo'
 * }
 * ```
 */
export interface RunScriptStepArgs {
  /**
   * The entry point for the script step.
   */
  entryPoint: string

  /**
   * The arguments for the entry point.
   */
  entryPointArgs: string[]

  /**
   * The environment variables for the script step.
   * @example ```typescript
   * {
   *  'FOO': 'bar'
   * }
   */
  environmentVariables?: { [key: string]: string }

  /**
   * The path to prepend to the PATH environment variable.
   */
  prependPath?: string[]

  /**
   * The working directory for the script step.
   */
  workingDirectory: string
}

/**
 * The arguments for a container step.
 * @example ```typescript
 * const args: RunContainerStepArgs = {
 *  image: 'ubuntu:latest',
 *  entryPoint: 'echo',
 *  entryPointArgs: ['hello world'],
 *  environmentVariables: {
 *   'FOO': 'bar'
 *  },
 *  prependPath: ['/usr/bin'],
 *  workingDirectory: '/home/runner/work/my-repo/my-repo'
 * }
 * ```
 */
export interface ContainerInfo {
  /**
   * The image to use for the container.
   * @example 'ubuntu:latest'
   */
  image?: string

  /**
   * The entry point for the container.
   */
  entryPoint?: string

  /**
   * The arguments for the entry point.
   */
  entryPointArgs?: string[]

  /**
   * The options to pass to the container.
   */
  createOptions?: string

  /**
   * The environment variables for the container.
   * @example ```typescript
   * {
   *  'FOO': 'bar'
   * }
   */
  environmentVariables?: { [key: string]: string }

  /**
   * The path to prepend to the PATH environment variable.
   */
  userMountVolumes?: Mount[]

  /**
   * The working directory for the container.
   */
  systemMountVolumes?: Mount[]

  /**
   * Registry information for the container.
   */
  registry?: Registry

  /**
   * The ports to expose on the container.
   * @example ['80:80', '443:443']
   */
  portMappings?: string[]
}

export interface ServiceContainerInfo extends ContainerInfo {
  contextName: string
  image: string
}

export interface JobContainerInfo extends ContainerInfo {
  image: string
  workingDirectory: string
  systemMountVolumes: Mount[]
}

export interface StepContainerInfo extends ContainerInfo {
  prependPath?: string[]
  workingDirectory: string
  dockerfile?: string
  systemMountVolumes: Mount[]
}

export interface Mount {
  sourceVolumePath: string
  targetVolumePath: string
  readOnly: boolean
}

export interface Registry {
  username?: string
  password?: string
  serverUrl: string
}

export enum Protocol {
  TCP = 'tcp',
  UDP = 'udp'
}

export interface PrepareJobResponse {
  state?: object
  context?: ContainerContext
  services?: { [key: string]: ContainerContext }
  alpine: boolean
}

export interface ContainerContext {
  id?: string
  network?: string
  ports?: { [key: string]: string }
}

export interface ContextPorts {
  [source: string]: string // source -> target
}

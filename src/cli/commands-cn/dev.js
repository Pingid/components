/*
 * CLI: Command: Dev
 */

const chokidar = require('chokidar')
const { ServerlessSDK, utils: tencentUtils } = require('@serverless/tencent-platform-client')
const utils = require('./utils')

/*
 * Deploy changes and hookup event callback which will be called when
 * deploying status has been changed.
 * @param sdk - instance of ServerlessSDK
 * @param instance - instance object
 * @param credentials - credentials used for deploy
 * @param enventCallback - event callback, when set to false, it will remove all event listener
 */
async function deploy(sdk, instance, credentials) {
  const getInstanceInfo = async () => {
    const { instance: instanceInfo } = await sdk.getInstance(
      instance.org,
      instance.stage,
      instance.app,
      instance.name
    )
    return instanceInfo
  }

  let instanceInfo = {}

  try {
    await sdk.deploy(instance, credentials)
    const instanceStatusPollingStartTime = new Date().getTime()
    instanceInfo = await getInstanceInfo()
    while (instanceInfo.instanceStatus === 'deploying') {
      instanceInfo = await getInstanceInfo()
      if (Date.now() - instanceStatusPollingStartTime > 24000) {
        throw new Error('Deployment timeout, please retry in a few seconds')
      }
    }
  } catch (e) {
    instanceInfo.instanceStatus = 'error'
    instanceInfo.deploymentError = e
  }

  return instanceInfo
}

async function updateDeploymentStatus(cli, instanceInfo, startDebug) {
  const { instanceStatus, instanceName, deploymentError, deploymentErrorStack } = instanceInfo
  const d = new Date()
  const header = `${d.toLocaleTimeString()} - ${instanceName} - deployment`

  switch (instanceStatus) {
    case 'active':
      const {
        state: { lambdaArn, region }
      } = instanceInfo
      if (lambdaArn && region) {
        await tencentUtils.stopTencentRemoteLogAndDebug(lambdaArn, region)
        if (startDebug) {
          await tencentUtils.startTencentRemoteLogAndDebug(lambdaArn, region)
        }
      }
      cli.log(header, 'grey')
      cli.logOutputs(instanceInfo.outputs)
      cli.status('Watching')
      return true
    case 'error':
      cli.log(`${header} error`, 'grey')
      cli.log(deploymentErrorStack || deploymentError, 'red')
      cli.status('Watching')
      break
    default:
      cli.log(`Deployment failed due to unknown deployment status: ${instanceStatus}`, 'red')
  }
  return false
}

module.exports = async (config, cli) => {
  // Define a close handler, that removes any "dev" mode agents
  const closeHandler = async () => {
    // Set new close listener
    process.on('SIGINT', () => {
      cli.close('error', 'Dev Mode Canceled.  Run "serverless deploy" To Remove Dev Mode Agent.')
    })

    cli.status('Disabling Dev Mode & Closing', null, 'green')
    const deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials)
    if (await updateDeploymentStatus(cli, deployedInstance, false)) {
      cli.close('success', 'Dev Mode Closed')
    }
  }

  // Start CLI persistance status
  cli.start('Initializing', { closeHandler })

  // Get access key
  const accessKey = await utils.getAccessKey()

  // Presentation
  cli.logLogo()
  cli.log(
    'Dev Mode - Watching your Component for changes and enabling streaming logs, if supported...',
    'grey'
  )
  cli.log()

  // Load serverless component instance.  Submit a directory where its config files should be.
  let instanceYaml = await utils.loadInstanceConfig(process.cwd(), config.target)

  // Load Instance Credentials
  const instanceCredentials = await utils.loadInstanceCredentials(instanceYaml.stage)

  const sdk = new ServerlessSDK({
    accessKey,
    context: {
      orgName: instanceYaml.org
    }
  })

  cli.status('Initializing', instanceYaml.name)

  // Filter configuration
  const filter = {
    stageName: instanceYaml.stage,
    appName: instanceYaml.app,
    instanceName: instanceYaml.name,
    events: []
  }

  // User wants to receive all messages at the app level
  if (config.filter && config.filter === 'app' && filter.instanceName) {
    delete filter.instanceName
    cli.log('Enabling filtering at the activity at the application level', 'grey')
    cli.log()
  }

  /**
   * Watch logic
   */

  let isProcessing = false // whether there's already a deployment in progress
  let queuedOperation = false // whether there's another deployment queued

  // Set watcher
  const watcher = chokidar.watch(process.cwd(), { ignored: /\.serverless/ })

  watcher.on('ready', async () => {
    cli.status('Enabling Dev Mode', null, 'green')
    const deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials)
    await updateDeploymentStatus(cli, deployedInstance, true)
  })

  watcher.on('change', async () => {
    // Skip if processing already and there is a queued operation
    if (isProcessing && queuedOperation) {
      return
    }

    // If already deploying and user made more changes, queue another deploy operation to be run after the first one
    if (isProcessing && !queuedOperation) {
      queuedOperation = true
      return
    }

    // If it's not processin and there is no queued operation
    if (!isProcessing) {
      let deployedInstance
      isProcessing = true
      cli.status('Deploying', null, 'green')
      // reload serverless component instance
      instanceYaml = await utils.loadInstanceConfig(process.cwd(), config.target)
      deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials)
      if (queuedOperation) {
        cli.status('Deploying', null, 'green')
        // reload serverless component instance
        instanceYaml = await utils.loadInstanceConfig(process.cwd(), config.target)
        deployedInstance = await deploy(sdk, instanceYaml, instanceCredentials)
      }

      await updateDeploymentStatus(cli, deployedInstance, true)
      isProcessing = false
      queuedOperation = false
    }
  })
}

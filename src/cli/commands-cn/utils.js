/*
 * Serverless Components: Utilities
 */

const path = require('path')
const fs = require('fs')
const dotenv = require('dotenv')
const { utils: platformUtils } = require('@serverless/tencent-platform-client')
const { fileExistsSync, readFileSync, resolveInputVariables } = require('../utils')

const initEnvs = (stage) => {
  let envVars = {}
  const defaultEnvFilePath = path.join(process.cwd(), `.env`)
  const stageEnvFilePath = path.join(process.cwd(), `.env.${stage}`)

  // Load environment variables via .env file
  if (stage && fileExistsSync(stageEnvFilePath)) {
    envVars = dotenv.config({ path: path.resolve(stageEnvFilePath) }).parsed || {}
  } else if (fileExistsSync(defaultEnvFilePath)) {
    envVars = dotenv.config({ path: path.resolve(defaultEnvFilePath) }).parsed || {}
  }
  return envVars
}

const updateEnvFile = (envs) => {
  // write env file
  const envFilePath = path.join(process.cwd(), '.env')

  let envFileContent = ''
  if (fs.existsSync(envFilePath)) {
    envFileContent = fs.readFileSync(envFilePath, 'utf8')
  }

  // update process.env and existing key in .env file
  for (let [key, value] of Object.entries(envs)) {
    process.env[key] = value
    const regex = new RegExp(`${key}=[^\n]+(\n|$)`)
    envFileContent = envFileContent.replace(regex, '')
  }

  fs.writeFileSync(
    envFilePath,
    `${envFileContent}\n${Object.entries(envs).reduce(
      (a, [key, value]) => (a += `${key}=${value}\n`),
      ''
    )}`
  )
}

const getDefaultOrgName = async () => {
  if (await isTencent()) {
    return await platformUtils.getOrgId()
  }

  return null
}

/**
 * Reads a serverless instance config file in a given directory path
 * @param {*} directoryPath
 */
const loadInstanceConfig = async (directoryPath, instanceConfName) => {
  directoryPath = path.resolve(directoryPath)
  let filePath
  let isYaml = false
  let instanceFile

  if (instanceConfName) {
    filePath = path.join(directoryPath, instanceConfName)
    isYaml = !instanceConfName.endsWith('.json')
  } else {
    const ymlFilePath = path.join(directoryPath, `serverless.yml`)
    const yamlFilePath = path.join(directoryPath, `serverless.yaml`)
    const jsonFilePath = path.join(directoryPath, `serverless.json`)

    // Check to see if exists and is yaml or json file
    if (fileExistsSync(ymlFilePath)) {
      filePath = ymlFilePath
      isYaml = true
    }
    if (fileExistsSync(yamlFilePath)) {
      filePath = yamlFilePath
      isYaml = true
    }
    if (fileExistsSync(jsonFilePath)) {
      filePath = jsonFilePath
    }
  }

  if (!filePath) {
    throw new Error(`serverless config file was not found`)
  }

  // Read file
  if (isYaml) {
    try {
      instanceFile = readFileSync(filePath)
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e
      }
    }
  } else {
    instanceFile = readFileSync(filePath)
  }

  if (!instanceFile.name) {
    throw new Error(`Missing "name" property in serverless.yml`)
  }

  if (!instanceFile.component) {
    throw new Error(`Missing "component" property in serverless.yml`)
  }

  // Set default stage
  if (!instanceFile.stage) {
    instanceFile.stage = 'dev'
  }

  if (!instanceFile.org) {
    instanceFile.org = await getDefaultOrgName()
  }

  if (!instanceFile.org) {
    throw new Error(`Missing "org" property in serverless.yml`)
  }

  if (!instanceFile.app) {
    instanceFile.app = instanceFile.name
  }

  if (instanceFile.inputs) {
    instanceFile.inputs = resolveInputVariables(instanceFile.inputs)
  }

  return instanceFile
}

/**
 * Check whether the user is logged in
 */
const isLoggedIn = () => {
  // China user doesn't need to login to serverless.com
  if (process.env.SERVERLESS_PLATFORM_VENDOR === 'tencent') {
    return true
  }

  return false
}

/**
 * Gets the logged in user's token id, or access key if its in env
 */
const getAccessKey = async () => {
  const isChinaUser = await isTencent()
  if (isChinaUser) {
    const [reLoggedIn, credentials] = await platformUtils.loginWithTencent()
    if (reLoggedIn) {
      const { secret_id, secret_key, appid, token } = credentials
      updateEnvFile({
        TENCENT_APP_ID: appid,
        TENCENT_SECRET_ID: secret_id,
        TENCENT_SECRET_KEY: secret_key,
        TENCENT_TOKEN: token
      })
    }
  }

  return null
}

/**
 * Load credentials from a ".env" or ".env.[stage]" file
 * @param {*} stage
 */
const loadInstanceCredentials = (stage) => {
  // Load env vars
  const envVars = initEnvs(stage)

  // Known Provider Environment Variables and their SDK configuration properties
  const providers = {}

  // Tencent
  providers.tencent = {}
  providers.tencent.TENCENT_APP_ID = 'AppId'
  providers.tencent.TENCENT_SECRET_ID = 'SecretId'
  providers.tencent.TENCENT_SECRET_KEY = 'SecretKey'
  providers.tencent.TENCENT_TOKEN = 'Token'

  const credentials = {}

  for (const provider in providers) {
    const providerEnvVars = providers[provider]
    for (const providerEnvVar in providerEnvVars) {
      if (!credentials[provider]) {
        credentials[provider] = {}
      }
      // Proper environment variables override what's in the .env file
      if (process.env.hasOwnProperty(providerEnvVar)) {
        credentials[provider][providerEnvVars[providerEnvVar]] = process.env[providerEnvVar]
      } else if (envVars.hasOwnProperty(providerEnvVar)) {
        credentials[provider][providerEnvVars[providerEnvVar]] = envVars[providerEnvVar]
      }
      continue
    }
  }

  return credentials
}

const isTencent = async () => {
  let isTencent = false
  initEnvs()
  const vendor = process.env.SERVERLESS_PLATFORM_VENDOR
  if (vendor === undefined || vendor === null) {
    const isChinaUser = await platformUtils.isChinaUser()
    if (isChinaUser) {
      isTencent = true
      updateEnvFile({
        SERVERLESS_PLATFORM_VENDOR: 'tencent'
      })
    }
  } else {
    isTencent = process.env.SERVERLESS_PLATFORM_VENDOR === 'tencent'
  }

  return isTencent
}

module.exports = {
  loadInstanceConfig,
  loadInstanceCredentials,
  getAccessKey,
  isLoggedIn,
  getDefaultOrgName,
  isTencent
}

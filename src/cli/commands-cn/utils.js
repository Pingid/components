/*
 * Serverless Components: Utilities
 */

const { contains, isNil, last, split, merge, endsWith } = require('ramda')
const path = require('path')
const fs = require('fs')
const axios = require('axios')
const globby = require('globby')
const AdmZip = require('adm-zip')
const fse = require('fs-extra')
const YAML = require('js-yaml')
const traverse = require('traverse')
const dotenv = require('dotenv')
const {
  readConfigFile,
  writeConfigFile,
  createAccessKeyForTenant,
  refreshToken,
  listTenants
} = require('@serverless/platform-sdk')
const { utils: platformUtils } = require('@serverless/tencent-platform-client')

/**
 * Wait for a number of miliseconds
 * @param {*} wait
 */
const sleep = async (wait) => new Promise((resolve) => setTimeout(() => resolve(), wait))

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

/**
 * Make HTTP API requests, easily
 * @param {*} options.endpoint
 * @param {*} options.data
 * @param {*} options.accessKey
 * @param {*} options.method
 */
const request = async (options) => {
  const requestOptions = {
    url: options.endpoint,
    method: options.method || 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    data: options.data
  }

  if (options.accessKey) {
    requestOptions.headers['authorization'] = `Bearer ${options.accessKey}`
  }

  let res
  try {
    res = await axios(requestOptions)
  } catch (error) {
    if (error.response && error.response.status && error.response.data.message) {
      throw new Error(`${error.response.status} - ${error.response.data.message}`)
    }
    throw error
  }
  return res.data
}

/**
 * Checks if a file exists
 * @param {*} filePath
 */
const fileExistsSync = (filePath) => {
  try {
    const stats = fse.lstatSync(filePath)
    return stats.isFile()
  } catch (e) {
    return false
  }
}

/**
 * Determines if a given file path is a YAML file
 * @param {*} filePath
 */
const isYamlPath = (filePath) => endsWith('.yml', filePath) || endsWith('.yaml', filePath)

/**
 * Determines if a given file path is a JSON file
 * @param {*} filePath
 */
const isJsonPath = (filePath) => endsWith('.json', filePath)

/**
 * Reads a file on the file system
 * @param {*} filePath
 * @param {*} options
 */
const readFileSync = (filePath, options = {}) => {
  if (!fileExistsSync(filePath)) {
    throw new Error(`File does not exist at this path ${filePath}`)
  }

  const contents = fse.readFileSync(filePath, 'utf8')
  if (isJsonPath(filePath)) {
    return JSON.parse(contents)
  } else if (isYamlPath(filePath)) {
    return YAML.load(contents.toString(), merge(options, { filename: filePath }))
  } else if (filePath.endsWith('.slsignore')) {
    return contents.toString().split('\n')
  }
  return contents.toString().trim()
}

const getDefaultOrgName = async () => {
  if (await isTencent()) {
    return await platformUtils.getOrgId()
  }

  return null
}

/**
 * Resolves any variables that require resolving before the engine.
 * This currently supports only ${env}.  All others should be resolved within the deployment engine.
 * @param {*} inputs
 */
const resolveInputVariables = (inputs) => {
  const regex = /\${(\w*:?[\w\d.-]+)}/g
  let variableResolved = false
  const resolvedInputs = traverse(inputs).forEach(function(value) {
    const matches = typeof value === 'string' ? value.match(regex) : null
    if (matches) {
      let newValue = value
      for (const match of matches) {
        // Search for ${env:}
        if (/\${env:(\w*[\w.-_]+)}/g.test(match)) {
          const referencedPropertyPath = match.substring(2, match.length - 1).split(':')
          newValue = process.env[referencedPropertyPath[1]]
          variableResolved = true
          if (match === value) {
            newValue = process.env[referencedPropertyPath[1]]
          } else {
            newValue = value.replace(match, process.env[referencedPropertyPath[1]])
          }
        }
      }
      this.update(newValue)
    }
  })
  if (variableResolved) {
    return resolveInputVariables(resolvedInputs)
  }
  return resolvedInputs
}

/**
 * Reads a serverless instance config file in a given directory path
 * @param {*} directoryPath
 */
const loadInstanceConfig = async (directoryPath) => {
  directoryPath = path.resolve(directoryPath)
  const ymlFilePath = path.join(directoryPath, `serverless.yml`)
  const yamlFilePath = path.join(directoryPath, `serverless.yaml`)
  const jsonFilePath = path.join(directoryPath, `serverless.json`)
  let filePath
  let isYaml = false
  let instanceFile

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
 * Reads a serverless component config file in a given directory path
 * @param {*} directoryPath
 */
const loadComponentConfig = (directoryPath) => {
  directoryPath = path.resolve(directoryPath)
  const ymlFilePath = path.join(directoryPath, `serverless.component.yml`)
  const yamlFilePath = path.join(directoryPath, `serverless.component.yaml`)
  const jsonFilePath = path.join(directoryPath, `serverless.component.json`)
  let filePath
  let isYaml = false
  let componentFile

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
  if (!filePath) {
    throw new Error(
      `The serverless.component file could not be found in the current working directory.`
    )
  }

  // Read file
  if (isYaml) {
    try {
      componentFile = readFileSync(filePath)
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e
      }
    }
  } else {
    componentFile = readFileSync(filePath)
  }

  return componentFile
}

const getDirSize = async (p) => {
  return fse.stat(p).then((stat) => {
    if (stat.isFile()) {
      return stat.size
    } else if (stat.isDirectory()) {
      return fse
        .readdir(p)
        .then((entries) => Promise.all(entries.map((e) => getDirSize(path.join(p, e)))))
        .then((e) => e.reduce((a, c) => a + c, 0))
    }
    return 0 // can't take size of a stream/symlink/socket/etc
  })
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
 * Package files into a zip
 * @param {*} inputDirPath
 * @param {*} outputFilePath
 * @param {*} include
 * @param {*} exclude
 */
const pack = async (inputDirPath, outputFilePath, include = [], exclude = []) => {
  const format = last(split('.', outputFilePath))

  if (!contains(format, ['zip', 'tar'])) {
    throw new Error('Please provide a valid format. Either a "zip" or a "tar"')
  }

  const patterns = ['**']

  if (!isNil(exclude)) {
    exclude.forEach((excludedItem) => patterns.push(`!${excludedItem}`))
  }

  const zip = new AdmZip()

  const files = (await globby(patterns, { cwd: inputDirPath })).sort()

  if (files.length === 0) {
    throw new Error(`The provided directory is empty and cannot be packaged`)
  }

  files.map((file) => {
    if (file === path.basename(file)) {
      zip.addLocalFile(path.join(inputDirPath, file))
    } else {
      zip.addLocalFile(path.join(inputDirPath, file), path.dirname(file))
    }
  })

  if (include && include.length) {
    include.forEach((filePath) => zip.addLocalFile(path.resolve(filePath)))
  }

  zip.writeZip(outputFilePath)

  return outputFilePath
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

  // AWS
  providers.aws = {}
  providers.aws.AWS_ACCESS_KEY_ID = 'accessKeyId'
  providers.aws.AWS_SECRET_ACCESS_KEY = 'secretAccessKey'
  providers.aws.AWS_REGION = 'region'

  // Google
  providers.google = {}
  providers.google.GOOGLE_APPLICATION_CREDENTIALS = 'applicationCredentials'
  providers.google.GOOGLE_PROJECT_ID = 'projectId'
  providers.google.GOOGLE_CLIENT_EMAIL = 'clientEmail'
  providers.google.GOOGLE_PRIVATE_KEY = 'privateKey'

  // Tencent
  providers.tencent = {}
  providers.tencent.TENCENT_APP_ID = 'AppId'
  providers.tencent.TENCENT_SECRET_ID = 'SecretId'
  providers.tencent.TENCENT_SECRET_KEY = 'SecretKey'
  providers.tencent.TENCENT_TOKEN = 'Token'

  // Docker
  providers.docker = {}
  providers.docker.DOCKER_USERNAME = 'username'
  providers.docker.DOCKER_PASSWORD = 'password'

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

const getInstanceDashboardUrl = (instanceYaml) => {
  let dashboardRoot = `https://dashboard.serverless.com`
  if (process.env.SERVERLESS_PLATFORM_STAGE === 'dev') {
    dashboardRoot = `https://dashboard.serverless-dev.com`
  }

  const dashboardUrl = `${dashboardRoot}/tenants/${instanceYaml.org}/applications/${instanceYaml.app}/component/${instanceYaml.name}/stage/${instanceYaml.stage}/overview`

  return dashboardUrl
}

/**
 * THIS IS USED BY SFV1.  DO NOT MODIFY OR DELETE
 */
const legacyLoadInstanceConfig = (directoryPath) => {
  directoryPath = path.resolve(directoryPath)
  const ymlFilePath = path.join(directoryPath, `serverless.yml`)
  const yamlFilePath = path.join(directoryPath, `serverless.yaml`)
  const jsonFilePath = path.join(directoryPath, `serverless.json`)
  let filePath
  let isYaml = false
  let instanceFile

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

  if (!filePath) {
    throw new Error(`The following file could not be found: ${filePath}`)
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

  return instanceFile
}

/**
 * THIS IS USED BY SFV1.  DO NOT MODIFY OR DELETE
 */
const legacyLoadComponentConfig = (directoryPath) => {
  directoryPath = path.resolve(directoryPath)
  const ymlFilePath = path.join(directoryPath, `serverless.component.yml`)
  const yamlFilePath = path.join(directoryPath, `serverless.component.yaml`)
  const jsonFilePath = path.join(directoryPath, `serverless.component.json`)
  let filePath
  let isYaml = false
  let componentFile

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
  if (!filePath) {
    throw new Error(
      `The serverless.component file could not be found in the current working directory.`
    )
  }

  // Read file
  if (isYaml) {
    try {
      componentFile = readFileSync(filePath)
    } catch (e) {
      // todo currently our YAML parser does not support
      // CF schema (!Ref for example). So we silent that error
      // because the framework can deal with that
      if (e.name !== 'YAMLException') {
        throw e
      }
    }
  } else {
    componentFile = readFileSync(filePath)
  }

  return componentFile
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
  sleep,
  request,
  fileExistsSync,
  readFileSync,
  isYamlPath,
  isJsonPath,
  loadComponentConfig,
  loadInstanceConfig,
  loadInstanceCredentials,
  resolveInputVariables,
  getDirSize,
  getAccessKey,
  pack,
  isLoggedIn,
  getInstanceDashboardUrl,
  getDefaultOrgName,
  legacyLoadComponentConfig,
  legacyLoadInstanceConfig,
  isTencent
}
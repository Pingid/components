/*
 * CLI: Command: CREATE
 */

const { isLoggedIn } = require('./utils')
const { existsSync, copySync } = require('fs-extra')
const path = require('path')

module.exports = async (config, cli) => {
  // Start CLI persistance status
  cli.start('Initializing', { timer: false })

  // Ensure the user is logged in, or advertise
  if (!isLoggedIn()) {
    cli.advertise()
  }

  // Presentation
  cli.logLogo()
  cli.log()

  const templatesDir = path.join(__dirname, '..', '..', '..', 'templates')
  const templateName = config.t || config.template
  const templatePath = path.join(templatesDir, templateName)
  const destinationPath = process.cwd()

  cli.status('Creating', templateName)

  // throw error if invalid template
  if (!existsSync(templatePath)) {
    throw new Error(`Template "${templateName}" does not exist.`)
  }

  // copy template content
  copySync(templatePath, destinationPath)

  cli.log(`- Successfully created "${templateName}" instance in the currennt working directory.`)

  cli.log(`- Don't forget to update serverless.yml and install dependencies if needed.`)

  cli.log(`- Whenever you're ready, run "serverless deploy" to deploy your new instance.`)

  cli.close('success', 'Created')
}

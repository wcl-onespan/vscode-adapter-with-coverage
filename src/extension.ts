import { type ExtensionContext, commands, window, workspace, Disposable, WorkspaceConfiguration, Extension } from 'vscode'
import {
	waitForPowerShellExtension,
	PowerShellExtensionClient,
	IPowerShellExtensionClient
} from './powershellExtensionClient'
import { watchWorkspace } from './workspaceWatcher'
import log, { VSCodeLogOutputChannelTransport } from './log'
import { spawn } from 'child_process';
import { existsSync, mkdirSync, PathLike, readFileSync, writeFileSync } from 'fs';
import { join, basename } from 'path';

export async function activate(context: ExtensionContext) {

	log.attachTransport(new VSCodeLogOutputChannelTransport('Pester').transport)

	subscriptions = context.subscriptions

	// PowerShell extension is a prerequisite
	const powershellExtension = await waitForPowerShellExtension()
	pesterExtensionContext = {
		extensionContext: context,
		powerShellExtension: powershellExtension,
		powershellExtensionPesterConfig: PowerShellExtensionClient.GetPesterSettings()
	}

	promptForPSLegacyCodeLensDisable()

	await watchWorkspace()

	// TODO: Rig this up for multiple workspaces
	// const stopPowerShellCommand = commands.registerCommand('pester.stopPowershell', () => {
	// 	if (controller.stopPowerShell()) {
	// 		void window.showInformationMessage('PowerShell background process stopped.')
	// 	} else {
	// 		void window.showWarningMessage('No PowerShell background process was running !')
	// 	}
	// })

	// context.subscriptions.push(
	// 	controller,
	// 	stopPowerShellCommand,
	// )
	const runCoverageReportCommand = commands.registerCommand('pester.runCoverageReport', () => {
		runPesterCoverageReport()
	})
	context.subscriptions.push(runCoverageReportCommand)
}

/** Register a Disposable with the extension so that it can be cleaned up if the extension is disabled */
export function registerDisposable(disposable: Disposable) {
	if (subscriptions == undefined) {
		throw new Error('registerDisposable called before activate. This should never happen and is a bug.')
	}
	subscriptions.push(disposable)
}

export function registerDisposables(disposables: Disposable[]) {
	subscriptions.push(Disposable.from(...disposables))
}

let subscriptions: Disposable[]

type PesterExtensionContext = {
	extensionContext: ExtensionContext
	powerShellExtension: Extension<IPowerShellExtensionClient>
	powershellExtensionPesterConfig: WorkspaceConfiguration
}

/** Get the activated extension context */
export function getPesterExtensionContext() {
	if (pesterExtensionContext == undefined) {
		throw new Error('Pester Extension Context attempted to be fetched before activation. This should never happen and is a bug')
	}

	return pesterExtensionContext
}
let pesterExtensionContext: PesterExtensionContext

function promptForPSLegacyCodeLensDisable() {
	// Disable PowerShell codelens setting if present
	const powershellExtensionConfig = PowerShellExtensionClient.GetPesterSettings()

	const psExtensionCodeLensSetting: boolean = powershellExtensionConfig.codeLens

	const suppressCodeLensNotice = workspace.getConfiguration('pester').get<boolean>('suppressCodeLensNotice') ?? false

	if (psExtensionCodeLensSetting && !suppressCodeLensNotice) {
		void window.showInformationMessage(
			'The Pester Tests extension recommends disabling the built-in PowerShell Pester CodeLens. Would you like to do this?',
			'Yes',
			'Workspace Only',
			'No',
			'Dont Ask Again'
		).then(async response => {
			switch (response) {
				case 'No': {
					return
				}
				case 'Yes': {
					await powershellExtensionConfig.update('codeLens', false, true)
					break
				}
				case 'Workspace Only': {
					await powershellExtensionConfig.update('codeLens', false, false)
					break
				}
				case 'Dont Ask Again': {
					await workspace.getConfiguration('pester').update('suppressCodeLensNotice', true, true)
					break
				}
			}
		})
	}

}

function runPesterCoverageReport() {
	log.info('Starting Pester coverage report...');

	const pesterConfig = getPesterExtensionContext().powershellExtensionPesterConfig;

	// Ensure workingDirectory is valid
	let workingDirectory: string | undefined = pesterConfig.get('workingDirectory');
	// If not explicitly set, use the first workspace folder as the default
  if (!workingDirectory) {
    workingDirectory = workspace.workspaceFolders?.[0]?.uri.fsPath;
    log.info(`Using workspace folder as the working directory: ${workingDirectory}`);
  } else {
    log.info(`Using configured working directory: ${workingDirectory}`);
  }
  if (!workingDirectory) {
    log.error('No valid working directory found.');
		window.showErrorMessage('No working directory found. Please configure "pester.workingDirectory" or open a workspace.');
		return;
	}
	if (typeof workingDirectory !== 'string') {
		window.showErrorMessage('Invalid working directory. Please configure "pester.workingDirectory" or open a valid workspace.');
		return;
	}

	// Ensure testFilePath is valid
	let testFilePath: string[] | undefined = pesterConfig.get('testFilePath');
	if (!testFilePath || !Array.isArray(testFilePath) || testFilePath.length === 0) {
		log.info('Using default test file path: "**/*.[tT]ests.[pP][sS]1"');
		testFilePath = ['**/*.[tT]ests.[pP][sS]1'];
	} else {
		log.info(`Using configured test file path(s): ${JSON.stringify(testFilePath)}`);
	}

	const safePath = `${(workingDirectory?.toString() || '').replace(/"/g, '""')}`
	// Convert the paths to properly formatted PowerShell path arguments
  const formattedPaths = testFilePath
    .map((path) => `'${safePath}/${path.replace(/'/g, "''")}'`)
    .join(', ');

	log.debug(`Formatted Paths for Pester: ${formattedPaths}`);

	// Get the coverage output path from configuration
  let coverageOutputPath: string | undefined = pesterConfig.get('coverageOutputPath');
	try {
    // Validate the path
    if (!coverageOutputPath || typeof coverageOutputPath !== 'string') {
			coverageOutputPath = join(workingDirectory, '/coverage/');
      log.info('Invalid or missing value for "pester.coverageOutputPath". Using default path.');
    }

    // Replace variable placeholder if needed
    if (coverageOutputPath.includes('${pester.workingDirectory}')) {
      if (!workingDirectory) {
        throw new Error('Unable to resolve "${pester.workingDirectory}". Please configure "pester.workingDirectory" or open a workspace.');
      }
      coverageOutputPath = coverageOutputPath.replace('${pester.workingDirectory}', workingDirectory);
    }

    // Ensure directory exists
    if (!existsSync(coverageOutputPath)) {
      log.info(`Creating coverage output directory at: ${coverageOutputPath}`);
      mkdirSync(coverageOutputPath, { recursive: true });
    }
  } catch (error) {
    log.error(`Error handling coverage output path: ${error instanceof Error ? error.message : error}`);
    window.showErrorMessage(`Failed to configure coverage output path: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const coverageOutputFile = join(coverageOutputPath, 'coverage.xml');
  log.info(`Coverage report will be saved to: ${coverageOutputFile}`);

	// Build the command to run the coverage report with Pester
	const args = [
    '-Command',
    `Invoke-Pester -Path @(${formattedPaths}) -CodeCoverage '${safePath}' -CodeCoverageOutputFile '${coverageOutputFile}'`
  ];
	log.info(`Executing command with spawn: pwsh ${args.join(' ')}`);

	window.showInformationMessage('Running Pester coverage report...');

	const child = spawn('pwsh', args, { shell: true });

	// Capture standard output and log it
  child.stdout.on('data', (data) => {
    const message = data.toString();
    log.info(message);
    // window.showInformationMessage(message); // Display to user in the UI if needed
  });

  // Capture standard error and log it
  child.stderr.on('data', (data) => {
    const message = data.toString();
    log.warn(message);
    // window.showWarningMessage(message); // Display warnings
  });

  // Handle process exit
  child.on('close', (code) => {
    if (code === 0) {
      log.info('Pester coverage report completed successfully.');
      window.showInformationMessage('Pester coverage report completed successfully.');
			// Patch the coverage XML file
			log.info(`Running workaround for VSCode Coverage support, Patching coverage XML file: ${coverageOutputFile}`);
			patchPesterCoverageXml(coverageOutputFile);

    } else {
      log.error(`Pester process exited with code ${code}`);
      window.showErrorMessage(`Pester coverage report failed with exit code ${code}`);
    }
  });

  // Handle errors during spawn
  child.on('error', (error) => {
    log.error('Error running Pester coverage report', { error });
    window.showErrorMessage(`Error running Pester coverage report: ${error.message}`);
  });
}

/**
 * Workaround for Pester coverage XML output
 * The Pester coverage XML output is not compatible with the PowerShell extension's coverage report viewer.
 * This function patches the XML file to make it compatible.
 * It replaces the package name and class names in the XML file.
 * @param xmlFilePath The path to the XML file to patch.
 * @returns  {Promise<void>} A promise that resolves when the patching is complete.
 * @throws {Error} If the XML file does not exist or cannot be read.
 */
function patchPesterCoverageXml(xmlFilePath: PathLike) {
  if (!existsSync(xmlFilePath)) {
    log.error(`File not found: ${xmlFilePath}`);
    return;
  }

  let xml = readFileSync(xmlFilePath, 'utf-8');

  // Replace package name
  xml = xml.replace(/<package\s+name="[^"]*"/, '<package name="."');

  // Replace class names
  xml = xml.replace(/<class\s+name="[^"]*"\s+filename="([^"]+)\.ps1"/g, (match, filename) => {
    const className = `${basename(filename)}`;
    return `<class name="${className}" filename="${filename}.ps1"`;
  });

  writeFileSync(xmlFilePath, xml, 'utf-8');
  log.info(`✅ Patched coverage XML: ${xmlFilePath}`);
	window.showInformationMessage(`Workaround for VSCode Coverage, Patched coverage XML: ${xmlFilePath}`);
}

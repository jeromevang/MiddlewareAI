#!/usr/bin/env node

/**
 * Discover LM Studio's built-in model registry
 */

const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function discoverModels() {
  try {
    console.log('🔍 Discovering LM Studio model registry...');

    // Run lms get with a timeout to capture the output
    const { stdout, stderr } = await execAsync('"lms" get --help', {
      timeout: 5000,
      killSignal: 'SIGTERM'
    });

    console.log('CLI Help Output:');
    console.log(stdout);

    // Try to get actual model list (this might hang, so we have a timeout)
    console.log('\n📋 Attempting to get model list...');

    try {
      const { stdout: modelOutput } = await execAsync('echo "qwen" | "lms" get -n 5', {
        timeout: 10000
      });

      console.log('Model List Output:');
      console.log(modelOutput);
    } catch (error) {
      console.log('Could not get interactive model list (expected in non-interactive mode)');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

if (require.main === module) {
  discoverModels().catch(console.error);
}

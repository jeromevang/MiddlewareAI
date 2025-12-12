#!/usr/bin/env node

const yargs = require('yargs');
const { hideBin } = require('yargs/helpers');
const { initializeLMStudio } = require('./lmstudio_manager.js');
const { runIndexer } = require('./indexer/indexer.js');

async function main(options = {}) {
    return runIndexer(options);
}

if (require.main === module) {
    const argv = yargs(hideBin(process.argv))
        .option('model-version', {
            alias: 'mv',
            type: 'string',
            description: 'LM Studio model version to use for embeddings and summaries'
        })
        .help(false)
        .version(false)
        .parse();

    (async () => {
        try {
            await initializeLMStudio();
            await main({ modelVersion: argv.modelVersion });
        } catch (err) {
            console.error('[Middleware] Execution failed:', err);
            process.exit(1);
        }
    })();
}

module.exports = { main };

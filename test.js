// Simple test file for verifying middleware functionality
const sampleContent = 'This is a test file. It contains sample code for testing purposes.';

export function testFunction() {
    return sampleContent;
}

// Additional lines to ensure chunking works as expected
for (let i = 0; i < 10; i++) {
    console.log(`Line ${i}: Testing middleware functionality.`);
}

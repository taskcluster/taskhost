#!/usr/bin/env node

const fs = require('fs');
const tweetnacl = require('tweetnacl');

function main() {
  console.log('Generating ed25519 keypair...');
  let keypair = tweetnacl.sign.keyPair();

  fs.writeFile('docker-worker-ed25519.pub', new Buffer.from(keypair.publicKey, "base64").toString(), function(err) {});
  return fs.writeFile('docker-worker-ed25519-signing-key.key', new Buffer.from(keypair.secretKey, "base64").toString(), function(err) {});
}

// can't do this b/c `TypeError: Cannot read property 'catch' of undefined`
// main().catch(err => console.log(err.stack));
main();

/**
 * Fake CLI/client to talk to the command-line server.
 *
 *
 */

import path from 'path';

import fs from 'fs';
import net from 'net';
import os from 'os';

const APP_NAME = 'rancher-desktop';
const portFile = path.join(os.homedir(), 'Library', 'Application Support', APP_NAME, '.rdCliPort');
const port = (() => {
  try {
    return parseInt(fs.readFileSync(portFile, { encoding: 'utf-8' }), 10);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`File ${ portFile } doesn't exist, can't talk to the server`);
      process.exit(1);
    }
  }
})();

const dataPieces = [];
let timeoutID;
const rawCommand = process.argv.slice(2);

function continueWithClient() {
  console.log('Waiting for more events...');
  timeoutID = setTimeout(continueWithClient, 1000);
}

function sendCommand(command) {
  const client = new net.Socket();

  console.log(`QQQ: -client.connect(port: ${ port }`);
  client.connect(port, '127.0.0.1', () => {
    console.log('connected...');
    client.write(command);
  });
  client.on('data', (data) => {
    // console.log(`Got data: ${ data }`);
    dataPieces.push(data.toString());
  });
  client.on('close', () => {
    console.log('Connection closed');
    // gotClose = true;
    clearTimeout(timeoutID);
    console.log(`Got back all data: ${ dataPieces.join('') }`);
    try {
      const result = JSON.parse(dataPieces.join(''));

      switch (result.status) {
      case 'error':
        console.log(`Error in command rawCommand.join(' '): `);
        /* eslint-disable-next-line no-fallthrough */
      case 'help':
      case 'true':
      case 'false':
        console.log(result.value);
      }
    } catch (e) {
      console.log(`Error showing ${ dataPieces.join('') }: `, e);
    }
  });
  client.on('error', (err) => {
    console.log(`Got an error: ${ err }`);
    process.exit(1);
  });
  timeoutID = setTimeout(continueWithClient, 1);
}
sendCommand(JSON.stringify(rawCommand));

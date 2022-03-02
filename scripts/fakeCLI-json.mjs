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

const argv = process.argv.slice(2);
let debug = false;
let jsonOutput = false;
while (argv.length > 0 && argv[0][0] === '-') {
  if (argv[0] === '-d') {
    debug = true;
    argv.shift();
  } else if (argv[0] === '-j') {
    jsonOutput = true;
    argv.shift();
  } else {
    break;
  }
}
const dataPieces = [];
let timeoutID;
const rawCommand = argv;
let cycles = 0;

function continueWithClient() {
  if (cycles > 1 && debug) {
    console.log('Waiting for more events...');
  }
  cycles += 1;
  timeoutID = setTimeout(continueWithClient, 1000);
}

function sendCommand(command) {
  const client = new net.Socket();

  client.connect(port, '127.0.0.1', () => {
    if (debug) {
      console.log(`QQQ: -client.connect(port: ${ port })`);
      console.log('connected...');
    }
    client.write(command);
  });
  client.on('data', (data) => {
    dataPieces.push(data.toString());
  });
  client.on('close', () => {
    clearTimeout(timeoutID);
    if (debug) {
      console.log('Connection closed');
      console.log(`Got back all data: ${ dataPieces.join('') }`);
    }
    try {
      const result = JSON.parse(dataPieces.join(''));

      switch (result.status) {
      case 'error':
        console.log(`Error in command ${ rawCommand.join(' ') }: `);
        /* eslint-disable-next-line no-fallthrough */
      case 'help':
      case 'updated':
      case true:
      case false:
        if (result.type === 'json' && jsonOutput) {
          try {
            console.log(JSON.stringify(JSON.parse(result.value), undefined, 4));
          } catch(err) {
            console.log(`Can't dump json: ${ err }`);
            console.log(result.value);
          }
        } else {
          console.log(result.value);
        }
        break;
      default:
        console.log(result);
      }
      if (result.status === 'help') {
        console.log('-j - output json');
        console.log('-d - debug/verbose mode');
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

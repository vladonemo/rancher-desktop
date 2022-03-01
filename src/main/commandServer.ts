/**
 * Server that handles requests from a custom CLI
 */

import fs from 'fs';
import net from 'net';
import path from 'path';

import Logging from '@/utils/logging';
import paths from '@/utils/paths';
import { Settings } from '@/config/settings';

type partialSettingsType = Record<string, string | boolean | number | any>;

type commandReturnType = Record<string, string|boolean|number>;

const console = Logging.commands;
const portFile = path.join(paths.appHome, '.rdCliPort');
const settingsFile = path.join(paths.config, 'settings.json');

class ShutdownError extends Error {
}

export interface CommandWorkerInterface {
  getK8sVersion: () => string;
  getK8sVersions: () => Promise<string[]>;
  setPref: (arg: Record<string, any>) => void;
  requestReset: () => void;
  requestResetAll: () => void;
  requestShutdown: () => void;
}

export class CommandServer {
  protected commandWorker: CommandWorkerInterface;
  protected commands: Record<string, [(arg?: string) => Promise<commandReturnType>, string?, RegExp?]> = {
    pref:          [this.doGetPref, 'pref NAME: returns status of setting X', /\w+/],
    'set-pref':    [this.doSetPref, 'set-pref NAME=VALUE: change setting NAME to VALUE: boolean|string|number', /\w+=.*/],
    prefs:         [this.doGetAllPrefs, 'prefs: returns a JSON hash of all the settings'],
    version:       [this.doGetVersion, 'version: get the current k8s version'],
    versions:      [this.doGetVersions, 'versions: aLl supported k8s versions'],
    'set-version': [this.doSetVersion, 'set-version VERSION: change to the specified k8s version', /.+/],
    reset:         [this.doReset, 'reset: Restart Kubernetes'],
    'reset-all':   [this.doResetAll, 'reset-all: Restart Kubernetes/VM, clear state'],
    shutdown:      [this.doShutDown, 'shutdown: Shut down the UI'],
    help:          [this.showHelp, 'help|-h|--help: Show this text'],
    '--help':      [this.showHelp],
    '-h':          [this.showHelp],
  };

  constructor(worker: CommandWorkerInterface) {
    this.commandWorker = worker;
  }

  start() {
    const server = net.createServer((conn) => {
      console.log(`Listening on ${ conn.localAddress }`);
      conn.on('data', async(command) => {
        console.log(`QQQ: got data ${ command }`);
        try {
          const result = await this.processCommand(command.toString());
          const jsonResult = JSON.stringify(result);

          conn.write(jsonResult);
          console.log(`Finished writing out ${ jsonResult.length } chars to conn`);
          conn.end();
          console.log(`Finished closing the connection`);
        } catch (e) {
          if (e instanceof ShutdownError) {
            conn.write(JSON.stringify({
              status:  true,
              value:  'shutting down...'
            }));
            console.log(`Finished writing out stuff to conn`);
            conn.end();
            console.log(`Finished closing the connection`);
            console.log(`Asked to quit`);
            server.close();
            fs.rmSync(portFile, { force: true });
            this.commandWorker.requestShutdown();
            console.log(`QQQ: We shouldn't be here!`);
          }
          console.log(`QQQ: server: Something bad happened: ${ e }`);
        }
      });
      conn.on('error', (error: any) => {
        if (error.code === 'ECONNRESET') {
          console.log('Ignoring ECONNRESET');

          return;
        }
        console.log(`cliServer: error happened: ${ error }`);
      });
      conn.on('end', () => {
        console.log(`bye bye`);
      });
    });

    if (!server) {
      console.error('Failed to create a local server to listen for commands.');

      return;
    }
    server.listen(0, async() => {
      const addr = server.address() as net.AddressInfo;
      const port = addr.port.toString();

      console.log(`Listening on port ${ port }`);
      await fs.promises.writeFile(portFile, port, {
        encoding: 'utf-8',
        mode:     0o600
      });
    });
    console.log(`QQQ: are we done listening now?  Server going to die?\n`);
  }

  async processCommand(payload: string): Promise<commandReturnType> {
    try {
      console.log(`*** Got payload ${ payload }`);
      const request: string[] = JSON.parse(payload);
      const commandName: string = (request.shift() as string);
      const command = this.commands[commandName];

      console.log(`QQQ: a command? ${ command ? 'yes' : 'no' }`);
      if (!command) {
        return await this.showHelp(`Command ${ commandName } not found`);
      }
      const arg = command[2];

      console.log(`QQQ: arg: ${ arg }`);
      if (arg) {
        if (request.length === 0) {
          return await this.showHelp(`Command ${ commandName }: missing argument`);
        } else if (!arg.test(request[0])) {
          return await this.showHelp(`Command ${ commandName }: invalid arg doesn't match ${ arg.toString() }`);
        }

        return await command[0].bind(this)(request[0]);
      } else if (request.length === 1) {
        return await this.showHelp(`Command ${ commandName } ${ request.join(' ') }: too many arguments`);
      } else {
        return await command[0].bind(this)();
      }
    } catch (e: any) {
      if (e instanceof ShutdownError) {
        throw e;
      }
      console.log(`QQQ: Something bad happened: ${ e }`, e);

      return {
        status:  'error',
        value:  e.toString
      };
    }
  }

  protected async showHelp(arg?: string): Promise<commandReturnType> {
    console.log(`QQQ: showHelp: arg: ${ arg }`);
    const prefix = arg ? `${ arg }:\n\n` : '';

    console.log(`QQQ: raw commands: `, this.commands);
    console.log(`QQQ: json commands: ${ JSON.stringify(this.commands) }`);
    const commandHelpText = Object.entries(this.commands)
      .filter(entry => entry[1][1])
      .map(entry => `${ entry[0] } - ${ entry[1][1] }`)
      .join('\n');

    console.log(`QQQ: commandHelpText: ${ commandHelpText }`);
    const helpText = `${ prefix }Command-line syntax:\n${ commandHelpText }`;

    console.log(`QQQ: helpText: ${ helpText }`);

    return await new Promise((resolve) => {
      return resolve({
        status:  'help',
        value:  helpText,
      });
    });
  }

  protected async doGetPref(arg?: string): Promise<commandReturnType> {
    const prefs = JSON.parse(await this.getRawSettings());
    const parts = (arg as string).split('.');
    const retval = parts.reduce((prev, curr) => prev[curr], prefs);

    console.log(`Raw setting value: ${ retval }, type: ${ typeof retval }`);

    return new Promise((resolve) => {
      resolve({
        status: true,
        type:   typeof (retval),
        value:  retval.toString(),
      });
    });
  }

  protected async doGetAllPrefs(): Promise<commandReturnType> {
    return {
      status: true,
      type:   'json',
      value:  await this.getRawSettings()
    };
  }

  protected async doSetPref(arg?: string): Promise<commandReturnType> {
    console.log(`doSetPref: arg: [${ (arg as string) }]`);
    const [pref, value] = (arg as string).split('=', 2);

    if (!value) {
      throw new Error('set-pref missing value after "="');
    }
    const finalValue = (() => {
      if (value === 'true') {
        return true;
      } else if (value === 'false') {
        return false;
      } else if (/^\d+$/.test(value)) {
        return parseInt(value, 10);
      } else {
        return value;
      }
    })();
    const parts = pref.split('.');
    const lastPart: string = parts.pop() as string;
    const prefs: Settings = JSON.parse(await this.getRawSettings());
    const parentPref: partialSettingsType = parts.reduce((prev: partialSettingsType, curr: string) => prev[curr], prefs);

    if (!(lastPart in parentPref)) {
      throw new Error(`set-pref: can't set pref ${ pref } because lastPart ${ lastPart } isn't in parent ${ JSON.stringify(parentPref) }`);
    }
    console.log(`QQQ: parentPref[lastPart]: ${ parentPref[lastPart] }, type: ${ typeof (parentPref[lastPart]) }`);
    switch (typeof parentPref[lastPart]) {
    case 'string':
    case 'number':
    case 'boolean':
      break;
    default:
      throw new Error(`set-pref: can't change pref ${ pref } because it doesn't point to a final value`);
    }

    parentPref[lastPart] = finalValue;

    const finalBlock: partialSettingsType = { [lastPart]: finalValue };

    parts.reverse();
    const block: partialSettingsType = parts.reduce((prev: partialSettingsType, curr: string) => {
      const h: partialSettingsType = {};

      h[curr] = prev;

      return h;
    }, finalBlock);

    this.commandWorker.setPref(block);

    // TODO: mainEvents.emit('settings-write-event', block);
    return {
      status:  'updated',
      type:    'json',
      value:  JSON.stringify(block),
    };
  }

  protected doGetVersion(): Promise<commandReturnType> {
    const version = this.commandWorker.getK8sVersion();

    return new Promise((resolve) => {
      resolve({
        status: true,
        type:   typeof (version),
        value:  version,
      });
    });
  }

  protected async doGetVersions(): Promise<commandReturnType> {
    return {
      status: true,
      type:   'json',
      value:  JSON.stringify(await this.commandWorker.getK8sVersions())
    };
  }

  protected async doSetVersion(arg?: string): Promise<commandReturnType> {
    return await this.doSetPref(`kubernetes.version=${ (arg as string) }`);
  }

  protected async doShutDown(): Promise<commandReturnType> {
    return await new Promise((resolve, reject) => {
      reject(new ShutdownError());
    });
  }

  protected async doReset(): Promise<commandReturnType> {
    this.commandWorker.requestReset();

    return await new Promise((resolve) => {
      resolve({
        status: true,
        value:  'restart requested'
      });
    });
  }

  protected async doResetAll(): Promise<commandReturnType> {
    this.commandWorker.requestResetAll();

    return await new Promise((resolve) => {
      resolve({
        status: true,
        value:  'restart-all requested'
      });
    });
  }

  protected async getRawSettings(): Promise<string> {
    return await fs.promises.readFile(settingsFile, { encoding: 'utf-8' });
  }
} // end class

import fs from 'fs';
import os from 'os';
import path from 'path';

import { expect } from '@playwright/test';
import * as childProcess from '../childProcess';
import { spawnFile } from '../childProcess';
import { Log } from '@/utils/logging';
import * as resources from '@/utils/resources';
import paths from '@/utils/paths';

function rdctlPath() {
  return path.join(process.cwd(), 'resources', os.platform(), 'bin', os.platform() === 'win32' ? 'rdctl.exe' : 'rdctl');
}

async function rdctl(commandArgs: string[]): Promise< { stdout: string, stderr: string, error?: any }> {
  try {
    return await spawnFile(rdctlPath(), commandArgs, { stdio: 'pipe' });
  } catch (err: any) {
    // console.log(`error running rdctl ${ commandArgs }: ${ err }`, err);

    return {
      stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', error: err
    };
  }
}

async function rdctlWithStdin(inputFile: string, commandArgs: string[]): Promise< { stdout: string, stderr: string, error?: any }> {
  let stream: fs.ReadStream | null = null;

  try {
    const fd = await fs.promises.open(inputFile, 'r');

    stream = fd.createReadStream();

    return await spawnFile(rdctlPath(), commandArgs, { stdio: [stream, 'pipe', 'pipe'] });
  } catch (err: any) {
    return {
      stdout: err?.stdout ?? '', stderr: err?.stderr ?? '', error: err
    };
  } finally {
    if (stream) {
      stream.close();
    }
  }
}

describe(childProcess.spawnFile, () => {
  function makeArg(fn: () => void) {
    return `--eval=(${ fn.toString() })();`;
  }

  test('returns output', async() => {
    const args = ['--version'];
    const result = await childProcess.spawnFile(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

    expect(result.stdout.trim()).toEqual(process.version);
    expect(result).not.toHaveProperty('stderr');
  });

  test('returns error', async() => {
    const args = [makeArg(() => console.error('hello'))];
    const result = await childProcess.spawnFile(process.execPath, args, { stdio: 'pipe' });

    expect(result.stdout).toEqual('');
    expect(result.stderr.trim()).toEqual('hello');
  });

  test('throws on failure', async() => {
    const args = [makeArg(() => {
      console.log('stdout');
      console.error('stderr');
      process.exit(1);
    })];
    const result = childProcess.spawnFile(process.execPath, args, { stdio: 'pipe' });

    await expect(result).rejects.toThrow('exited with code 1');
    await expect(result).rejects.toHaveProperty('stdout', 'stdout\n');
    await expect(result).rejects.toHaveProperty('stderr', 'stderr\n');
  });

  test('converts encodings on stdout', async() => {
    const args = [makeArg(() => console.log(Buffer.from('hello', 'utf16le').toString()))];
    const result = await childProcess.spawnFile(process.execPath, args, { stdio: 'pipe', encoding: 'utf16le' });

    expect(result.stdout.trim()).toEqual('hello');
  });

  test('converts encodings on stderr', async() => {
    const args = [makeArg(() => console.error(Buffer.from('hello', 'utf16le').toString()))];
    const result = await childProcess.spawnFile(process.execPath, args, { stdio: 'pipe', encoding: 'utf16le' });

    expect(result.stderr.trim()).toEqual('hello');
  });

  test('output to log', async() => {
    const workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rd-test-childprocess-'));
    let log: Log | undefined;

    try {
      log = new Log('childprocess-test', workdir);
      const args = [makeArg(() => {
        console.log('stdout'); console.error('stderr');
      })];
      const result = await childProcess.spawnFile(process.execPath, args, { stdio: log });

      expect(result).not.toHaveProperty('stdout');
      expect(result).not.toHaveProperty('stderr');

      const output = await fs.promises.readFile(log.path, 'utf-8');

      expect(output).toContain('stdout');
      expect(output).toContain('stderr');
    } finally {
      log?.stream?.close();
      await fs.promises.rm(workdir, { recursive: true, maxRetries: 3 });
    }
  });
});


let settingsFile = '';
let settingsBody = '';
let rdIsRunning = false;

describe('rdctl', () => {
  beforeAll(async() => {
    const { stdout } = await childProcess.spawnFile('/bin/sh', ['-c', 'ps auxww | grep lima/bin/qemu-system | grep -v -e grep || true'], { stdio: 'pipe' });
    const lines = stdout.toString().split('\n');

    rdIsRunning = lines.some(line => line.includes('lima/bin/qemu-system') );
    settingsFile = path.join(paths.config, 'settings.json');
    settingsBody = await fs.promises.readFile(settingsFile, { encoding: 'utf-8' });
    // console.log(`Set: rdIsRunning: ${ rdIsRunning }`);
  });
  describe('rdctl', () => {
    test('should show settings and nil-update settings', async() => {
      if (!rdIsRunning) {
        return;
      }
      const { stdout, stderr, error } = await rdctl(['list-settings']);

      expect(error).toBeUndefined();
      expect(stderr).toEqual('');
      expect(stdout).toMatch(/"kubernetes":/);
      const settings = JSON.parse(stdout);

      expect(['version', 'kubernetes', 'portForwarding', 'images', 'telemetry', 'updater', 'debug', 'pathManagementStrategy']).toMatchObject(Object.keys(settings));

      const args = ['set', '--container-engine', settings.kubernetes.containerEngine,
        `--kubernetes-enabled=${ !!settings.kubernetes.enabled }`,
        '--kubernetes-version', settings.kubernetes.version];
      const result = await rdctl(args);

      expect(result.stderr).toEqual('');
      expect(result.stdout).toContain('Status: no changes necessary.');
    });

    describe('set', () => {
      test('complains when no args are given', async() => {
        const { stdout, stderr, error } = await rdctl(['set']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: set command: no settings to change were given');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when option value missing', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--container-engine']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: flag needs an argument: --container-engine');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when non-boolean option value specified', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--kubernetes-enabled=gorb']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: invalid argument "gorb" for "--kubernetes-enabled" flag: strconv.ParseBool: parsing "gorb": invalid syntax');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when invalid engine specified', async() => {
        const myEngine = 'giblets';
        const { stdout, stderr, error } = await rdctl(['set', `--container-engine=${ myEngine }`]);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: errors in attempt to update settings:');
        expect(stderr).toContain(`Invalid value for kubernetes.containerEngine: <${ myEngine }>; must be 'containerd', 'docker', or 'moby'`);
        expect(stderr).not.toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when server rejects a proposed version', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--kubernetes-version=karl']);

        expect(error).toBeDefined();
        expect(stderr).toMatch(/Error: errors in attempt to update settings:\s+Kubernetes version "karl" not found./);
        expect(stderr).not.toContain('Usage:');
        expect(stdout).toEqual('');
      });
    });

    describe('all commands:', () => {
      describe('complains about unrecognized/extra arguments', () => {
        const badArgs = ['string', 'brucebean'];

        for (const cmd of ['set', 'list-settings', 'shutdown']) {
          const args = [cmd, ...badArgs];

          test(args.join(' '), async() => {
            const { stdout, stderr, error } = await rdctl(args);

            expect(error).toBeDefined();
            expect(stderr).toContain(`Error: ${ cmd } command: unrecognized command-line arguments specified: [${ badArgs.join(' ') }]`);
            expect(stderr).toContain('Usage:');
            expect(stdout).toEqual('');
          });
        }
      });

      describe('complains when unrecognized option are given', () => {
        for (const cmd of ['set', 'list-settings', 'shutdown']) {
          const args = [cmd, '--Awop-bop-a-loo-mop', 'zips', '--alop-bom-bom=cows'];

          test(args.join(' '), async() => {
            const { stdout, stderr, error } = await rdctl(args);

            expect(error).toBeDefined();
            expect(stderr).toContain(`Error: unknown flag: ${ args[1] }`);
            expect(stderr).toContain('Usage:');
            expect(stdout).toEqual('');
          });
        }
      });
    });

    describe('api:', () => {
      describe('all subcommands:', () => {
        test('complains when no args are given', async() => {
          const { stdout, stderr, error } = await rdctl(['api']);

          expect(error).toBeDefined();
          expect(stderr).toContain('Error: api command: no endpoint specified');
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });

        test('empty string endpoint should give an error message', async() => {
          const { stdout, stderr, error } = await rdctl(['api', '']);

          expect(error).toBeDefined();
          expect(stderr).toContain('Error: api command: no endpoint specified');
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });

        test('complains when more than one endpoint is given', async() => {
          const endpoints = ['settings', '/v0/settings'];
          const { stdout, stderr, error } = await rdctl(['api', ...endpoints]);

          expect(error).toBeDefined();
          expect(stderr).toContain(`Error: api command: too many endpoints specified ([${ endpoints.join(' ') }]); exactly one must be specified`);
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });
      });

      describe('settings:', () => {
        describe('options:', () => {
          describe('GET', () => {
            for (const endpoint of ['settings', '/v0/settings']) {
              for (const methodSpecs of [[], ['-X', 'GET'], ['--method', 'GET']]) {
                const args = ['api', endpoint, ...methodSpecs];

                test(args.join(' '), async() => {
                  const { stdout, stderr, error } = await rdctl(args);

                  expect(error).toBeUndefined();
                  expect(stderr).toEqual('');
                  const settings = JSON.parse(stdout);

                  expect(['version', 'kubernetes', 'portForwarding', 'images', 'telemetry', 'updater', 'debug', 'pathManagementStrategy']).toMatchObject(Object.keys(settings));
                });
              }
            }
          });

          describe('PUT', () => {
            describe('from stdin', () => {
              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpec of ['-X', '--method']) {
                  for (const inputSpec of [['--input', '-'], ['--input=-']]) {
                    const args = ['api', endpoint, methodSpec, 'PUT', ...inputSpec];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctlWithStdin(settingsFile, args);

                      expect(error).toBeUndefined();
                      expect(stderr).toBe('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });
            describe('--input', () => {
              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpecs of [['-X', 'PUT'], ['--method', 'PUT'], []]) {
                  for (const inputSource of [['--input', settingsFile], [`--input=${ settingsFile }`]]) {
                    const args = ['api', endpoint, ...methodSpecs, ...inputSource];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctl(args);

                      expect(error).toBeUndefined();
                      expect(stderr).toBe('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });

            test('should complain about a "--input-" flag', async() => {
              const { stdout, stderr, error } = await rdctl(['api', '/settings', '-X', 'PUT', '--input-']);

              expect(error).toBeDefined();
              expect(stdout).toEqual('');
              expect(stderr).toContain('Error: unknown flag: --input-');
            });

            describe('from body', async() => {
              const settingsFile = path.join(paths.config, 'settings.json');
              const settingsBody = await fs.promises.readFile(settingsFile, { encoding: 'utf-8' });

              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpecs of [[], ['-X', 'PUT'], ['--method', 'PUT']]) {
                  for (const inputOption of ['--body', '-b']) {
                    const args = ['api', endpoint, ...methodSpecs, inputOption, settingsBody];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctl(args);

                      expect(error).toBeUndefined();
                      expect(stderr).toEqual('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });

            describe('complains when body and input are both specified', () => {
              for (const bodyOption of ['--body', '-b']) {
                const args = ['api', 'settings', bodyOption, '{ "doctor": { "wu" : "tang" }}', '--input', 'mabels.farm'];

                test(args.join(' '), async() => {
                  const { stdout, stderr, error } = await rdctl(args);

                  expect(error).toBeDefined();
                  expect(stdout).toEqual('');
                  expect(stderr).toContain('Error: api command: --body and --input options cannot both be specified');
                  expect(stderr).toContain('Usage:');
                });
              }
            });
          });
        });

        test('invalid setting is specified', async() => {
          const newSettings = { kubernetes: { containerEngine: 'beefalo' } };
          const { stdout, stderr, error } = await rdctl(['api', 'settings', '-b', JSON.stringify(newSettings)]);

          expect(error).toBeDefined();
          expect(JSON.parse(stdout)).toEqual({ message: '400 Bad Request', documentation_url: null } );
          expect(stderr).not.toContain('Usage:');
          expect(stderr).toMatch(/errors in attempt to update settings:\s+Invalid value for kubernetes.containerEngine: <beefalo>; must be 'containerd', 'docker', or 'moby'/);
        });

        test('complains when no body is provided', async() => {
          const { stdout, stderr, error } = await rdctl(['api', 'settings', '-X', 'PUT']);

          expect(error).toBeDefined();
          expect(JSON.parse(stdout)).toEqual({ message: '400 Bad Request', documentation_url: null });
          expect(stderr).not.toContain('Usage:');
          expect(stderr).toContain('no settings specified in the request');
        });
      });

      test('complains on invalid endpoint', async() => {
        const endpoint = '/v99/no/such/endpoint';
        const { stdout, stderr, error } = await rdctl(['api', endpoint]);

        expect(error).toBeDefined();
        expect(JSON.parse(stdout)).toEqual({ message: '404 Not Found', documentation_url: null });
        expect(stderr).not.toContain('Usage:');
        expect(stderr).toContain(`Unknown command: GET ${ endpoint }`);
      });
    });

    test('should show settings and nil-update settings', async() => {
      const { stdout, stderr, error } = await rdctl(['list-settings']);

      expect(error).toBeUndefined();
      expect(stderr).toEqual('');
      expect(stdout).toMatch(/"kubernetes":/);
      const settings = JSON.parse(stdout);

      expect(['version', 'kubernetes', 'portForwarding', 'images', 'telemetry', 'updater', 'debug', 'pathManagementStrategy']).toMatchObject(Object.keys(settings));

      const args = ['set', '--container-engine', settings.kubernetes.containerEngine,
        `--kubernetes-enabled=${ !!settings.kubernetes.enabled }`,
        '--kubernetes-version', settings.kubernetes.version];
      const result = await rdctl(args);

      expect(result.stderr).toEqual('');
      expect(result.stdout).toContain('Status: no changes necessary.');
    });

    describe('set', () => {
      test('complains when no args are given', async() => {
        const { stdout, stderr, error } = await rdctl(['set']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: set command: no settings to change were given');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when option value missing', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--container-engine']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: flag needs an argument: --container-engine');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when non-boolean option value specified', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--kubernetes-enabled=gorb']);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: invalid argument "gorb" for "--kubernetes-enabled" flag: strconv.ParseBool: parsing "gorb": invalid syntax');
        expect(stderr).toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when invalid engine specified', async() => {
        const myEngine = 'giblets';
        const { stdout, stderr, error } = await rdctl(['set', `--container-engine=${ myEngine }`]);

        expect(error).toBeDefined();
        expect(stderr).toContain('Error: errors in attempt to update settings:');
        expect(stderr).toContain(`Invalid value for kubernetes.containerEngine: <${ myEngine }>; must be 'containerd', 'docker', or 'moby'`);
        expect(stderr).not.toContain('Usage:');
        expect(stdout).toEqual('');
      });

      test('complains when server rejects a proposed version', async() => {
        const { stdout, stderr, error } = await rdctl(['set', '--kubernetes-version=karl']);

        expect(error).toBeDefined();
        expect(stderr).toMatch(/Error: errors in attempt to update settings:\s+Kubernetes version "karl" not found./);
        expect(stderr).not.toContain('Usage:');
        expect(stdout).toEqual('');
      });
    });

    describe('all commands:', () => {
      describe('complains about unrecognized/extra arguments', () => {
        for (const cmd of ['set', 'list-settings', 'shutdown']) {
          const args = [cmd, 'string', 'brucebean'];

          test(args.join(' '), async() => {
            const { stdout, stderr, error } = await rdctl(args);

            expect(error).toBeDefined();
            expect(stderr).toContain(`Error: ${ cmd } command: unrecognized command-line arguments specified: [${ args.join(' ') }]`);
            expect(stderr).toContain('Usage:');
            expect(stdout).toEqual('');
          });
        }
      });

      describe('complains when unrecognized option are given', () => {
        for (const cmd of ['set', 'list-settings', 'shutdown']) {
          const args = [cmd, '--Awop-bop-a-loo-mop', 'zips', '--alop-bom-bom=cows'];

          test(args.join(' '), async() => {
            const { stdout, stderr, error } = await rdctl(args);

            expect(error).toBeDefined();
            expect(stderr).toContain(`Error: unknown flag: ${ args[1] }`);
            expect(stderr).toContain('Usage:');
            expect(stdout).toEqual('');
          });
        }
      });
    });

    describe('api:', () => {
      describe('all subcommands:', () => {
        test('complains when no args are given', async() => {
          const { stdout, stderr, error } = await rdctl(['api']);

          expect(error).toBeDefined();
          expect(stderr).toContain('Error: api command: no endpoint specified');
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });

        test('empty string endpoint should give an error message', async() => {
          const { stdout, stderr, error } = await rdctl(['api', '']);

          expect(error).toBeDefined();
          expect(stderr).toContain('Error: api command: no endpoint specified');
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });

        test('complains when more than one endpoint is given', async() => {
          const endpoints = ['settings', '/v0/settings'];
          const { stdout, stderr, error } = await rdctl(['api', ...endpoints]);

          expect(error).toBeDefined();
          expect(stderr).toContain(`Error: api command: too many endpoints specified ([${ endpoints.join(' ') }]); exactly one must be specified`);
          expect(stderr).toContain('Usage:');
          expect(stdout).toEqual('');
        });
      });

      describe('settings:', () => {
        describe('options:', () => {
          describe('GET', () => {
            for (const endpoint of ['settings', '/v0/settings']) {
              for (const methodSpecs of [[], ['-X', 'GET'], ['--method', 'GET']]) {
                const args = ['api', endpoint, ...methodSpecs];

                test(args.join(' '), async() => {
                  const { stdout, stderr, error } = await rdctl(args);

                  expect(error).toBeUndefined();
                  expect(stderr).toEqual('');
                  const settings = JSON.parse(stdout);

                  expect(['version', 'kubernetes', 'portForwarding', 'images', 'telemetry', 'updater', 'debug', 'pathManagementStrategy']).toMatchObject(Object.keys(settings));
                });
              }
            }
          });

          describe('PUT', () => {
            describe('from stdin', () => {
              const settingsFile = path.join(paths.config, 'settings.json');

              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpec of ['-X', '--method']) {
                  for (const inputSpec of [['--input', '-'], ['--input=-']]) {
                    const args = ['api', endpoint, methodSpec, 'PUT', ...inputSpec];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctlWithStdin(settingsFile, args);

                      expect(error).toBeUndefined();
                      expect(stderr).toBe('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });
            describe('--input', () => {
              const settingsFile = path.join(paths.config, 'settings.json');

              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpecs of [['-X', 'PUT'], ['--method', 'PUT'], []]) {
                  for (const inputSource of [['--input', settingsFile], [`--input=${ settingsFile }`]]) {
                    const args = ['api', endpoint, ...methodSpecs, '--input', ...inputSource];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctl(args);

                      expect(error).toBeUndefined();
                      expect(stderr).toBe('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });

            test('should complain about a "--input-" flag', async() => {
              const { stdout, stderr, error } = await rdctl(['api', '/settings', '-X', 'PUT', '--input-']);

              expect(error).toBeDefined();
              expect(stdout).toEqual('');
              expect(stderr).toContain('Error: unknown flag: --input-');
            });

            describe('from body', async() => {
              const settingsFile = path.join(paths.config, 'settings.json');
              const settingsBody = await fs.promises.readFile(settingsFile, { encoding: 'utf-8' });

              for (const endpoint of ['settings', '/v0/settings']) {
                for (const methodSpecs of [[], ['-X', 'PUT'], ['--method', 'PUT']]) {
                  for (const inputOption of ['--body', '-b']) {
                    const args = ['api', endpoint, ...methodSpecs, inputOption, settingsBody];

                    test(args.join(' '), async() => {
                      const { stdout, stderr, error } = await rdctl(args);

                      expect(error).toBeUndefined();
                      expect(stderr).toEqual('');
                      expect(stdout).toContain('no changes necessary');
                    });
                  }
                }
              }
            });

            describe('complains when body and input are both specified', () => {
              for (const bodyOption of ['--body', '-b']) {
                const args = ['api', 'settings', bodyOption, '{ "doctor": { "wu" : "tang" }}', '--input', 'mabels.farm'];

                test(args.join(' '), async() => {
                  const { stdout, stderr, error } = await rdctl(args);

                  expect(error).toBeDefined();
                  expect(stdout).toEqual('');
                  expect(stderr).toContain('Error: api command: --body and --input options cannot both be specified');
                  expect(stderr).toContain('Usage:');
                });
              }
            });
          });
        });

        test('invalid setting is specified', async() => {
          const newSettings = { kubernetes: { containerEngine: 'beefalo' } };
          const { stdout, stderr, error } = await rdctl(['api', 'settings', '-b', JSON.stringify(newSettings)]);

          expect(error).toBeDefined();
          expect(JSON.parse(stdout)).toEqual({ message: '400 Bad Request', documentation_url: null } );
          expect(stderr).not.toContain('Usage:');
          expect(stderr).toMatch(/errors in attempt to update settings:\s+Invalid value for kubernetes.containerEngine: <beefalo>; must be 'containerd', 'docker', or 'moby'/);
        });

        test('complains when no body is provided', async() => {
          const { stdout, stderr, error } = await rdctl(['api', 'settings', '-X', 'PUT']);

          expect(error).toBeDefined();
          expect(JSON.parse(stdout)).toEqual({ message: '400 Bad Request', documentation_url: null });
          expect(stderr).not.toContain('Usage:');
          expect(stderr).toContain('no settings specified in the request');
        });
      });

      test('complains on invalid endpoint', async() => {
        const endpoint = '/v99/no/such/endpoint';
        const { stdout, stderr, error } = await rdctl(['api', endpoint]);

        expect(error).toBeDefined();
        expect(JSON.parse(stdout)).toEqual({ message: '404 Not Found', documentation_url: null });
        expect(stderr).not.toContain('Usage:');
        expect(stderr).toContain(`Unknown command: GET ${ endpoint }`);
      });
    });
  });
});

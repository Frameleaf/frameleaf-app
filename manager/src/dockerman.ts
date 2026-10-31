import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Refusal } from './contracts.js';
import { publishFile } from './files.js';

export const UNRAID_ICON = 'https://raw.githubusercontent.com/Frameleaf/frameleaf-app/main/design/frameleaf/mark.png';
export const DOCKERMAN_TEMPLATES = '/run/frameleaf-host/templates-user';
const SERVICES = ['database', 'frameleaf-server', 'frameleaf-machine-learning'];
const LAN_DISCOVERY = 'frameleaf-lan-discovery';

type DockerManContainer = {
  Name: string;
  Config: {
    Image: string; Env: string[]; Labels: Record<string, string>; StopTimeout?: number;
    Healthcheck?: { Test: string[]; Interval?: number; Timeout?: number; StartPeriod?: number; StartInterval?: number; Retries?: number };
  };
  HostConfig: {
    RestartPolicy: { Name: string; MaximumRetryCount: number }; ShmSize?: number;
    Devices?: { PathOnHost: string; PathInContainer: string; CgroupPermissions: string }[];
    DeviceRequests?: { Driver: string; Count: number; DeviceIDs: string[] | null; Capabilities: string[][]; Options?: Record<string, string> }[];
    DeviceCgroupRules?: string[]; GroupAdd?: string[];
    PortBindings: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
  Mounts: { Type: string; Source?: string; Name?: string; Destination: string; RW: boolean; Propagation?: string }[];
  NetworkSettings: { Networks: Record<string, { Aliases?: string[] | null }> };
};
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('\r', '&#13;');
// DockerMan decodes entities again after SimpleXML, and collapses adjacent whitespace in its shell command.
const text = (value: string) => xml(xml(value));
const shell = (value: string) => value.split(/(\s)/).map((part) => "'" + part.replaceAll("'", "'\\''") + "'").join('');

/** Export the running configuration, including Compose identity, so either UI can recreate the same services. */
export function dockermanTemplate(container: DockerManContainer): string {
  const { Config: config, HostConfig: host } = container;
  const fields = (name: string, value: string) => `  <${name}>${text(value)}</${name}>`;
  const extra: string[] = [];
  const option = (name: string, value: string | number) => extra.push(`--${name}=${shell(String(value))}`);
  option('restart', host.RestartPolicy.Name + (host.RestartPolicy.MaximumRetryCount ? `:${host.RestartPolicy.MaximumRetryCount}` : ''));
  if (host.ShmSize) option('shm-size', host.ShmSize);
  if (config.StopTimeout !== undefined) option('stop-timeout', config.StopTimeout);
  const networks = Object.entries(container.NetworkSettings.Networks);
  if (networks.length > 1) {
    for (const [name, network] of networks) {
      if (![name, ...(network.Aliases ?? [])].every((value) => /^[a-z0-9_.-]+$/i.test(value)))
        throw new Refusal('dockerman_unsupported_network_alias');
      // DockerMan only recognises --network when its value is unquoted.
      extra.push('--network=' + [`name=${name}`, ...(network.Aliases ?? []).map((alias) => `alias=${alias}`)].join(','));
    }
  } else for (const alias of networks[0]?.[1].Aliases ?? []) option('network-alias', alias);
  for (const [key, value] of Object.entries(config.Labels)) {
    if (!key.startsWith('net.unraid.docker.')) option('label', `${key}=${value}`);
  }
  for (const mount of container.Mounts) {
    if (!['bind', 'volume'].includes(mount.Type)) throw new Refusal('dockerman_unsupported_mount');
    const source = mount.Type === 'volume' ? mount.Name : mount.Source;
    if (!source || /[,\n]/.test(source + mount.Destination)) throw new Refusal('dockerman_unsupported_mount');
    // --mount preserves missing-bind refusal and prevents Docker from populating existing media volumes.
    option('mount', `type=${mount.Type},source=${source},target=${mount.Destination}` +
      (mount.RW ? '' : ',readonly') + (mount.Type === 'volume' ? ',volume-nocopy' :
        mount.Propagation ? `,bind-propagation=${mount.Propagation}` : ''));
  }
  for (const [target, bindings] of Object.entries(host.PortBindings)) {
    for (const bind of bindings ?? []) {
      const address = bind.HostIp.includes(':') ? `[${bind.HostIp}]` : bind.HostIp;
      option('publish', `${address ? address + ':' : ''}${bind.HostPort}:${target}`);
    }
  }
  for (const device of host.Devices ?? []) option('device', `${device.PathOnHost}:${device.PathInContainer}:${device.CgroupPermissions}`);
  for (const rule of host.DeviceCgroupRules ?? []) option('device-cgroup-rule', rule);
  for (const group of host.GroupAdd ?? []) option('group-add', group);
  for (const request of host.DeviceRequests ?? []) {
    if (request.Driver !== 'nvidia' || Object.keys(request.Options ?? {}).length) throw new Refusal('dockerman_unsupported_gpu_request');
    const capabilities = [...new Set(request.Capabilities.flat())].join(',');
    option('gpus', `driver=nvidia,${request.DeviceIDs?.length ? `"device=${request.DeviceIDs.join(',')}"` : `count=${request.Count === -1 ? 'all' : request.Count}`},"capabilities=${capabilities}"`);
  }
  const health = config.Healthcheck;
  if (health?.Test[0] === 'NONE') extra.push('--no-healthcheck');
  else if (health?.Test.length) {
    option('health-cmd', health.Test[0] === 'CMD-SHELL' ? health.Test[1] : health.Test.slice(1).map(shell).join(' '));
    for (const [key, flag] of [['Interval', 'interval'], ['Timeout', 'timeout'], ['StartPeriod', 'start-period'], ['StartInterval', 'start-interval']] as const)
      if (health[key]) option(`health-${flag}`, `${health[key]}ns`);
    if (health.Retries) option('health-retries', health.Retries);
  }
  const environment = config.Env.flatMap((entry) => {
    const split = entry.indexOf('=');
    if (split < 1) throw new Refusal('dockerman_invalid_environment');
    const key = entry.slice(0, split), value = entry.slice(split + 1);
    if (!/^[a-z_][a-z0-9_]*$/i.test(key)) throw new Refusal('dockerman_invalid_environment');
    if (/\s\s|\r/.test(value)) { option('env', entry); return []; }
    return [`  <Config Name="${key}" Target="${key}" Default="" Mode="" Description="Container environment" Type="Variable" Display="advanced" Required="false" Mask="${/PASSWORD|TOKEN|SECRET|KEY/.test(key)}">${text(value)}</Config>`];
  });
  return ['<Container version="2">', fields('Name', container.Name.replace(/^\//, '')),
    fields('Repository', config.Image), fields('Network', networks[0]?.[0] ?? 'none'),
    fields('Privileged', 'false'),
    fields('Icon', UNRAID_ICON), fields('WebUI', config.Labels['net.unraid.docker.webui'] ?? ''),
    fields('Overview', 'Managed by Frameleaf Manager. Use Manager for coordinated upgrades, backup and recovery. Manager operations regenerate this template.'),
    fields('ExtraParams', extra.join(' ')), ...environment, '</Container>', ''].join('\n');
}

export async function saveDockermanTemplates(containers: DockerManContainer[], project: string, directory = DOCKERMAN_TEMPLATES): Promise<void> {
  if (!/^frameleaf-[a-f0-9]{12}$/.test(project)) throw new Refusal('dockerman_container_identity');
  // Validate the entire set before touching host templates; never overwrite an unrelated container.
  const templates = containers.flatMap((container) => {
    const service = container.Config.Labels['com.docker.compose.service'];
    const name = container.Name.replace(/^\//, '');
    if (container.Config.Labels['com.docker.compose.project'] !== project ||
      container.Config.Labels['app.frameleaf.manager'] !== project.slice('frameleaf-'.length) ||
      ![...SERVICES, LAN_DISCOVERY].includes(service) || name !== `${project}-${service}-1`)
      throw new Refusal('dockerman_container_identity');
    // The LAN companion's entrypoint, user, read-only root and host network do not survive a template; Manager owns it.
    return service === LAN_DISCOVERY ? [] : [[join(directory, `my-${name}.xml`), dockermanTemplate(container)]];
  });
  for (const [destination, body] of templates) {
    const temporary = `${destination}.partial`;
    await rm(temporary, { force: true });
    await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
    await publishFile(temporary, destination);
  }
  for (const service of SERVICES) {
    const path = join(directory, `my-${project}-${service}-1.xml`);
    if (!templates.some(([destination]) => destination === path)) await rm(path, { force: true });
  }
}

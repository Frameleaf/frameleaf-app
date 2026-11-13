#!/usr/bin/env python3
"""Bootstrap and qualify one disposable WordPress installation; no existing site is used."""
import argparse
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

TESTS = Path(__file__).resolve().parent
PROJECT = TESTS.parent
REPOSITORY = PROJECT.parents[1]
MARIADB = 'mariadb@sha256:d36f18d65a0459510b8b0f643b226a6d299e3206486e2b64ff20754a6d291707'
WORDPRESS = {
    '6.8': 'f7dbedc423ddb3f2f3e98e9140f1720bfd6d4a8f4873c85da2e62f6a078de10a',
    '7.1.4': '881e53a4681ff2cd911651b11cccdede5ae477ddf0765af5d6a1a8b219a1d835',
}
WPCLI_SHA256 = 'ce34ddd838f7351d6759068d09793f26755463b4a4610a5a5c0a97b68220d85c'


def database_endpoint(value):
    match = re.fullmatch(r'127\.0\.0\.1:([0-9]{1,5})', value)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise ValueError('The disposable database must be on 127.0.0.1 with an explicit port.')
    return '127.0.0.1', int(match[1])


def verify_sha256(path, expected):
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError('Downloaded artifact does not match its reviewed SHA-256: ' + path.name)


def download(root, name, url, expected, limit):
    path = root / name
    with urllib.request.urlopen(url, timeout=45) as response, path.open('wb') as output:
        total = 0
        while chunk := response.read(65536):
            total += len(chunk)
            if total > limit:
                raise ValueError('Download exceeded its bound: ' + name)
            output.write(chunk)
    verify_sha256(path, expected)
    return path


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def cleanup(root, processes, handles, php, env, db_created, container, keep, primary_error=None):
    """Attempt every owned cleanup, retaining a qualification error as the primary failure."""
    failures = []

    def attempt(label, operation):
        try:
            operation()
        except Exception as error:
            failures.append(f'{label} ({type(error).__name__})')

    def stop(child):
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=10)
        except ProcessLookupError:
            pass
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=5)

    def drop_database():
        result = subprocess.run(php + [str(root / 'database.php'), 'drop'], env=env, capture_output=True, timeout=15)
        if result.returncode:
            raise RuntimeError('Database cleanup returned nonzero')

    def remove_container():
        result = subprocess.run(['docker', 'rm', '-f', container], capture_output=True, text=True, timeout=30)
        if result.returncode and 'No such container' not in result.stderr:
            raise RuntimeError('Container cleanup returned nonzero')

    for child in reversed(processes):
        attempt('process ' + str(child.pid), lambda: stop(child))
    for handle in handles:
        attempt('log handle', handle.close)
    if db_created:
        attempt('database', drop_database)
    if container:
        attempt('container ' + container, remove_container)
    if keep:
        attempt('fixture report', lambda: print('Private fixture retained: ' + str(root), flush=True))
    else:
        attempt('fixture files', lambda: shutil.rmtree(root))
    if failures:
        message = 'Disposable cleanup failed: ' + ', '.join(failures)
        if primary_error is not None:
            primary_error.add_note(message)
        else:
            raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wordpress', choices=WORDPRESS, default='7.1.4')
    parser.add_argument('--keep', action='store_true', help='Keep the private fixture and logs after stopping all processes and dropping its database.')
    args = parser.parse_args()
    if os.name != 'posix':
        raise SystemExit('Qualification requires Linux or macOS PHP worker support.')
    for executable in ['php', 'node', 'openssl']:
        if not shutil.which(executable):
            raise SystemExit('Missing prerequisite: ' + executable)
    root = Path(tempfile.mkdtemp(prefix='frameleaf-wordpress-')).resolve()
    if root.is_relative_to(REPOSITORY):
        root.rmdir()
        raise SystemExit('Temporary fixtures must be outside the repository; change TMPDIR.')
    os.chmod(root, 0o700)
    env = dict(os.environ)
    web_port, provider_port, php_port = free_port(), free_port(), free_port()
    env.update(FRAMELEAF_FIXTURE_DIR=str(root), FRAMELEAF_FIXTURE_WEB_PORT=str(web_port),
               FRAMELEAF_FIXTURE_PROVIDER_PORT=str(provider_port), FRAMELEAF_FIXTURE_PHP_PORT=str(php_port),
               FRAMELEAF_FIXTURE_ORIGIN=f'https://localhost:{provider_port}',
               FRAMELEAF_PACKAGE_DIR=str(root / 'wordpress/wp-content/plugins/frameleaf-connect'),
               WP_CLI_CACHE_DIR=str(root / 'wp-cli-cache'), WP_CLI_CONFIG_PATH=str(root / 'empty-wp-cli.yml'),
               PHP_CLI_SERVER_WORKERS='6')
    (root / 'empty-wp-cli.yml').write_text('')
    processes, handles = [], []
    container, db_created = None, False

    def run(label, command, timeout=120):
        result = subprocess.run([str(x) for x in command], env=env, cwd=root, capture_output=True, text=True, timeout=timeout)
        (root / (label + '.log')).write_text(result.stdout + result.stderr)
        for line in result.stdout.splitlines():
            if line.startswith(('PASS ', 'Success:', 'Validated ', 'Created ')):
                print(line, flush=True)
        if result.returncode:
            print('\n'.join((result.stdout + result.stderr).splitlines()[-12:]), flush=True)
            raise RuntimeError(f'{label} failed; private diagnostic: {root / (label + ".log")}')
        return result.stdout.strip()

    def launch(label, command):
        handle = (root / (label + '.log')).open('w')
        handles.append(handle)
        child = subprocess.Popen([str(x) for x in command], env=env, cwd=root, stdout=handle, stderr=handle, start_new_session=True)
        processes.append(child)
        return child

    php = ['php', '-d', 'error_reporting=22527']
    wp = php + [root / 'wp-cli.phar', '--path=' + str(root / 'wordpress')]
    try:
        run('php-requirements', ['php', '-r', 'foreach(["mysqli","curl","openssl","gd","mbstring","dom"] as $e){if(!extension_loaded($e)){fwrite(STDERR,"Missing PHP extension: ".$e);exit(1);}}'])
        archive = download(root, 'wordpress.tar.gz', 'https://wordpress.org/wordpress-' + args.wordpress + '.tar.gz', WORDPRESS[args.wordpress], 45000000)
        download(root, 'wp-cli.phar', 'https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar', WPCLI_SHA256, 10000000)
        with tarfile.open(archive) as bundle:
            if len(bundle.getmembers()) > 12000 or sum(member.size for member in bundle.getmembers()) > 268435456:
                raise ValueError('WordPress archive expansion exceeded its bound')
            if any(not (member.isfile() or member.isdir()) or not (member.name.startswith('wordpress/') or member.name == 'wordpress' and member.isdir()) or '..' in Path(member.name).parts for member in bundle.getmembers()):
                raise ValueError('Unexpected WordPress archive entry')
            bundle.extractall(root, filter='data')
        run('official-core-checksums', wp + ['core', 'verify-checksums', '--version=' + args.wordpress, '--locale=en_US'])
        endpoint = env.get('FRAMELEAF_TEST_DB_HOST')
        password = env.get('FRAMELEAF_TEST_DB_PASSWORD') if endpoint else secrets.token_urlsafe(32)
        if not password:
            raise ValueError('FRAMELEAF_TEST_DB_PASSWORD is required for the isolated CI database service.')
        if not endpoint:
            container = 'frameleaf-i04-' + secrets.token_hex(6)
            (root / 'db.env').write_text('MARIADB_ROOT_PASSWORD=' + password + '\n')
            os.chmod(root / 'db.env', 0o600)
            run('database-start', ['docker', 'run', '--detach', '--rm', '--name', container, '--memory', '512m', '--cpus', '1',
                                  '--tmpfs', '/var/lib/mysql:rw,size=256m', '--env-file', root / 'db.env', '-p', '127.0.0.1::3306', MARIADB,
                                  '--innodb-buffer-pool-size=64M', '--max-connections=30', '--performance-schema=OFF'])
            endpoint = run('database-port', ['docker', 'port', container, '3306/tcp'])
        host, port = database_endpoint(endpoint)
        database = 'frameleaf_i04_' + secrets.token_hex(8)
        settings = {'host': host, 'port': port, 'user': 'root', 'password': password, 'database': database,
                    'wordpressUrl': f'https://localhost:{web_port}', 'providerUrl': env['FRAMELEAF_FIXTURE_ORIGIN']}
        (root / 'settings.json').write_text(json.dumps(settings))
        os.chmod(root / 'settings.json', 0o600)
        (root / 'database.php').write_text('''<?php
mysqli_report(MYSQLI_REPORT_OFF);$s=json_decode(file_get_contents(__DIR__.'/settings.json'),true);
if(!preg_match('/^frameleaf_i04_[a-f0-9]{16}$/D',$s['database']))exit(2);
$db=@new mysqli($s['host'],$s['user'],$s['password'],'',$s['port']);if($db->connect_errno)exit(1);
$verb=$argv[1]==='create'?'CREATE DATABASE ':'DROP DATABASE IF EXISTS ';
if(!$db->query($verb.'`'.$s['database'].'`'))exit(1);
''')
        deadline = time.monotonic() + 90
        while True:
            probe = subprocess.run(php + [str(root / 'database.php'), 'create'], env=env, capture_output=True)
            (root / 'database-probe.log').write_bytes(probe.stdout + probe.stderr)
            if probe.returncode == 0:
                db_created = True
                break
            if time.monotonic() >= deadline:
                if container:
                    diagnostic = subprocess.run(['docker', 'logs', '--tail', '40', container], capture_output=True, text=True)
                    (root / 'database-server.log').write_text(diagnostic.stdout + diagnostic.stderr)
                raise RuntimeError('Disposable database did not become ready.')
            time.sleep(0.5)
        (root / 'admin-password').write_text(secrets.token_urlsafe(32))
        os.chmod(root / 'admin-password', 0o600)
        config = "<?php\n$s=json_decode(file_get_contents(dirname(__DIR__).'/settings.json'),true);\n"
        config += "define('DB_NAME',$s['database']);define('DB_USER',$s['user']);define('DB_PASSWORD',$s['password']);define('DB_HOST',$s['host'].':'.$s['port']);define('DB_CHARSET','utf8mb4');define('DB_COLLATE','');\n"
        for key in ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT']:
            config += f"define('{key}','{secrets.token_urlsafe(64)}');\n"
        config += "define('WP_HOME',$s['wordpressUrl']);define('WP_SITEURL',WP_HOME);define('DISABLE_WP_CRON',true);define('WP_DEBUG',true);define('WP_DEBUG_DISPLAY',false);\n"
        config += "if(($_SERVER['REMOTE_ADDR']??'')==='127.0.0.1'&&($_SERVER['HTTP_X_FRAMELEAF_FIXTURE_TLS']??'')==='1')$_SERVER['HTTPS']='on';\n$table_prefix='wp_';if(!defined('ABSPATH'))define('ABSPATH',__DIR__.'/');require_once ABSPATH.'wp-settings.php';\n"
        (root / 'wordpress/wp-config.php').write_text(config)
        os.chmod(root / 'wordpress/wp-config.php', 0o600)
        mu = root / 'wordpress/wp-content/mu-plugins'
        mu.mkdir(exist_ok=True)
        shutil.copyfile(TESTS / 'mu-fixture.php', mu / 'frameleaf-fixture.php')
        run('package', ['python3', PROJECT / 'scripts/package.py', '--output', root / 'frameleaf-connect.zip'])
        with zipfile.ZipFile(root / 'frameleaf-connect.zip') as package:
            package.extractall(root / 'wordpress/wp-content/plugins')
        run('install', php + [TESTS / 'install.php'])
        certs = root / 'certs'
        certs.mkdir()
        run('ca', ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', certs / 'ca.key', '-out', certs / 'ca.pem', '-days', '2', '-subj', '/CN=Frameleaf disposable qualification CA'])
        run('certificate-request', ['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', certs / 'server.key', '-out', certs / 'server.csr', '-subj', '/CN=localhost'])
        (certs / 'extensions.cnf').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n')
        run('certificate', ['openssl', 'x509', '-req', '-in', certs / 'server.csr', '-CA', certs / 'ca.pem', '-CAkey', certs / 'ca.key', '-CAcreateserial', '-out', certs / 'server.pem', '-days', '2', '-extfile', certs / 'extensions.cnf'])
        launch('php-server', php + ['-S', f'127.0.0.1:{php_port}', '-t', root / 'wordpress'])
        launch('provider', ['node', TESTS / 'provider.mjs'])
        deadline = time.monotonic() + 15
        for ready_port in [php_port, web_port, provider_port]:
            while True:
                if any(child.poll() is not None for child in processes):
                    raise RuntimeError('Fixture server exited before qualification.')
                try:
                    with socket.create_connection(('127.0.0.1', ready_port), timeout=0.5):
                        break
                except OSError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Fixture server startup timed out.')
                    time.sleep(0.1)
        run('security', php + [TESTS / 'security.php'])
        for test in ['connection', 'http', 'transport', 'gettext']:
            run(test, wp + ['eval-file', TESTS / (test + '.php')])
        run('curl-required', ['php', '-d', 'disable_functions=curl_setopt_array', '-d', 'error_reporting=22527', root / 'wp-cli.phar', '--path=' + str(root / 'wordpress'), 'eval-file', TESTS / 'curl-required.php'])
        run('qualification', ['node', TESTS / 'qualify.mjs'])
        print(f'PASS complete native qualification: WordPress {args.wordpress}; {run("php-version", ["php", "-r", "echo PHP_VERSION;"])}', flush=True)
    finally:
        cleanup(root, processes, handles, php, env, db_created, container, args.keep, sys.exception())


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Fail-closed validation for independent Frameleaf native release identities."""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

BLOCKED = ('app.alextran.immich', 'app.futo.immich', 'tech.futo.immich', 'group.app.immich')
KEYS = ('androidApplicationId', 'androidSigningSha256', 'iosBundleId', 'iosDevelopmentBundleId', 'iosTeamId', 'iosAppGroupId')
PLACEHOLDER_WORDS = {'example', 'local', 'test', 'testing', 'sample', 'placeholder', 'changeme'}
PLACEHOLDER_SEQUENCES = ('examplecompany', 'yourcompany')
PLACEHOLDER_TEAMS = {'ABCDE12345', 'XXXXXXXXXX', '1234567890', 'AAAAAAAAAA'}


def normalized_token(value):
    return re.sub(r'[^a-z0-9]', '', value.lower())


def is_placeholder(value):
    separated = re.sub(r'(?<=[a-z0-9])(?=[A-Z])', ' ', value)
    words = re.findall(r'[a-z0-9]+', separated.lower())
    compact = ''.join(words)
    return any(word in PLACEHOLDER_WORDS for word in words) or any(
        sequence in compact for sequence in PLACEHOLDER_SEQUENCES)


def reject_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f'Duplicate JSON key is prohibited: {key}')
        result[key] = value
    return result


def load_config(path):
    return json.loads(path.read_text(), object_pairs_hook=reject_duplicate_keys)


def require_identity(value, label):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+', value):
        raise ValueError(f'{label}: supply an identifier you control in an explicit identity configuration')
    if is_placeholder(value) or any(value == prefix or value.startswith(prefix + '.') for prefix in BLOCKED):
        raise ValueError(f'{label}: upstream, example and local preview identities cannot be released')
    if 'immich' in value.lower() or 'futo' in value.lower():
        raise ValueError(f'{label}: an independent Frameleaf identity is required')
    return value


def validate(config, platform='all'):
    if not isinstance(config, dict):
        raise ValueError('Frameleaf identity configuration must be a JSON object')
    if platform in ('all', 'android'):
        require_identity(config.get('androidApplicationId'), 'androidApplicationId')
        pin = config.get('androidSigningSha256', '')
        if not isinstance(pin, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', pin):
            raise ValueError('androidSigningSha256: pin the SHA-256 of your own DER signing certificate (64 hex digits)')
    if platform in ('all', 'ios'):
        for key in ('iosBundleId', 'iosDevelopmentBundleId', 'iosAppGroupId'):
            require_identity(config.get(key), key)
        if not config['iosAppGroupId'].startswith('group.'):
            raise ValueError('iosAppGroupId must start with group.')
        team = config.get('iosTeamId', '')
        if (not isinstance(team, str) or not re.fullmatch(r'[A-Z0-9]{10}', team)
                or team == '2W7AC6T8T5' or team in PLACEHOLDER_TEAMS):
            raise ValueError('iosTeamId: configure your own Apple Developer team; upstream team is prohibited')
    return config


def verify_ios_artifact(config, artifact, expected_bundle_id):
    validate(config, 'ios')
    bundle = Path(artifact) if artifact else None
    info_path = bundle / 'Info.plist' if bundle else None
    if not bundle or not bundle.is_dir() or not info_path.is_file():
        raise ValueError(f'{expected_bundle_id}: supply the actual signed application or extension bundle')
    with info_path.open('rb') as info_file:
        info = plistlib.load(info_file)
    if info.get('CFBundleIdentifier') != expected_bundle_id:
        raise ValueError(f'{bundle}: signed artifact bundle identifier does not match {expected_bundle_id}')
    subprocess.run(['/usr/bin/codesign', '--verify', '--strict', str(bundle)], check=True, capture_output=True)
    details = subprocess.run(['/usr/bin/codesign', '-d', '--verbose=4', str(bundle)],
        check=True, capture_output=True).stderr.decode(errors='replace')
    authorities = re.findall(r'^Authority=(.+)$', details, re.MULTILINE)
    teams = re.findall(r'^TeamIdentifier=(.+)$', details, re.MULTILINE)
    distribution = []
    for authority in authorities:
        match = re.fullmatch(r'Apple Distribution: (.+?) \(([A-Z0-9]{10})\)', authority)
        if match and not is_placeholder(match.group(1)):
            distribution.append(match)
    if not distribution:
        raise ValueError(f'{bundle}: artifact is not signed by a recognized Apple Distribution identity')
    if any(match.group(2) != config['iosTeamId'] for match in distribution):
        raise ValueError(f'{bundle}: Apple Distribution authority does not match the configured independent team')
    if teams != [config['iosTeamId']]:
        raise ValueError(f'{bundle}: signing TeamIdentifier does not match the configured independent team')
    entitlements_result = subprocess.run(['/usr/bin/codesign', '-d', '--entitlements', ':-', str(bundle)],
        check=True, capture_output=True)
    try:
        entitlements = plistlib.loads(entitlements_result.stdout)
    except (plistlib.InvalidFileException, TypeError, ValueError) as error:
        raise ValueError(f'{bundle}: signed entitlements could not be read') from error
    if entitlements.get('com.apple.developer.team-identifier') != config['iosTeamId']:
        raise ValueError(f'{bundle}: signed team entitlement does not match the configured team')
    if entitlements.get('application-identifier') != f'{config["iosTeamId"]}.{expected_bundle_id}':
        raise ValueError(f'{bundle}: signed application identifier entitlement is incorrect')
    groups = entitlements.get('com.apple.security.application-groups')
    if not isinstance(groups, list) or not groups:
        raise ValueError(f'{bundle}: signed application groups must be a nonempty list')
    for group in groups:
        require_identity(group, 'signed application group')
        if not group.startswith('group.'):
            raise ValueError(f'{bundle}: signed application group must start with group.')
    if config['iosAppGroupId'] not in groups:
        raise ValueError(f'{bundle}: signed application-group entitlement is missing')


def verify_ios_artifacts(config, app):
    runner = Path(app) if app else None
    if not runner or not runner.is_dir():
        raise ValueError('Supply the actual signed Runner application bundle')
    if runner.is_symlink():
        raise ValueError(f'{runner}: submitted Runner application bundle must not be a symlink')
    try:
        resolved_runner = runner.resolve(strict=True)
    except OSError as error:
        raise ValueError('Supply the actual signed Runner application bundle') from error
    extensions = []
    for name in ('ShareExtension.appex', 'WidgetExtension.appex'):
        plugins = runner / 'PlugIns'
        extension = plugins / name
        if plugins.is_symlink() or extension.is_symlink():
            raise ValueError(f'{extension}: embedded extension paths must not be symlinks')
        try:
            resolved_extension = extension.resolve(strict=True)
        except OSError as error:
            raise ValueError(f'{extension}: supply the embedded signed extension bundle') from error
        if resolved_runner not in resolved_extension.parents:
            raise ValueError(f'{extension}: embedded extension must resolve inside the submitted Runner bundle')
        extensions.append(extension)
    share_extension, widget_extension = extensions
    verify_ios_artifact(config, runner, config['iosBundleId'])
    verify_ios_artifact(config, share_extension, config['iosBundleId'] + '.ShareExtension')
    verify_ios_artifact(config, widget_extension, config['iosBundleId'] + '.Widget')


def verify_android_artifact(config, artifact):
    validate(config, 'android')
    package = Path(artifact) if artifact else None
    if not package or not package.is_file() or package.suffix.lower() not in ('.apk', '.aab'):
        raise ValueError('Supply the exact signed APK or AAB release artifact')
    if package.suffix.lower() == '.apk':
        application_id = subprocess.run(['apkanalyzer', 'manifest', 'application-id', str(package)], check=True,
            capture_output=True, text=True).stdout.strip()
        details = subprocess.run(['apksigner', 'verify', '--print-certs', str(package)], check=True,
            capture_output=True, text=True).stdout
        matches = re.findall(r'certificate SHA-256 digest:\s*([0-9a-f]{64})', details, re.I)
    else:
        application_id = subprocess.run(['bundletool', 'dump', 'manifest', f'--bundle={package}',
            '--xpath=/manifest/@package'], check=True, capture_output=True, text=True).stdout.strip()
        details = subprocess.run(['keytool', '-printcert', '-jarfile', str(package)], check=True,
            capture_output=True, text=True).stdout
        matches = re.findall(r'SHA256:\s*((?:[0-9A-F]{2}:){31}[0-9A-F]{2})', details, re.I)
    if application_id != config['androidApplicationId']:
        raise ValueError('The artifact application ID differs from Frameleaf configuration')
    if not matches:
        raise ValueError('The artifact signing certificate SHA-256 could not be derived')
    digests = {re.sub(r'[^0-9a-f]', '', match.lower()) for match in matches}
    if digests != {config['androidSigningSha256'].lower()}:
        raise ValueError('The artifact signing certificate does not match the configured SHA-256 pin')
    if re.search(r'Android Debug|FUTO|Immich', details, re.I):
        raise ValueError('Debug/upstream Android signing certificates are prohibited')


def validate_publishing(config, platform, env):
    validate(config, platform)
    fields = {'FRAMELEAF_ANDROID_APPLICATION_ID': 'androidApplicationId'} if platform == 'android' else {
        'FRAMELEAF_IOS_BUNDLE_ID': 'iosBundleId', 'FRAMELEAF_IOS_TEAM_ID': 'iosTeamId', 'FRAMELEAF_IOS_APP_GROUP_ID': 'iosAppGroupId'}
    for variable, key in fields.items():
        if env.get(variable) != config[key]:
            raise ValueError(f'{variable} must match the independently configured Frameleaf identity before contacting an app store')


def main(argv=None, env=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--platform', choices=('android', 'ios'))
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--effective-ios', action='store_true')
    mode.add_argument('--verify-android', action='store_true')
    mode.add_argument('--publishing-env', action='store_true')
    parser.add_argument('--android-artifact')
    parser.add_argument('--ios-app')
    args = parser.parse_args(argv)
    environment = os.environ if env is None else env
    try:
        release_mode = args.effective_ios or args.verify_android or args.publishing_env
        if release_mode and args.platform is None:
            raise ValueError('Release verification modes require an explicit --platform android or --platform ios')
        if args.effective_ios and args.platform != 'ios':
            raise ValueError('--effective-ios requires --platform ios')
        if args.verify_android and args.platform != 'android':
            raise ValueError('--verify-android requires --platform android')
        if args.android_artifact and not (
                args.platform == 'android' and (args.verify_android or args.publishing_env)):
            raise ValueError('Android artifact input requires an Android release verification mode')
        if args.ios_app and not (
                args.platform == 'ios' and (args.effective_ios or args.publishing_env)):
            raise ValueError('iOS artifact inputs require an iOS release verification mode')
        config = load_config(args.config)
        validate(config, args.platform or 'all')
        if args.effective_ios:
            verify_ios_artifacts(config, args.ios_app)
        elif args.verify_android:
            verify_android_artifact(config, args.android_artifact)
        elif args.publishing_env:
            validate_publishing(config, args.platform, environment)
            if args.platform == 'android':
                verify_android_artifact(config, args.android_artifact)
            else:
                verify_ios_artifacts(config, args.ios_app)
        print('Frameleaf native identity validation passed.')
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        # Never print subprocess output, passwords or the full config.
        message = error if not isinstance(error, subprocess.CalledProcessError) else 'signing certificate verification failed'
        print(f'Frameleaf release blocked: {message}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())

#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import plistlib
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('identity', Path(__file__).with_name('frameleaf-mobile-identity.py'))
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        # Fixture namespace only: not distributed or used as a build identity.
        self.config = dict(androidApplicationId='net.verifiedowner.frameleaf', androidSigningSha256='a' * 64,
            iosBundleId='net.verifiedowner.frameleaf', iosDevelopmentBundleId='net.verifiedowner.frameleafdev',
            iosTeamId='Q7R8S9T2U3', iosAppGroupId='group.net.verifiedowner.frameleaf')

    def write_config(self, directory, text=None):
        path = Path(directory) / 'identity.json'
        path.write_text(text if text is not None else json.dumps(self.config))
        return path

    def test_complete_independent_config(self):
        identity.validate(self.config)

    def test_upstream_placeholder_ids_and_team_are_rejected(self):
        values = ['app.alextran.immich', 'app.alextran.immich.debug', 'app.futo.immich',
            'tech.futo.immich.testflight', 'local.frameleaf.preview', 'com.example.frameleaf',
            'group.com.example.frameleaf', 'group.local.frameleaf', 'net.examplecompany.frameleaf',
            'net.example-company-llc.frameleaf', 'net.your-company.frameleaf', 'net.yourcompanyinc.frameleaf',
            'net.your.company.inc.frameleaf', 'net.the-example-company.frameleaf',
            'net.my-your-company.frameleaf']
        for value in values:
            with self.subTest(value=value), self.assertRaises(ValueError):
                identity.validate({**self.config, 'androidApplicationId': value})
        for team in ('2W7AC6T8T5', 'ABCDE12345', 'XXXXXXXXXX', '1234567890'):
            with self.subTest(team=team), self.assertRaises(ValueError):
                identity.validate({**self.config, 'iosTeamId': team})
        with self.assertRaises(ValueError):
            identity.validate({**self.config, 'iosAppGroupId': 'group.app.immich.share'})

    def test_missing_configuration_and_certificate_pin_fail_closed(self):
        for key in identity.KEYS:
            with self.subTest(key=key), self.assertRaises(ValueError):
                identity.validate({**self.config, key: ''})

    def test_duplicate_json_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            text = json.dumps(self.config).replace('{', '{"androidApplicationId":"duplicate.example",', 1)
            with self.assertRaises(ValueError):
                identity.load_config(self.write_config(directory, text))

    def ios_artifact(self, directory, name, bundle_id):
        bundle = Path(directory) / name
        bundle.mkdir(parents=True)
        with (bundle / 'Info.plist').open('wb') as info_file:
            plistlib.dump({'CFBundleIdentifier': bundle_id}, info_file)
        return bundle

    def codesign_results(self, bundle_id, authority='Apple Distribution: Northstar Media Cooperative (Q7R8S9T2U3)',
            team='Q7R8S9T2U3', entitlement_team='Q7R8S9T2U3', application_id=None, groups=None):
        details = f'Authority={authority}\nTeamIdentifier={team}\n'.encode()
        entitlements = plistlib.dumps({
            'com.apple.developer.team-identifier': entitlement_team,
            'application-identifier': application_id or f'{entitlement_team}.{bundle_id}',
            'com.apple.security.application-groups': groups or [self.config['iosAppGroupId']],
        })
        return [SimpleNamespace(stdout=b'', stderr=b''), SimpleNamespace(stdout=b'', stderr=details),
            SimpleNamespace(stdout=entitlements, stderr=b'')]

    def test_signed_ios_artifact_is_verified_from_bundle_and_signature(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.ios_artifact(directory, 'Frameleaf.app', self.config['iosBundleId'])
            with patch.object(identity.subprocess, 'run', side_effect=self.codesign_results(self.config['iosBundleId'])):
                identity.verify_ios_artifact(self.config, app, self.config['iosBundleId'])

    def test_ios_extensions_must_be_embedded_children_of_runner(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.ios_artifact(directory, 'Frameleaf.app', self.config['iosBundleId'])
            share = self.ios_artifact(app, 'PlugIns/ShareExtension.appex', self.config['iosBundleId'] + '.ShareExtension')
            self.ios_artifact(app, 'PlugIns/WidgetExtension.appex', self.config['iosBundleId'] + '.Widget')
            results = (self.codesign_results(self.config['iosBundleId']) +
                self.codesign_results(self.config['iosBundleId'] + '.ShareExtension') +
                self.codesign_results(self.config['iosBundleId'] + '.Widget'))
            with patch.object(identity.subprocess, 'run', side_effect=results):
                identity.verify_ios_artifacts(self.config, app)
            share.rename(Path(directory) / 'DecoyShareExtension.appex')
            with patch.object(identity.subprocess, 'run', side_effect=self.codesign_results(self.config['iosBundleId'])), self.assertRaises(ValueError):
                identity.verify_ios_artifacts(self.config, app)

    def test_ios_extensions_cannot_escape_runner_through_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.ios_artifact(root, 'Frameleaf.app', self.config['iosBundleId'])
            outside = self.ios_artifact(root, 'OutsideShareExtension.appex', self.config['iosBundleId'] + '.ShareExtension')
            plugins = app / 'PlugIns'
            plugins.mkdir()
            (plugins / 'ShareExtension.appex').symlink_to(outside, target_is_directory=True)
            self.ios_artifact(app, 'PlugIns/WidgetExtension.appex', self.config['iosBundleId'] + '.Widget')
            with patch.object(identity.subprocess, 'run') as run, self.assertRaises(ValueError):
                identity.verify_ios_artifacts(self.config, app)
            run.assert_not_called()

    def test_submitted_runner_root_cannot_be_a_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual = self.ios_artifact(root, 'ActualRunner.app', self.config['iosBundleId'])
            self.ios_artifact(actual, 'PlugIns/ShareExtension.appex', self.config['iosBundleId'] + '.ShareExtension')
            self.ios_artifact(actual, 'PlugIns/WidgetExtension.appex', self.config['iosBundleId'] + '.Widget')
            submitted = root / 'SubmittedRunner.app'
            submitted.symlink_to(actual, target_is_directory=True)
            with patch.object(identity.subprocess, 'run') as run, self.assertRaises(ValueError):
                identity.verify_ios_artifacts(self.config, submitted)
            run.assert_not_called()

    def test_ios_plugin_directory_cannot_escape_runner_through_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            app = self.ios_artifact(root, 'Frameleaf.app', self.config['iosBundleId'])
            outside = root / 'OutsidePlugIns'
            self.ios_artifact(outside, 'ShareExtension.appex', self.config['iosBundleId'] + '.ShareExtension')
            self.ios_artifact(outside, 'WidgetExtension.appex', self.config['iosBundleId'] + '.Widget')
            (app / 'PlugIns').symlink_to(outside, target_is_directory=True)
            with patch.object(identity.subprocess, 'run') as run, self.assertRaises(ValueError):
                identity.verify_ios_artifacts(self.config, app)
            run.assert_not_called()

    def test_ios_artifact_verification_rejects_non_distribution_or_mismatched_effective_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            app = self.ios_artifact(directory, 'Frameleaf.app', self.config['iosBundleId'])
            cases = [
                self.codesign_results(self.config['iosBundleId'], authority='Apple Development: Northstar Media Cooperative (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: Example (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: Example Company LLC (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: The Example Company LLC (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: Your-Company (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: YourCompany Inc (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: My Your Company Inc (Q7R8S9T2U3)'),
                self.codesign_results(self.config['iosBundleId'], authority='Apple Distribution: Northstar Media Cooperative (Z9Y8X7W6V5)'),
                self.codesign_results(self.config['iosBundleId'], team='Z9Y8X7W6V5'),
                self.codesign_results(self.config['iosBundleId'], entitlement_team='Z9Y8X7W6V5'),
                self.codesign_results(self.config['iosBundleId'], application_id='Q7R8S9T2U3.net.other.app'),
                self.codesign_results(self.config['iosBundleId'], groups=['group.net.other.app']),
                self.codesign_results(self.config['iosBundleId'], groups='group.net.verifiedowner.frameleaf'),
                self.codesign_results(self.config['iosBundleId'], groups=[self.config['iosAppGroupId'], 'group.your-company.frameleaf']),
            ]
            for results in cases:
                with self.subTest(results=results), patch.object(identity.subprocess, 'run', side_effect=results), self.assertRaises(ValueError):
                    identity.verify_ios_artifact(self.config, app, self.config['iosBundleId'])
            with self.assertRaises(ValueError):
                identity.verify_ios_artifact(self.config, Path(directory) / 'Missing.app', self.config['iosBundleId'])
            with (app / 'Info.plist').open('wb') as info_file:
                plistlib.dump({'CFBundleIdentifier': 'net.other.app'}, info_file)
            with self.assertRaises(ValueError):
                identity.verify_ios_artifact(self.config, app, self.config['iosBundleId'])

    def test_android_identity_and_certificate_are_derived_from_exact_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            apk = Path(directory) / 'frameleaf-release.apk'
            apk.touch()
            good = [SimpleNamespace(stdout=self.config['androidApplicationId']),
                SimpleNamespace(stdout=f'Signer #1 certificate SHA-256 digest: {self.config["androidSigningSha256"]}\nSigner #1 certificate DN: CN=Northstar Media Cooperative')]
            with patch.object(identity.subprocess, 'run', side_effect=good):
                identity.verify_android_artifact(self.config, apk)
            failures = [
                [SimpleNamespace(stdout='net.decoy.frameleaf'), good[1]],
                [good[0], SimpleNamespace(stdout='Signer #1 certificate SHA-256 digest: ' + 'b' * 64)],
                [good[0], SimpleNamespace(stdout=f'Signer #1 certificate SHA-256 digest: {self.config["androidSigningSha256"]}\nCN=Android Debug')],
            ]
            for results in failures:
                with self.subTest(results=results), patch.object(identity.subprocess, 'run', side_effect=results), self.assertRaises(ValueError):
                    identity.verify_android_artifact(self.config, apk)
            with self.assertRaises(ValueError):
                identity.verify_android_artifact(self.config, Path(directory) / 'decoy.apk')

    def test_aab_identity_and_certificate_are_derived_from_exact_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            bundle = Path(directory) / 'frameleaf-release.aab'
            bundle.touch()
            fingerprint = ':'.join(self.config['androidSigningSha256'][index:index + 2]
                for index in range(0, 64, 2)).upper()
            results = [SimpleNamespace(stdout=self.config['androidApplicationId']),
                SimpleNamespace(stdout=f'Owner: CN=Northstar Media Cooperative\nSHA256: {fingerprint}')]
            with patch.object(identity.subprocess, 'run', side_effect=results):
                identity.verify_android_artifact(self.config, bundle)

    def test_release_cli_requires_explicit_platform(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write_config(directory)
            for mode in ('--effective-ios', '--verify-android', '--publishing-env'):
                with self.subTest(mode=mode):
                    self.assertEqual(identity.main(['--config', str(config), mode], {}), 1)

    def test_unsigned_ios_release_modes_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write_config(directory)
            effective = dict(PRODUCT_BUNDLE_IDENTIFIER=self.config['iosBundleId'], DEVELOPMENT_TEAM=self.config['iosTeamId'],
                CUSTOM_GROUP_ID=self.config['iosAppGroupId'])
            self.assertEqual(identity.main(['--config', str(config), '--platform', 'ios', '--effective-ios'], effective), 1)
            publishing = {'FRAMELEAF_IOS_BUNDLE_ID': self.config['iosBundleId'], 'FRAMELEAF_IOS_TEAM_ID': self.config['iosTeamId'],
                'FRAMELEAF_IOS_APP_GROUP_ID': self.config['iosAppGroupId']}
            self.assertEqual(identity.main(['--config', str(config), '--platform', 'ios', '--publishing-env'], publishing), 1)

    def test_ios_release_modes_require_all_actual_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write_config(directory)
            app = self.ios_artifact(directory, 'Frameleaf.app', self.config['iosBundleId'])
            artifact_args = ['--ios-app', str(app)]
            with patch.object(identity, 'verify_ios_artifacts') as verify:
                self.assertEqual(identity.main(['--config', str(config), '--platform', 'ios', '--effective-ios', *artifact_args], {}), 0)
                verify.assert_called_once_with(self.config, str(app))
            publishing = {'FRAMELEAF_IOS_BUNDLE_ID': self.config['iosBundleId'], 'FRAMELEAF_IOS_TEAM_ID': self.config['iosTeamId'],
                'FRAMELEAF_IOS_APP_GROUP_ID': self.config['iosAppGroupId']}
            with patch.object(identity, 'verify_ios_artifacts') as verify:
                self.assertEqual(identity.main(['--config', str(config), '--platform', 'ios', '--publishing-env', *artifact_args], publishing), 0)
                verify.assert_called_once_with(self.config, str(app))

    def test_android_publishing_requires_effective_id_and_certificate(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write_config(directory)
            env = {'FRAMELEAF_ANDROID_APPLICATION_ID': self.config['androidApplicationId']}
            args = ['--config', str(config), '--platform', 'android', '--publishing-env']
            self.assertEqual(identity.main(args, env), 1)
            artifact = Path(directory) / 'release.apk'
            artifact.touch()
            with patch.object(identity, 'verify_android_artifact') as verify:
                complete = args + ['--android-artifact', str(artifact)]
                self.assertEqual(identity.main(complete, env), 0)
                verify.assert_called_once_with(self.config, str(artifact))


if __name__ == '__main__':
    unittest.main()

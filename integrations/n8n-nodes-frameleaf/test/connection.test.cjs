const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
test('connection restricts tokens to the selected profile and same Library resource', () => {
	const modulePath = '../dist/credentials/FrameleafOAuth2Api.credentials.js';
	assert.ok(
		fs.existsSync(require('node:path').join(__dirname, modulePath)),
		'Frameleaf credential is not implemented',
	);
	const { FrameleafOAuth2Api } = require(modulePath);
	const credential = new FrameleafOAuth2Api();
	const fields = Object.fromEntries(credential.properties.map((p) => [p.name, p]));
	assert.equal(fields.grantType.default, 'pkce');
	assert.equal(fields.clientSecret.required, false);
	assert.equal(fields.useDynamicClientRegistration.default, false);
	assert.equal(fields.useDynamicClientRegistration.type, 'hidden');
	assert.equal(fields.scope.type, 'hidden');
	assert.equal(fields.permissionProfile.default, 'library:read');
	assert.ok(fields.permissionProfile.options.every((x) => !x.value.includes('people:')));
	assert.equal(credential.restrictToSupportedNodes, true);
});
test('credential tests and native refresh recheck the approved Library before signing', async () => {
	const { FrameleafOAuth2Api } = require('../dist/credentials/FrameleafOAuth2Api.credentials.js');
	const credential = new FrameleafOAuth2Api();
	assert.equal(typeof credential.preAuthentication, 'function');
	const approved = {
		libraryUrl: 'https://library.example',
		permissionProfile: 'library:read',
		oauthTokenData: { scope: 'library:read', resource: 'https://library.example/api/connect' },
	};
	await credential.preAuthentication(approved);
	await assert.rejects(
		credential.preAuthentication({ ...approved, libraryUrl: 'https://other.example' }),
		/Reconnect/,
	);
});

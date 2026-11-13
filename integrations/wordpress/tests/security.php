<?php
/** Standalone protocol boundary tests. Run with php tests/security.php. */
function wp_parse_url($url) { return parse_url($url); }
$failures = 0;
function check(bool $value, string $label): void { global $failures; if (!$value) { ++$failures; echo "FAIL $label\n"; } else { echo "PASS $label\n"; } }
$source = __DIR__ . '/../frameleaf-connect/includes/class-security.php';
if (is_file($source)) { require $source; }
check(class_exists('Frameleaf_Connect_Security'), 'security boundary is implemented');
if (!class_exists('Frameleaf_Connect_Security')) { exit(1); }
function rejects(callable $fn): bool { try { $fn(); return false; } catch (RuntimeException $e) { return true; } }
check(Frameleaf_Connect_Security::origin('https://photos.example.test/') === 'https://photos.example.test', 'normalizes exact canonical origin');
foreach (['https://user:secret@example.test', 'https://example.test/path', 'https://example.test?next=x', 'https://example.test#x', 'file:///etc/passwd', 'https://example.test/%2e%2e', 'https://example.test\\@evil.test', "https://example.test\n"] as $bad) {
    check(rejects(fn() => Frameleaf_Connect_Security::origin($bad)), 'rejects ambiguous or non-origin address');
}
$vault = new Frameleaf_Connect_Security(str_repeat('a', 64));
$sealed = $vault->seal(['refresh_token' => 'synthetic-secret'], 'site:4');
check(!str_contains($sealed, 'synthetic-secret'), 'stored ciphertext excludes plaintext token');
check($vault->open($sealed, 'site:4')['refresh_token'] === 'synthetic-secret', 'authorized context decrypts');
check(rejects(fn() => $vault->open($sealed, 'site:5')), 'different user cannot decrypt');
check(rejects(fn() => (new Frameleaf_Connect_Security(str_repeat('b', 64)))->open($sealed, 'site:4')), 'salt rotation requires reconnection');
$bytes = base64_decode($sealed, true); $bytes[30] = chr(ord($bytes[30]) ^ 1);
check(rejects(fn() => $vault->open(base64_encode($bytes), 'site:4')), 'tampered ciphertext is rejected');
$verifier = Frameleaf_Connect_Security::random();
check(strlen($verifier) === 43 && preg_match('/^[A-Za-z0-9_-]+$/', $verifier) === 1, 'verifier is 256 random bits in OAuth-safe encoding');
check(Frameleaf_Connect_Security::challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk') === 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'PKCE matches RFC7636 S256 example');
exit($failures ? 1 : 0);

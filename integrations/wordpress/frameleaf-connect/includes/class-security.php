<?php
/** Credential encryption and protocol primitives. Independently implemented. */
class Frameleaf_Connect_Security {
    private string $key;

    public function __construct(string $material) {
        $this->key = hash_hkdf('sha256', $material, 32, 'frameleaf-connect-v1');
    }

    public static function origin(string $input): string {
        if ($input !== trim($input) || preg_match('/[\\\\\x00-\x20\x7f]/', $input)) {
            throw new RuntimeException('invalid_origin');
        }
        $parts = wp_parse_url($input);
        if (!$parts || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host']) ||
            isset($parts['user'], $parts['pass']) || isset($parts['user']) || isset($parts['pass']) ||
            isset($parts['query']) || isset($parts['fragment']) || !in_array($parts['path'] ?? '', ['', '/'], true) ||
            !preg_match('/^(?:\[[a-fA-F0-9:]+\]|[a-zA-Z0-9.-]+)$/D', $parts['host'])) {
            throw new RuntimeException('invalid_origin');
        }
        $port = $parts['port'] ?? 443;
        if ($port < 1 || $port > 65535) { throw new RuntimeException('invalid_origin'); }
        return 'https://' . strtolower($parts['host']) . ($port === 443 ? '' : ':' . $port);
    }

    public static function random(): string {
        return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
    }

    public static function challenge(string $verifier): string {
        return rtrim(strtr(base64_encode(hash('sha256', $verifier, true)), '+/', '-_'), '=');
    }

    public function seal(array $value, string $context): string {
        $iv = random_bytes(12);
        $json = json_encode($value, JSON_THROW_ON_ERROR);
        $ciphertext = openssl_encrypt($json, 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, $iv, $tag, $context, 16);
        if ($ciphertext === false) { throw new RuntimeException('credentials_unavailable'); }
        return base64_encode($iv . $tag . $ciphertext);
    }

    public function open(string $value, string $context): array {
        $raw = base64_decode($value, true);
        if ($raw === false || strlen($raw) < 30) { throw new RuntimeException('reconnect'); }
        $json = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $this->key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), $context);
        if ($json === false) { throw new RuntimeException('reconnect'); }
        try { $value = json_decode($json, true, 32, JSON_THROW_ON_ERROR); } catch (Throwable $e) { throw new RuntimeException('reconnect'); }
        if (!is_array($value)) { throw new RuntimeException('reconnect'); }
        return $value;
    }
}

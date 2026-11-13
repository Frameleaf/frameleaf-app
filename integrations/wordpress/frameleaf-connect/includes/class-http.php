<?php
/** Requests are pinned to an administrator-approved Library and its Connect contract. */
class Frameleaf_Connect_HTTP {
    public static function configuration(string $origin): array {
        $origin = Frameleaf_Connect_Security::origin($origin);
        $all = get_option('frameleaf_connect_origins', []);
        if (!is_array($all) || !isset($all[$origin]) || !is_array($all[$origin])) { throw new RuntimeException('origin_not_allowed'); }
        return $all[$origin];
    }

    public static function request(string $origin, string $path, array $args = [], int $limit = 2097152): array {
        $config = self::configuration($origin);
        if (!preg_match('~^/(?:\.well-known/oauth-authorization-server|api/oauth/apps/(?:register|token|revoke)|api/connect(?:/[a-zA-Z0-9_/-]+)?)(?:\?[^#\\\\\x00-\x20]*)?$~D', $path) || str_contains($path, '..') || str_contains($path, '//')) { throw new RuntimeException('invalid_path'); }
        $host = wp_parse_url($origin, PHP_URL_HOST);
        $port = wp_parse_url($origin, PHP_URL_PORT) ?: 443;
        if (!function_exists('curl_setopt_array') || !defined('CURLOPT_RESOLVE') ||
            !class_exists('WpOrg\\Requests\\Transport\\Curl') || !\WpOrg\Requests\Transport\Curl::test(['ssl' => true])) {
            throw new RuntimeException('curl_required');
        }
        $address = static::resolve_address($host, !empty($config['private']));
        $target = $origin . $path;
        $pin_applied = false;
        $force_transport = static function (&$url, &$headers, &$data, &$method, &$options) use ($target) {
            if ($url !== $target) { return; }
            $options['transport'] = 'WpOrg\\Requests\\Transport\\Curl';
            $options['proxy'] = false;
        };
        $pin_transport = static function ($handle, $request, $url) use ($host, $port, $address, $target, &$pin_applied) {
            if ($url !== $target) { return; }
            // phpcs:ignore WordPress.WP.AlternativeFunctions.curl_curl_setopt_array -- Configure the existing handle in WordPress's supported http_api_curl hook; wp_safe_remote_request owns I/O and TLS remains verified.
            if (!curl_setopt_array($handle, static::pin_options($host, $port, $address))) {
                throw new RuntimeException('connection_failed');
            }
            $pin_applied = true;
        };

        $allow_host = static function ($external, $requested_host, $url) use ($host, $origin, $config) {
            return !empty($config['private']) && $requested_host === $host && str_starts_with($url, $origin . '/') ? true : $external;
        };
        $allow_port = static function ($ports, $requested_host, $url) use ($host, $port, $origin) {
            if ($requested_host === $host && str_starts_with($url, $origin . '/')) { $ports[] = $port; }
            return array_unique($ports);
        };
        add_filter('http_request_host_is_external', $allow_host, 10, 3);
        add_filter('http_allowed_safe_ports', $allow_port, 10, 3);
        add_action('requests-requests.before_request', $force_transport, PHP_INT_MAX, 5);
        add_action('http_api_curl', $pin_transport, PHP_INT_MAX, 3);
        try {
            $response = wp_safe_remote_request($origin . $path, array_merge($args, [
                'timeout' => 30, 'redirection' => 0, 'sslverify' => true,
                'reject_unsafe_urls' => true, 'limit_response_size' => min(16777217, max(1, $limit)),
                'cookies' => [], 'user-agent' => 'Frameleaf-Connect-WordPress/0.1',
            ]));
        } finally {
            remove_action('requests-requests.before_request', $force_transport, PHP_INT_MAX);
            remove_action('http_api_curl', $pin_transport, PHP_INT_MAX);
            remove_filter('http_request_host_is_external', $allow_host, 10);
            remove_filter('http_allowed_safe_ports', $allow_port, 10);
        }
        if (!$pin_applied || is_wp_error($response)) { throw new RuntimeException('connection_failed'); }
        $status = wp_remote_retrieve_response_code($response);
        if ($status < 200 || $status >= 300) {
            if ($status === 429) { throw new RuntimeException('rate_limited'); }
            if ($status === 401 || $status === 403) { throw new RuntimeException('access_denied'); }
            throw new RuntimeException('connection_failed');
        }
        return $response;
    }

    protected static function lookup_addresses(string $host): array {
        $addresses = gethostbynamel($host);
        if ($addresses) { return $addresses; }
        $records = dns_get_record($host, DNS_AAAA);
        return $records ? array_values(array_filter(array_column($records, 'ipv6'), 'is_string')) : [];
    }

    protected static function resolve_address(string $host, bool $private): string {
        $literal = trim($host, '[]');
        $addresses = filter_var($literal, FILTER_VALIDATE_IP) ? [$literal] : static::lookup_addresses($literal);
        foreach ($addresses as $address) {
            if (!filter_var($address, FILTER_VALIDATE_IP)) { continue; }
            // Apply IPv4 network policy to mapped IPv6 addresses as well.
            $packed = inet_pton($address);
            $policy_address = strlen($packed) === 16 && substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff"
                ? inet_ntop(substr($packed, 12)) : $address;
            if ($private || filter_var($policy_address, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) { return $address; }
        }
        throw new RuntimeException('connection_failed');
    }

    protected static function pin_options(string $host, int $port, string $address): array {
        $ipv6 = str_contains($address, ':');
        return [
            // Keep the URL hostname unchanged for Host, SNI and certificate validation. IP literals already identify a fixed destination.
            CURLOPT_RESOLVE => filter_var(trim($host, '[]'), FILTER_VALIDATE_IP) ? [] : [$host . ':' . $port . ':' . ($ipv6 ? '[' . $address . ']' : $address)],
            CURLOPT_IPRESOLVE => $ipv6 ? CURL_IPRESOLVE_V6 : CURL_IPRESOLVE_V4,
            CURLOPT_PROXY => '', CURLOPT_NOPROXY => '*',
            CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        ];
    }

    public static function json(string $origin, string $path, array $args = []): array {
        $response = self::request($origin, $path, $args);
        try { $json = json_decode(wp_remote_retrieve_body($response), true, 32, JSON_THROW_ON_ERROR); }
        catch (Throwable $e) { throw new RuntimeException('invalid_response'); }
        if (!is_array($json)) { throw new RuntimeException('invalid_response'); }
        return $json;
    }

    public static function token(string $origin, array $body): array {
        return self::json($origin, '/api/oauth/apps/token', ['method' => 'POST', 'body' => $body]);
    }
}

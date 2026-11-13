<?php
/** Per-user PKCE authorization with durable, fail-closed refresh coordination. */
class Frameleaf_Connect_OAuth {
    private Frameleaf_Connect_Store $store;
    public function __construct() { $this->store = new Frameleaf_Connect_Store(); }

    public static function callback(): string {
        $url = admin_url('admin-post.php?action=frameleaf_connect_callback');
        if (wp_parse_url($url, PHP_URL_SCHEME) !== 'https') { throw new RuntimeException('https_callback_required'); }
        return $url;
    }

    private function user(): int {
        if (!current_user_can('upload_files')) { throw new RuntimeException('forbidden'); }
        return get_current_user_id();
    }

    private function save(array $row, string $state, array $data): array {
        $saved = $this->store->change($row, $state, $data);
        if (!$saved) { throw new RuntimeException('connection_busy'); }
        return $saved;
    }

    public function start(string $origin): string {
        $user = $this->user();
        $session = wp_get_session_token();
        if (!$session) { throw new RuntimeException('forbidden'); }
        $origin = Frameleaf_Connect_Security::origin($origin);
        $config = Frameleaf_Connect_HTTP::configuration($origin);
        $callback = self::callback();
        $row = $this->store->create($user);
        if ($row['state'] !== 'disconnected') { throw new RuntimeException('disconnect_first'); }
        $state = Frameleaf_Connect_Security::random();
        $data = ['origin' => $origin, 'state' => $state, 'session' => hash('sha256', $session),
            'nonce' => wp_create_nonce('frameleaf_connect_' . $state), 'verifier' => Frameleaf_Connect_Security::random(),
            'expires' => time() + 300, 'redirect_uri' => $callback, 'client_id' => $config['client_id'] ?? ''];
        $row = $this->save($row, 'starting', $data);
        try {
            $discovery = Frameleaf_Connect_HTTP::json($origin, '/.well-known/oauth-authorization-server');
            foreach (['authorization_endpoint' => '/api/oauth/apps/authorize', 'token_endpoint' => '/api/oauth/apps/token', 'revocation_endpoint' => '/api/oauth/apps/revoke'] as $key => $path) {
                if (($discovery[$key] ?? null) !== $origin . $path) { throw new RuntimeException('invalid_response'); }
            }
            if (($discovery['issuer'] ?? null) !== $origin || !in_array('S256', $discovery['code_challenge_methods_supported'] ?? [], true)) { throw new RuntimeException('invalid_response'); }
            if (!$data['client_id']) {
                if (($discovery['registration_endpoint'] ?? null) !== $origin . '/api/oauth/apps/register') { throw new RuntimeException('client_id_required'); }
                $client = Frameleaf_Connect_HTTP::json($origin, '/api/oauth/apps/register', ['method' => 'POST', 'headers' => ['Content-Type' => 'application/json'], 'body' => wp_json_encode([
                    'client_name' => 'Frameleaf for WordPress', 'redirect_uris' => [$callback],
                    'grant_types' => ['authorization_code', 'refresh_token'], 'response_types' => ['code'], 'token_endpoint_auth_method' => 'none',
                ])]);
                if (!is_string($client['client_id'] ?? null) || strlen($client['client_id']) > 200) { throw new RuntimeException('client_id_required'); }
                $data['client_id'] = $client['client_id'];
            }
            $this->save($row, 'pending', $data);
        } catch (Throwable $e) {
            $this->store->change($row, 'disconnected', []);
            throw $e;
        }
        return $origin . '/api/oauth/apps/authorize?' . http_build_query([
            'response_type' => 'code', 'client_id' => $data['client_id'], 'redirect_uri' => $callback,
            'scope' => 'library:read', 'resource' => $origin . '/api/connect', 'state' => $state,
            'code_challenge' => Frameleaf_Connect_Security::challenge($data['verifier']), 'code_challenge_method' => 'S256',
        ], '', '&', PHP_QUERY_RFC3986);
    }

    private function tokens(array $response): array {
        if (!is_string($response['access_token'] ?? null) || !$response['access_token'] || strlen($response['access_token']) > 16384 ||
            !is_string($response['refresh_token'] ?? null) || !$response['refresh_token'] || strlen($response['refresh_token']) > 16384 ||
            strtolower($response['token_type'] ?? '') !== 'bearer' || !is_numeric($response['expires_in'] ?? null) ||
            $response['expires_in'] <= 0 || $response['expires_in'] > 86400 || ($response['scope'] ?? '') !== 'library:read') { throw new RuntimeException('invalid_response'); }
        return ['access_token' => $response['access_token'], 'refresh_token' => $response['refresh_token'], 'expires_at' => time() + (int) $response['expires_in']];
    }

    public function complete(string $state, string $code, bool $denied = false): void {
        $row = $this->store->read($this->user());
        $data = $row['data'] ?? [];
        if (!$row || $row['state'] !== 'pending' || ($data['expires'] ?? 0) < time() ||
            !hash_equals($data['state'] ?? '', $state) || !$state ||
            !hash_equals($data['session'] ?? '', hash('sha256', wp_get_session_token())) ||
            !wp_verify_nonce($data['nonce'] ?? '', 'frameleaf_connect_' . $state)) { throw new RuntimeException('invalid_callback'); }
        if ($denied) { $this->save($row, 'disconnected', []); return; }
        if (!$code || strlen($code) > 2048) { throw new RuntimeException('invalid_callback'); }
        $row = $this->save($row, 'exchanging', $data);
        try {
            $tokens = $this->tokens(Frameleaf_Connect_HTTP::token($data['origin'], [
                'grant_type' => 'authorization_code', 'code' => $code, 'client_id' => $data['client_id'],
                'redirect_uri' => $data['redirect_uri'], 'code_verifier' => $data['verifier'], 'resource' => $data['origin'] . '/api/connect',
            ]));
            $data = ['origin' => $data['origin'], 'client_id' => $data['client_id'], 'tokens' => $tokens];
            // Persist new credentials before checking the resource, so failed consent validation remains revocable.
            $row = $this->save($row, 'checking', $data);
            $caps = Frameleaf_Connect_HTTP::json($data['origin'], '/api/connect/capabilities', ['headers' => ['Authorization' => 'Bearer ' . $tokens['access_token']]]);
            if (($caps['protocolVersion'] ?? null) !== 1 || !is_string($caps['server']['id'] ?? null) || !in_array('library:read', $caps['scopes'] ?? [], true)) { throw new RuntimeException('invalid_response'); }
            $data['server_id'] = $caps['server']['id'];
            $this->save($row, 'active', $data);
        } catch (Throwable $e) {
            $this->store->change($row, 'quarantined', $data);
            throw $e;
        }
    }

    public function access(): array {
        $user = $this->user();
        $deadline = microtime(true) + 5;
        do {
            $row = $this->store->read($user);
            if (!$row) { throw new RuntimeException('reconnect'); }
            if ($row['state'] === 'refreshing') {
                if (time() - $row['updated'] > 45) { $this->store->change($row, 'quarantined', $row['data']); throw new RuntimeException('reconnect'); }
                usleep(50000);
                continue;
            }
            if ($row['state'] !== 'active') { throw new RuntimeException('reconnect'); }
            $data = $row['data'];
            Frameleaf_Connect_HTTP::configuration($data['origin']);
            if ($data['tokens']['expires_at'] > time() + 30) { return $data; }
            $locked = $this->store->change($row, 'refreshing', $data);
            if (!$locked) { continue; }
            try {
                $tokens = $this->tokens(Frameleaf_Connect_HTTP::token($data['origin'], [
                    'grant_type' => 'refresh_token', 'refresh_token' => $data['tokens']['refresh_token'],
                    'client_id' => $data['client_id'], 'resource' => $data['origin'] . '/api/connect',
                ]));
                $data['tokens'] = $tokens;
                $this->save($locked, 'active', $data);
                return $data;
            } catch (Throwable $e) {
                // Preserve the last durable token; it is revocable, but may never be used for refresh again.
                $this->store->change($locked, 'quarantined', $locked['data']);
                throw new RuntimeException('reconnect');
            }
        } while (microtime(true) < $deadline);
        throw new RuntimeException('connection_busy');
    }

    public function status(): string {
        try { $row = $this->store->read($this->user()); return $row['state'] ?? 'disconnected'; }
        catch (Throwable $e) { return 'quarantined'; }
    }

    public function reset_after_key_change(): void {
        $user = $this->user();
        try { $this->store->read($user); }
        catch (RuntimeException $e) {
            if ($e->getMessage() !== 'reconnect') { throw $e; }
            $this->store->clear($user);
            return;
        }
        throw new RuntimeException('disconnect_first');
    }

    public function disconnect(): void {
        $row = $this->store->read($this->user());
        if (!$row) { return; }
        if (in_array($row['state'], ['starting', 'exchanging', 'checking', 'refreshing'], true) && time() - $row['updated'] <= 45) { throw new RuntimeException('connection_busy'); }
        $data = $row['data'];
        $row = $this->save($row, 'revoking', $data);
        if (!empty($data['tokens']['refresh_token'])) {
            Frameleaf_Connect_HTTP::request($data['origin'], '/api/oauth/apps/revoke', ['method' => 'POST', 'body' => [
                'token' => $data['tokens']['refresh_token'], 'token_type_hint' => 'refresh_token', 'client_id' => $data['client_id'],
            ]]);
        }
        $this->save($row, 'disconnected', []);
    }
}
